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
import { parseClientFrame } from "./boundary.js";
import { joinWorkspace, mintWorkspaceInvite, registerWorkspace } from "./join.js";
import { handleLogAppend, handleLogQuery } from "./log.js";
import { handlePost } from "./messages.js";
import { handlePauseSet } from "./pause.js";
import { ConnectionRegistry } from "./presence.js";
import { RelayStore, type MemberRow } from "./store.js";
import { handleSync, sendThreadSnapshot } from "./sync.js";

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
          // CHK005 (who may move a thread between states) is an open task
          // (T138). Until it is decided, any member of the project scope may,
          // and the change is attributable: the new state broadcasts to all.
          const thread = store.threadById(frame.thread_id);
          if (!thread || thread.workspace_id !== member.workspace_id) {
            send(ws, { kind: "error", code: "invalid_input", message: "thread not found" });
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
          const binding = store.bindThreadRef(
            frame.thread_id,
            member.workspace_id,
            parsed.ref,
            member.github_username
          );
          registry.broadcast(store, member.workspace_id, { kind: "thread_ref", binding });
          break;
        }
        case "thread_mode_set":
        case "handoff_propose":
        case "handoff_resolve":
          // Phase 4 (US8) implements these. Answering plainly beats a silent
          // drop: the caller's tool run must not hang on a missing reply.
          send(ws, {
            kind: "error",
            code: "not_implemented",
            message: "modes and handoff lifecycle arrive with the next relay release (spec 002 phase 4)"
          });
          break;
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
