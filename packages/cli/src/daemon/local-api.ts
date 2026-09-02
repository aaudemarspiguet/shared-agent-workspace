// Localhost HTTP API for hooks, MCP tools, and the web page (T020).
// Every route is JSON. The server that mounts this handler binds 127.0.0.1
// only. Nothing here talks to the peer's machine.
//
// Every route needs the run token, reads as well as changes (T057, FR-021).
// The check runs before the body is read, so an unauthenticated request never
// reaches the parser.
import type { IncomingMessage, ServerResponse } from "node:http";
import { validatePost, type LogQuery } from "@saw/shared";
import type { Daemon } from "./daemon.js";
import { checkApiRequest, type LocalAuth } from "./local-auth.js";
import { readIntegrationHealth } from "../hooks/health.js";
import { isTunnelAddress } from "../tunnel.js";

const MAX_BODY_BYTES = 256_000;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    // No answer here may be stored or read as another type. There are no
    // CORS headers on purpose: a foreign page must not read any of this.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(body));
}

/**
 * A session id is an opaque key from the coding tool (T106). Cap it so a
 * hostile or broken caller cannot grow the state file without limit.
 */
function sessionKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  if (id.length === 0 || id.length > 128) return undefined;
  return id;
}

function errorBody(code: string, message: string): object {
  return { error: { code, message } };
}

/**
 * Handle one request when the path starts with /api/.
 * Return true when this handler owned the request.
 */
export async function handleApiRequest(
  daemon: Daemon,
  req: IncomingMessage,
  res: ServerResponse,
  auth: LocalAuth
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (!path.startsWith("/api/")) return false;

  // Prove the caller first. A refused request is never parsed and never
  // touches the daemon.
  const failure = checkApiRequest(req, auth);
  if (failure) {
    respond(res, failure.status, errorBody(failure.code, failure.message));
    return true;
  }

  try {
    if (req.method === "GET" && path === "/api/health") {
      // The developer console reads this (FR-047, T147): connection and
      // tunnel state, and the agent integration for this repository. Every
      // field is something the daemon already knows or can read from disk —
      // a console that guesses is worse than no console.
      respond(res, 200, {
        ok: true,
        member: daemon.config.github_username,
        relay_connected: daemon.connected,
        paused: daemon.pauseMirror.ownPaused,
        // Runs held for the next reconnect. Zero on a healthy daemon (T055).
        log_spool_pending: daemon.logSpool.size,
        workspace: daemon.config.workspace_name,
        repo_root: daemon.root,
        repo_remote: daemon.config.repo_remote,
        branch_prefix: daemon.config.branch_prefix,
        // How this member reaches the relay. A ticket is the zero-config
        // tunnel; anything else is a direct address.
        relay_transport: isTunnelAddress(daemon.config.relay_url) ? "tunnel" : "direct",
        integration: readIntegrationHealth(daemon.root)
      });
      return true;
    }

    if (req.method === "GET" && path === "/api/status") {
      respond(res, 200, daemon.status());
      return true;
    }

    if (req.method === "GET" && path === "/api/messages") {
      // No since_seq means "from the last injected cursor" (contract: room_read).
      const sinceParam = url.searchParams.get("since_seq");
      const sinceSeq = sinceParam === null ? daemon.cursor.value : Number(sinceParam);
      const limit = Number(url.searchParams.get("limit") ?? 200);
      // work_item narrows the read to one item. The filter runs before the
      // limit, so the caller gets `limit` messages of that item rather than
      // whatever matched inside the first page. latest_seq stays the room's
      // true latest and the read cursor does not move: a filter is a view,
      // so the caller keeps its position (T066).
      const workItem = url.searchParams.get("work_item") ?? undefined;
      // thread_id narrows to one thread the same way (spec 002 T111).
      const threadId = url.searchParams.get("thread_id") ?? undefined;
      respond(res, 200, daemon.messages(sinceSeq, limit, workItem, threadId));
      return true;
    }

    if (req.method === "POST" && path === "/api/post") {
      const body = (await readJsonBody(req)) as {
        sender_kind?: "agent" | "human" | "companion";
      } & Record<string, unknown>;
      // The companion identity survives this hop or nowhere (FR-053). The
      // MCP layer reads SAW_COMPANION from the spawned run's environment,
      // sets sender_kind, and POSTs here — and this line used to coerce
      // "companion" to "agent", erasing the identity one hop after it was
      // established. Every relay-side companion rule was unreachable on
      // the real path as a result (#205 review).
      const senderKind =
        body.sender_kind === "human" || body.sender_kind === "companion"
          ? body.sender_kind
          : "agent";
      const post: Record<string, unknown> = { ...body };
      delete post.sender_kind;
      if (!daemon.connected) {
        respond(res, 503, errorBody("not_connected", "the relay is not connected"));
        return true;
      }
      // Pause silences every automated voice, the companion included: only
      // the member's own human words pass while paused. Decided at the #205
      // review and stated here, rather than falling out of an === "agent"
      // comparison that a third kind would quietly slip past.
      if (senderKind !== "human" && daemon.pauseMirror.ownPaused) {
        respond(
          res,
          423,
          errorBody("paused", "your workspace member state is paused")
        );
        return true;
      }
      // Validate at the boundary here too, so a bad post fails fast with the
      // true reason. The relay validates again and logs rejections (SC-005).
      const check = validatePost(post);
      if (!check.ok) {
        const outcome = await daemon.post(post as never, senderKind);
        const message = outcome.ok
          ? `${check.reason}: ${check.summary}`
          : outcome.message;
        respond(res, 422, errorBody("rejected", message));
        return true;
      }
      const outcome = await daemon.post(check.post, senderKind);
      if (!outcome.ok) {
        const status = outcome.code === "rejected" ? 422 : 503;
        respond(res, status, errorBody(outcome.code, outcome.message));
        return true;
      }
      // Carry the unbound refs through: a post whose branch did not bind must
      // say so to whoever sent it, not only to the rejection log.
      respond(res, 200, {
        seq: outcome.seq,
        sent_at: outcome.sent_at,
        ...(outcome.unbound_refs?.length ? { unbound_refs: outcome.unbound_refs } : {})
      });
      return true;
    }

    if (req.method === "POST" && path === "/api/inject") {
      const body = (await readJsonBody(req)) as {
        source?: string;
        prompt?: string;
        session_id?: string;
      };
      const source = body.source === "session-start" ? "session-start" : "prompt-submit";
      respond(res, 200, daemon.inject(source, body.prompt, sessionKey(body.session_id)));
      return true;
    }

    // The second half of the two-phase injection. The cursor moves only when
    // the hook reports that it delivered the messages.
    if (req.method === "POST" && path === "/api/inject/ack") {
      const body = (await readJsonBody(req)) as {
        seq?: number;
        notices?: number;
        session_id?: string;
      };
      const sessionId = sessionKey(body.session_id);
      if (typeof body.seq !== "number" || !Number.isFinite(body.seq)) {
        respond(res, 400, errorBody("invalid_input", "seq must be a number"));
        return true;
      }
      // Only a seq this daemon issued may move the cursor. An unchecked value
      // writes past every message that will ever arrive. The cursor is
      // persisted, so the member stays silent after a restart. When the cache
      // holds no messages, the bound is the cursor itself, because inject()
      // answers with the cursor value in that case.
      const highest = Math.max(daemon.state.latestSeq(), daemon.cursor.valueFor(sessionId));
      if (body.seq > highest) {
        respond(
          res,
          400,
          errorBody("invalid_input", `seq ${body.seq} is above the highest known seq ${highest}`)
        );
        return true;
      }
      const notices = body.notices ?? 0;
      if (!Number.isInteger(notices) || notices < 0) {
        respond(
          res,
          400,
          errorBody("invalid_input", "notices must be a whole number, zero or more")
        );
        return true;
      }
      daemon.ackInjection(body.seq, notices, sessionId);
      respond(res, 200, { ok: true, cursor: daemon.cursor.valueFor(sessionId) });
      return true;
    }

    if (req.method === "GET" && path === "/api/threads") {
      respond(res, 200, { threads: daemon.threads() });
      return true;
    }

    if (req.method === "POST" && path === "/api/thread/open") {
      const body = (await readJsonBody(req)) as { type?: string; title?: string };
      const type =
        body.type === "work_item" || body.type === "brainstorm" || body.type === "general"
          ? body.type
          : undefined;
      if (!type || typeof body.title !== "string" || body.title.length === 0) {
        respond(res, 400, errorBody("invalid_input", "type and title are required"));
        return true;
      }
      const outcome = await daemon.threadOpen({ type, title: body.title });
      if (!outcome.ok) {
        respond(res, 503, errorBody("not_connected", outcome.message));
        return true;
      }
      respond(res, 200, { thread: outcome.thread });
      return true;
    }

    if (req.method === "GET" && path === "/api/mode") {
      const threadId = url.searchParams.get("thread_id") ?? "";
      const view = daemon.state.threadById(threadId);
      if (!view) {
        respond(res, 404, errorBody("invalid_input", "thread not found"));
        return true;
      }
      respond(res, 200, { thread_id: threadId, mode: view.my_mode });
      return true;
    }

    if (req.method === "POST" && path === "/api/thread/mode") {
      const body = (await readJsonBody(req)) as { thread_id?: string; mode?: string };
      const mode =
        body.mode === "view" || body.mode === "comment" || body.mode === "edit"
          ? body.mode
          : undefined;
      if (!body.thread_id || !mode) {
        respond(res, 400, errorBody("invalid_input", "thread_id and mode are required"));
        return true;
      }
      daemon.setThreadMode(body.thread_id, mode);
      respond(res, 200, { ok: true, thread_id: body.thread_id, mode });
      return true;
    }

    if (req.method === "GET" && path === "/api/sessions") {
      respond(res, 200, { sessions: daemon.sessions() });
      return true;
    }

    if (req.method === "POST" && path === "/api/auto-mode") {
      const body = (await readJsonBody(req)) as { thread_id?: string; enabled?: boolean };
      if (!body.thread_id || typeof body.enabled !== "boolean") {
        respond(res, 400, errorBody("invalid_input", "thread_id and enabled are required"));
        return true;
      }
      daemon.autoModeSet(body.thread_id, body.enabled);
      respond(res, 200, { ok: true });
      return true;
    }

    if (req.method === "POST" && path === "/api/session/ready") {
      const body = (await readJsonBody(req)) as {
        thread_id?: string;
        task?: string;
        max_turns?: number;
      };
      if (!body.thread_id) {
        respond(res, 400, errorBody("invalid_input", "thread_id is required"));
        return true;
      }
      daemon.sessionReady(body.thread_id, body.task, body.max_turns);
      respond(res, 200, { ok: true });
      return true;
    }

    if (req.method === "POST" && path === "/api/session/end") {
      const body = (await readJsonBody(req)) as { session_id?: string };
      if (!body.session_id) {
        respond(res, 400, errorBody("invalid_input", "session_id is required"));
        return true;
      }
      daemon.sessionEnd(body.session_id);
      respond(res, 200, { ok: true });
      return true;
    }

    if (req.method === "POST" && path === "/api/session/propose") {
      const body = (await readJsonBody(req)) as {
        session_id?: string;
        summary?: string;
        refs?: { kind: "branch" | "commit"; value: string }[];
      };
      if (!body.session_id || !body.summary) {
        respond(res, 400, errorBody("invalid_input", "session_id and summary are required"));
        return true;
      }
      daemon.convergePropose(body.session_id, body.summary, body.refs ?? []);
      respond(res, 200, { ok: true });
      return true;
    }

    if (req.method === "POST" && path === "/api/session/approve") {
      const body = (await readJsonBody(req)) as { session_id?: string };
      if (!body.session_id) {
        respond(res, 400, errorBody("invalid_input", "session_id is required"));
        return true;
      }
      daemon.convergeApprove(body.session_id);
      respond(res, 200, { ok: true });
      return true;
    }

    if (req.method === "POST" && path === "/api/claim/approve") {
      const body = (await readJsonBody(req)) as { thread_id?: string };
      if (!body.thread_id) {
        respond(res, 400, errorBody("invalid_input", "thread_id is required"));
        return true;
      }
      daemon.claimApprove(body.thread_id);
      respond(res, 200, { ok: true });
      return true;
    }

    if (req.method === "GET" && path === "/api/handoffs") {
      respond(res, 200, { handoffs: daemon.handoffs() });
      return true;
    }

    if (req.method === "POST" && path === "/api/handoff") {
      const body = (await readJsonBody(req)) as {
        action?: string;
        thread_id?: string;
        to?: string;
        tip_ref?: { kind?: string; value?: string };
        directed?: boolean;
        handoff_id?: string;
      };
      if (body.action === "propose") {
        if (!body.thread_id || !body.to || !body.tip_ref?.kind || !body.tip_ref.value) {
          respond(res, 400, errorBody("invalid_input", "thread_id, to, and tip_ref are required"));
          return true;
        }
        daemon.handoffPropose({
          thread_id: body.thread_id,
          to: body.to,
          tip_ref: {
            kind: body.tip_ref.kind === "commit" ? "commit" : "branch",
            value: body.tip_ref.value
          },
          directed: body.directed === true
        });
        respond(res, 200, { ok: true });
        return true;
      }
      if (body.action === "accept" || body.action === "decline" || body.action === "withdraw") {
        if (!body.handoff_id) {
          respond(res, 400, errorBody("invalid_input", "handoff_id is required"));
          return true;
        }
        const toState =
          body.action === "accept" ? "accepted" : body.action === "decline" ? "declined" : "withdrawn";
        daemon.handoffResolve(body.handoff_id, toState);
        respond(res, 200, { ok: true });
        return true;
      }
      respond(res, 400, errorBody("invalid_input", "action must be propose, accept, decline, or withdraw"));
      return true;
    }

    if (req.method === "POST" && path === "/api/mode-denial") {
      // T120: every mode denial is recorded. The daemon logs it as a system
      // run entry, spooled like any other when the relay is away.
      const body = (await readJsonBody(req)) as { thread_id?: string; action?: string; mode?: string };
      const at = new Date().toISOString();
      void daemon.runStopSystem({
        started_at: at,
        ended_at: at,
        what: { tools_used: {} },
        why_trigger: `mode denial: ${body.action ?? "action"} needs more than ${body.mode ?? "the current mode"} on thread ${body.thread_id ?? "unknown"}`,
        ...(body.thread_id ? { thread_id: body.thread_id } : {})
      });
      respond(res, 200, { ok: true });
      return true;
    }

    if (req.method === "GET" && path === "/api/pause") {
      respond(res, 200, { paused: daemon.pauseMirror.ownPaused });
      return true;
    }

    if (req.method === "POST" && path === "/api/pause") {
      const body = (await readJsonBody(req)) as { paused?: boolean };
      if (typeof body.paused !== "boolean") {
        respond(res, 400, errorBody("invalid_input", "paused must be true or false"));
        return true;
      }
      const applied = await daemon.setPause(body.paused);
      respond(res, applied ? 200 : 503, {
        ok: applied,
        paused: daemon.pauseMirror.ownPaused
      });
      return true;
    }

    if (req.method === "POST" && path === "/api/run/stop") {
      const body = (await readJsonBody(req)) as { what?: unknown };
      const outcome = await daemon.runStop((body.what ?? { tools_used: {} }) as never);
      // 200: the relay holds the entry. 202: the local spool holds it and the
      // next reconnect sends it, so the caller must not retry. 503: neither
      // took it, which only happens when the spool itself cannot hold it.
      const status = outcome.ok ? 200 : outcome.spooled ? 202 : 503;
      respond(res, status, outcome);
      return true;
    }

    if (req.method === "GET" && path === "/api/log") {
      const query: Partial<LogQuery> = {
        member: (url.searchParams.get("member") ?? "any") as LogQuery["member"],
        work_item: url.searchParams.get("work_item") ?? undefined,
        since: url.searchParams.get("since") ?? undefined,
        limit: url.searchParams.get("limit")
          ? Number(url.searchParams.get("limit"))
          : undefined
      };
      const result = await daemon.log(query);
      if (!result.ok) {
        respond(res, 503, errorBody("not_connected", result.error ?? "log query failed"));
        return true;
      }
      respond(res, 200, { entries: result.entries });
      return true;
    }

    if (req.method === "GET" && path === "/api/peer-activity") {
      const since = url.searchParams.get("since");
      if (!since) {
        respond(res, 400, errorBody("invalid_input", "since is required"));
        return true;
      }
      const limit = url.searchParams.get("limit")
        ? Number(url.searchParams.get("limit"))
        : 50;
      const result = await daemon.peerActivity(since, limit);
      if (!result.ok || !result.activity) {
        respond(
          res,
          503,
          errorBody("not_connected", result.error ?? "peer activity query failed")
        );
        return true;
      }
      respond(res, 200, result.activity);
      return true;
    }

    respond(res, 404, errorBody("invalid_input", "unknown API route"));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    respond(res, 400, errorBody("invalid_input", message));
    return true;
  }
}
