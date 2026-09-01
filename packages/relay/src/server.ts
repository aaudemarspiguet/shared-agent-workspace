// The relay server.
// One HTTP server for registration/invites/join. One WebSocket endpoint at /ws.
// A connection must authenticate with `hello` before any other frame.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  MAX_FRAME_BYTES,
  NEEDS_UPGRADE_CODE,
  needsUpgradeMessage,
  PROTOCOL_VERSION } from "@saw/shared";
import { branchPrefixRefusal, parseClientFrame } from "./boundary.js";
import { threadStateRefusal } from "./thread-state.js";
import { joinWorkspace, mintWorkspaceInvite, registerWorkspace } from "./join.js";
import { handleLogAppend, handleLogQuery } from "./log.js";
import { handlePost } from "./messages.js";
import { handlePauseSet } from "./pause.js";
import { ConnectionRegistry } from "./presence.js";
import { RelayStore, type MemberRow } from "./store.js";
import { handleSync, sendThreadSnapshot } from "./sync.js";
import { canTransitionHandoff } from "@saw/shared";

export interface RelayServer {
  store: RelayStore;
  registry: ConnectionRegistry;
  httpServer: Server;
  port: number;
  close(): Promise<void>;
}

function send(ws: WebSocket, frame: object): void {
  ws.send(JSON.stringify(frame));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length > 64_000) throw new Error("body too large");
  return JSON.parse(text || "{}");
}

function respond(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Start a relay. Pass ":memory:" as dbPath for tests. Port 0 picks a free port. */
export function startRelay(dbPath: string, port: number): Promise<RelayServer> {
  const store = new RelayStore(dbPath);
  const registry = new ConnectionRegistry();

  const httpServer = createServer((req, res) => {
    void handleHttp(store, req, res).catch(() =>
      respond(res, 400, { error: "request is not valid" })
    );
  });

  // Sockets keep emitting 'close' while the server shuts down. Presence
  // broadcasts read the store, so they must stop before the store does.
  let closing = false;

  // Without maxPayload the `ws` default of 100 MiB applies to one frame.
  // A frame that size is not a message and not a ref (Principle II, T070).
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: MAX_FRAME_BYTES
  });
  wss.on("connection", (ws) => {
    let member: MemberRow | undefined;

    ws.on("pong", () => registry.markAlive(ws));

    ws.on("message", (data) => {
      const parsed = parseClientFrame(String(data));

      if (!parsed.ok) {
        // Boundary rejection. Log it when we know who sent it.
        if (member) {
          store.appendRejectionLog(member.workspace_id, member.id, parsed.reason, parsed.summary);
          send(ws, { kind: "post_rejected", reason: parsed.reason, summary: parsed.summary });
        } else {
          send(ws, { kind: "error", code: "bad_frame", message: parsed.summary });
        }
        return;
      }
      const frame = parsed.frame;

      if (frame.kind === "hello") {
        // FR-035: a hello without a version is the pre-versioning v0
        // protocol and is served through the migration window. A version
        // above ours means the CLIENT is newer; refuse with the plain
        // instruction so its member learns what to do.
        if (frame.protocol !== undefined && frame.protocol > PROTOCOL_VERSION) {
          send(ws, {
            kind: "error",
            code: NEEDS_UPGRADE_CODE,
            message: needsUpgradeMessage("relay")
          });
          ws.close();
          return;
        }
        const authed = store.authMember(frame.workspace_id, frame.token);
        if (!authed) {
          send(ws, { kind: "error", code: "auth_failed", message: "token is not valid" });
          ws.close();
          return;
        }
        member = authed;
        registry.add(ws, member.workspace_id, member.id, member.github_username);
        send(ws, {
          kind: "hello_ok",
          member: member.github_username,
          latest_seq: store.latestSeq(member.workspace_id),
          paused: store.isPaused(member.id),
          protocol: PROTOCOL_VERSION
        });
        registry.broadcastPresence(store, member.workspace_id, member.github_username, true);
        // The broadcast above only reaches members who are already here. This
        // is the other direction: what the joiner missed by arriving late.
        registry.sendPresenceSnapshot(store, member.workspace_id, member.id);
        // Thread state travels the same way: everything the joiner missed.
        sendThreadSnapshot(store, registry, member);
        return;
      }

      if (!member) {
        send(ws, { kind: "error", code: "not_authed", message: "send hello first" });
        return;
      }
      registry.touch(member.id);
      // Closures below (transact callbacks, finds) defeat the narrowing on
      // the mutable `member`; `me` is the same row, immutably.
      const me = member;

      switch (frame.kind) {
        case "post":
          if (parsed.post) {
            const outcome = handlePost(store, registry, member, parsed.post, frame.sender_kind);
            if (!outcome.ok) {
              send(ws, { kind: "error", code: outcome.code, message: outcome.message });
            }
          }
          break;
        case "thread_open": {
          if (!parsed.open) break;
          const thread = store.createThread(
            member.workspace_id,
            parsed.open,
            member.github_username
          );
          // The opener gets the thread first (their tool call is waiting on
          // the id); everyone else learns of it in the same broadcast shape.
          registry.sendTo(member.id, { kind: "thread", thread });
          registry.broadcast(
            store,
            member.workspace_id,
            { kind: "thread", thread },
            { excludeMemberId: member.id }
          );
          break;
        }
        case "thread_state_set": {
          // FR-010 (CHK005, T138). The claim holder concludes, the owner
          // archives, anybody reopens, and archived stays read-only. This
          // path used to allow every member every move, which meant either
          // member could close the other's work.
          const thread = store.threadById(frame.thread_id);
          if (!thread || thread.workspace_id !== member.workspace_id) {
            send(ws, { kind: "error", code: "invalid_input", message: "thread not found" });
            break;
          }
          const stateRefusal = threadStateRefusal(
            thread,
            store.threadClaim(thread.id),
            member,
            frame.state
          );
          if (stateRefusal) {
            store.appendRejectionLog(
              member.workspace_id,
              member.id,
              "no_authority",
              stateRefusal
            );
            send(ws, { kind: "error", code: "no_authority", message: stateRefusal });
            break;
          }
          store.setThreadState(frame.thread_id, frame.state);
          const updated = store.threadById(frame.thread_id);
          if (updated) registry.broadcast(store, member.workspace_id, { kind: "thread", thread: updated });
          break;
        }
        case "thread_ref_bind": {
          if (!parsed.ref) break;
          const thread = store.threadById(frame.thread_id);
          if (!thread || thread.workspace_id !== member.workspace_id) {
            send(ws, { kind: "error", code: "invalid_input", message: "thread not found" });
            break;
          }
          // FR-040 (T143). This path had no prefix check at all: the rule
          // was written inline in the post path only, so binding through
          // the frame bound anything, including the other member's branch
          // namespace, and did it silently. Same rule, same refusal, told
          // to the sender rather than dropped.
          const refusal = branchPrefixRefusal(parsed.ref, member.github_username);
          if (refusal) {
            store.appendRejectionLog(member.workspace_id, member.id, "invalid_ref", refusal);
            send(ws, { kind: "error", code: "invalid_input", message: refusal });
            break;
          }
          const binding = store.bindThreadRef(
            frame.thread_id,
            member.workspace_id,
            parsed.ref,
            member.github_username
          );
          registry.broadcast(store, member.workspace_id, { kind: "thread_ref", binding });
          break;
        }
        case "thread_mode_set": {
          // T116/T117 and SC-016. The payload carries NO member field: the
          // write applies to the authenticated sender and nobody else. Even
          // a hand-crafted frame with a member field injected is stripped
          // by the schema before this line runs.
          if (!parsed.modeSet) break;
          const thread = store.threadById(parsed.modeSet.thread_id);
          if (!thread || thread.workspace_id !== me.workspace_id) {
            send(ws, { kind: "error", code: "invalid_input", message: "thread not found" });
            break;
          }
          if (parsed.modeSet.mode === undefined) {
            // A read: answer with the sender's current row (or the default).
            const current = store
              .threadModes(me.workspace_id)
              .find(
                (m) =>
                  m.thread_id === parsed.modeSet?.thread_id &&
                  m.member === me.github_username
              );
            send(ws, {
              kind: "thread_mode",
              mode:
                current ?? {
                  thread_id: parsed.modeSet.thread_id,
                  member: me.github_username,
                  mode: "comment",
                  set_at: new Date(0).toISOString()
                }
            });
            break;
          }
          store.setThreadMode(
            parsed.modeSet.thread_id,
            me.github_username,
            parsed.modeSet.mode
          );
          const row = store
            .threadModes(me.workspace_id)
            .find(
              (m) =>
                m.thread_id === parsed.modeSet?.thread_id && m.member === me.github_username
            );
          if (row) registry.broadcast(store, me.workspace_id, { kind: "thread_mode", mode: row });
          break;
        }
        case "handoff_propose": {
          // T132/FR-044. The proposer must hold the thread's claim. A
          // directed handoff is owner-only delegation: the claim moves on
          // the record at once; the recipient's human still decides what
          // their agent does (surfaced client-side, T128).
          if (!parsed.propose) break;
          const thread = store.threadById(parsed.propose.thread_id);
          if (!thread || thread.workspace_id !== me.workspace_id) {
            send(ws, { kind: "error", code: "invalid_input", message: "thread not found" });
            break;
          }
          const recipient = store
            .members(me.workspace_id)
            .find((m) => m.github_username === parsed.propose?.to);
          if (!recipient) {
            send(ws, { kind: "error", code: "invalid_input", message: "recipient is not a member" });
            break;
          }
          const claim = store.threadClaim(thread.id);
          if (claim?.claimed_by !== me.github_username || claim.state !== "claimed") {
            send(ws, {
              kind: "error",
              code: "invalid_input",
              message: "only the member holding the claim can hand it off"
            });
            break;
          }
          if (parsed.propose.directed && me.role !== "creator") {
            store.appendRejectionLog(
              me.workspace_id,
              me.id,
              "no_authority",
              "directed handoff from a member without authority"
            );
            send(ws, {
              kind: "error",
              code: "no_authority",
              message: "a directed handoff needs authority (the owner role in v1). Propose it instead."
            });
            break;
          }
          const handoff = store.transact(() => {
            const made = store.createHandoff(
              thread.id,
              me.github_username,
              parsed.propose?.to ?? "",
              parsed.propose?.tip_ref ?? { kind: "branch", value: "unknown" },
              parsed.propose?.directed ?? false
            );
            if (made.state === "accepted") {
              // Directed: the claim moves now, visibly.
              store.setThreadClaim(thread.id, "claimed", made.to_member);
            }
            return made;
          });
          registry.sendTo(me.id, { kind: "handoff", handoff });
          registry.broadcast(
            store,
            me.workspace_id,
            { kind: "handoff", handoff },
            { excludeMemberId: me.id }
          );
          break;
        }
        case "handoff_resolve": {
          // The transition table is the law (shared canTransitionHandoff):
          // only the recipient accepts or declines; only the sender
          // withdraws; terminal states stay terminal. Acceptance needs the
          // recipient's own mode at edit (T134, FR-044).
          const row = store.handoffById(frame.handoff_id);
          const threadOfRow = row ? store.threadById(row.thread_id) : undefined;
          if (!row || threadOfRow?.workspace_id !== me.workspace_id) {
            send(ws, { kind: "error", code: "invalid_input", message: "handoff not found" });
            break;
          }
          const actor =
            me.github_username === row.to_member
              ? ("to_member" as const)
              : me.github_username === row.from_member
                ? ("from_member" as const)
                : undefined;
          if (!actor || !canTransitionHandoff(row.state, frame.to_state, actor)) {
            send(ws, {
              kind: "error",
              code: "invalid_input",
              message: `this handoff cannot move from ${row.state} to ${frame.to_state} by you`
            });
            break;
          }
          if (frame.to_state === "accepted") {
            const myMode = store
              .threadModes(me.workspace_id)
              .find((m) => m.thread_id === row.thread_id && m.member === me.github_username);
            if (!myMode || myMode.mode !== "edit") {
              send(ws, {
                kind: "error",
                code: "mode_denied",
                message:
                  "accepting a handoff needs your mode on the thread at edit. Raise your own mode first, or decline."
              });
              break;
            }
          }
          const updated = store.transact(() => {
            const after = store.setHandoffState(row.id, frame.to_state);
            if (frame.to_state === "accepted") {
              store.setThreadClaim(row.thread_id, "claimed", row.to_member);
            }
            return after;
          });
          if (updated) {
            registry.broadcast(store, me.workspace_id, { kind: "handoff", handoff: updated });
          }
          break;
        }
        case "sync":
          handleSync(store, registry, member, frame.since_seq);
          break;
        case "log_append":
          // parsed.entry, not frame.entry: the boundary scrubbed that one.
          if (parsed.entry) {
            handleLogAppend(store, registry, member, parsed.entry, parsed.redactions);
          }
          break;
        case "log_query":
          handleLogQuery(store, registry, member, frame.query, frame.peer_activity);
          break;
        case "pause_set":
          handlePauseSet(store, registry, member, frame.paused);
          break;
        case "ping":
          send(ws, { kind: "pong" });
          break;
      }
    });

    ws.on("close", () => {
      const conn = registry.remove(ws);
      if (conn && !closing) {
        registry.broadcastPresence(store, conn.workspaceId, conn.username, false);
      }
    });

    // Without this, an 'error' event on a socket is unhandled and takes the
    // whole relay down with it. One member's broken connection must not stop
    // the other member from working.
    ws.on("error", (err: Error & { code?: string }) => {
      // An over-cap frame arrives here rather than at parseClientFrame, since
      // `ws` refuses it before we ever see the bytes. It is still a boundary
      // rejection and still has to appear in the log (SC-005).
      if (err.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" && member && !closing) {
        store.appendRejectionLog(
          member.workspace_id,
          member.id,
          "payload_too_large",
          `frame over ${MAX_FRAME_BYTES} bytes`
        );
      }
      ws.terminate();
    });
  });

  // Same reasoning for the server itself: report it, but stay up.
  wss.on("error", (err) => {
    console.error(`SAW relay: WebSocket server error: ${err.message}`);
  });

  const pingTimer = setInterval(() => registry.pingAll(), 30_000);
  pingTimer.unref();

  return new Promise((resolve) => {
    httpServer.listen(port, "0.0.0.0", () => {
      const addr = httpServer.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        store,
        registry,
        httpServer,
        port: boundPort,
        close: () =>
          new Promise<void>((done) => {
            closing = true;
            clearInterval(pingTimer);
            registry.closeAll();
            wss.close();
            httpServer.close(() => {
              store.close();
              done();
            });
          })
      });
    });
  });
}

async function handleHttp(
  store: RelayStore,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://relay");

  if (req.method === "GET" && url.pathname === "/") {
    respond(res, 200, {
      service: "saw-relay",
      version: "0.1.0",
      description:
        "SAW relay. It carries only JSON messages and git refs between two members.",
      endpoints: {
        health: "GET /health",
        register: "POST /workspaces",
        invite: "POST /workspaces/:id/invites (Bearer token, creator only)",
        join: "POST /join",
        websocket: "GET /ws (see contracts/relay-protocol.md)"
      },
      note: "The human web interface is served by `saw up` on the member machine, not by the relay."
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    respond(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/workspaces") {
    const body = (await readJsonBody(req)) as {
      name?: string;
      repo_remote?: string;
      creator?: string;
    };
    if (!body.name || !body.repo_remote || !body.creator) {
      respond(res, 400, { error: "name, repo_remote, and creator are required" });
      return;
    }
    respond(res, 201, registerWorkspace(store, body.name, body.repo_remote, body.creator));
    return;
  }

  const inviteMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/invites$/);
  if (req.method === "POST" && inviteMatch && inviteMatch[1]) {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const body = (await readJsonBody(req)) as { invitee?: string; expires_in_hours?: number };
    if (!body.invitee) {
      respond(res, 400, { error: "invitee is required" });
      return;
    }
    const minted = mintWorkspaceInvite(
      store,
      inviteMatch[1],
      token,
      body.invitee,
      body.expires_in_hours ?? 72
    );
    respond(res, minted.ok ? 201 : 403, minted);
    return;
  }

  if (req.method === "POST" && url.pathname === "/join") {
    const body = (await readJsonBody(req)) as { invite?: string; github?: string };
    if (!body.invite || !body.github) {
      respond(res, 400, { error: "invite and github are required" });
      return;
    }
    const joined = joinWorkspace(store, body.invite, body.github);
    respond(res, joined.ok ? 200 : 403, joined);
    return;
  }

  respond(res, 404, { error: "not found" });
}
