// saw thread: list and open threads from the terminal (spec 002 T113).
// Talks to the running daemon's local API, like the hooks and tools do.
import { daemonCall } from "../mcp/call.js";
import { resolveRepoRoot } from "../config.js";

const NO_DAEMON = "SAW is not running here. Start it with: saw up";

function fail(message: string): never {
  console.error(`saw: ${message}`);
  process.exit(1);
}

export async function runThreadList(): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) fail("this directory is not inside a git repository");
  const res = await daemonCall(root, "/api/threads");
  if (!res || res.status !== 200) fail(NO_DAEMON);
  const { threads } = res.json as {
    threads: Array<{
      id: string;
      title: string;
      type: string;
      state: string;
      claim_state: string;
      claimed_by?: string;
      message_count: number;
    }>;
  };
  if (threads.length === 0) {
    console.log("No threads yet. Open one: saw thread open --title <title>");
    return;
  }
  for (const t of threads) {
    const claim =
      t.type === "work_item" && t.claimed_by ? ` ${t.claim_state} by ${t.claimed_by}` : "";
    console.log(`${t.id}  [${t.type}] ${t.title} (${t.state}${claim}, ${t.message_count} msgs)`);
  }
}

export async function runThreadOpen(options: { title?: string; type?: string }): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) fail("this directory is not inside a git repository");
  if (!options.title) fail("--title is required");
  const type =
    options.type === "brainstorm" || options.type === "general" ? options.type : "work_item";
  const res = await daemonCall(root, "/api/thread/open", {
    method: "POST",
    body: { type, title: options.title }
  });
  if (!res) fail(NO_DAEMON);
  if (res.status !== 200) {
    const body = res.json as { error?: { message?: string } };
    fail(body.error?.message ?? "the thread was not opened");
  }
  const { thread } = res.json as { thread: { id: string; title: string; type: string } };
  console.log(`Opened thread ${thread.id} [${thread.type}] ${thread.title}`);
}

export async function runThreadMode(options: {
  id?: string;
  mode?: string;
}): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) fail("this directory is not inside a git repository");
  if (!options.id) fail("--id is required");
  if (options.mode !== "view" && options.mode !== "comment" && options.mode !== "edit") {
    fail("--mode must be view, comment, or edit");
  }
  const res = await daemonCall(root, "/api/thread/mode", {
    method: "POST",
    body: { thread_id: options.id, mode: options.mode }
  });
  if (!res || res.status !== 200) fail(NO_DAEMON);
  console.log(`Your mode on ${options.id} is now ${options.mode}. It restrains your own agent only.`);
}

export async function runThreadHandoff(options: {
  action?: string;
  id?: string;
  to?: string;
  ref?: string;
  handoff?: string;
}): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) fail("this directory is not inside a git repository");
  const action = options.action;
  if (action === "propose") {
    if (!options.id || !options.to || !options.ref) {
      fail("propose needs --id <thread>, --to <member>, --ref <branch>");
    }
    const res = await daemonCall(root, "/api/handoff", {
      method: "POST",
      body: {
        action: "propose",
        thread_id: options.id,
        to: options.to,
        tip_ref: { kind: "branch", value: options.ref }
      }
    });
    if (!res || res.status !== 200) fail(NO_DAEMON);
    console.log(`Handoff proposed to ${options.to}. The claim moves when they accept.`);
    return;
  }
  if (action === "accept" || action === "decline" || action === "withdraw") {
    if (!options.handoff) fail(`${action} needs --handoff <id>`);
    const res = await daemonCall(root, "/api/handoff", {
      method: "POST",
      body: { action, handoff_id: options.handoff }
    });
    if (!res || res.status !== 200) fail(NO_DAEMON);
    console.log(`Handoff ${options.handoff}: ${action} sent.`);
    return;
  }
  fail("action must be propose, accept, decline, or withdraw");
}

// ---- Sessions, auto mode, and the two approvals (T154, CLI half) ----
// Parity with the web app is required, not optional: FR-033 and FR-041 say
// one operation set on both surfaces. Every command here is self-directed —
// it writes this member's own consent, readiness, or approval and never
// another's.

interface SessionMemberView {
  member: string;
  ready_at: string | null;
  max_turns: number;
  turns_used: number;
}

interface SessionView {
  id: string;
  thread_id: string;
  task: string;
  state: string;
  members: SessionMemberView[];
  convergence: {
    proposed_by: string;
    summary: string;
    approved_by: string | null;
  } | null;
  ended_by: string | null;
}

/** Read the daemon's sessions, or fail with the one message that helps. */
async function sessionsOf(root: string): Promise<SessionView[]> {
  const res = await daemonCall(root, "/api/sessions");
  if (!res || res.status !== 200) fail(NO_DAEMON);
  return (res.json as { sessions: SessionView[] }).sessions;
}

/** POST one self-directed session control. */
async function sessionPost(
  root: string,
  path: string,
  body: Record<string, unknown>,
  refusal: string
): Promise<void> {
  const res = await daemonCall(root, path, { method: "POST", body });
  if (!res) fail(NO_DAEMON);
  if (res.status !== 200) {
    const answer = res.json as { error?: { message?: string } };
    fail(answer.error?.message ?? refusal);
  }
}

export async function runThreadAuto(options: {
  id?: string;
  on?: boolean;
  off?: boolean;
}): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) fail("this directory is not inside a git repository");
  if (!options.id) fail("--id is required");
  if (options.on === options.off) fail("give exactly one of --on or --off");
  const enabled = options.on === true;
  await sessionPost(
    root,
    "/api/auto-mode",
    { thread_id: options.id, enabled },
    "auto mode was not set"
  );
  console.log(
    enabled
      ? `Auto mode is ON for YOUR agent on ${options.id}. A session still needs both members ready, and your pause always outranks it.`
      : `Auto mode is OFF for YOUR agent on ${options.id}.`
  );
}

export async function runThreadReady(options: {
  id?: string;
  task?: string;
  maxTurns?: string;
}): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) fail("this directory is not inside a git repository");
  if (!options.id) fail("--id is required");
  const body: Record<string, unknown> = { thread_id: options.id };
  if (options.task) body.task = options.task;
  if (options.maxTurns !== undefined) {
    const n = Number(options.maxTurns);
    if (!Number.isInteger(n) || n < 1) fail("--max-turns must be a whole number of 1 or more");
    body.max_turns = n;
  }
  await sessionPost(root, "/api/session/ready", body, "readiness was not recorded");
  console.log(
    `You are ready on ${options.id}. The session starts when the other member is ready too; either of you can end it.`
  );
}

export async function runThreadSession(options: { id?: string }): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) fail("this directory is not inside a git repository");
  const sessions = await sessionsOf(root);
  const shown = options.id ? sessions.filter((s) => s.thread_id === options.id) : sessions;
  if (shown.length === 0) {
    console.log(
      options.id
        ? `No session on ${options.id}. Turn on auto mode and declare readiness to start one.`
        : "No sessions yet."
    );
    return;
  }
  for (const s of shown) {
    const who = s.ended_by === "budget" ? " (a turn budget ran out)" : s.ended_by ? ` by ${s.ended_by}` : "";
    console.log(`${s.id}  thread ${s.thread_id}  ${s.state}${who}`);
    if (s.task) console.log(`  task: ${s.task}`);
    for (const m of s.members) {
      const ready = m.ready_at ? `ready ${m.ready_at}` : "not ready";
      console.log(`  ${m.member}: ${m.turns_used}/${m.max_turns} turns, ${ready}`);
    }
    if (s.convergence) {
      const c = s.convergence;
      console.log(
        c.approved_by
          ? `  converged: approved by ${c.approved_by}`
          : `  proposed by ${c.proposed_by}, awaiting their own approval`
      );
      console.log(`  ${c.summary}`);
    }
  }
}

export async function runThreadEnd(options: { session?: string }): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) fail("this directory is not inside a git repository");
  if (!options.session) fail("--session is required");
  await sessionPost(
    root,
    "/api/session/end",
    { session_id: options.session },
    "the session was not ended"
  );
  console.log(`Session ${options.session} is ended, and the record says you ended it.`);
}

/**
 * The two approvals, both self-directed (FR-052, SC-029).
 *
 * An agent's decision is a proposal; concluding is its own member's act. No
 * member may approve another's, so this command can only ever approve work
 * proposed by this member's own agent — the daemon refuses anything else.
 */
export async function runThreadApprove(options: {
  session?: string;
  claim?: string;
}): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) fail("this directory is not inside a git repository");
  if (!options.session === !options.claim) {
    fail("give exactly one of --session (a convergence) or --claim (a thread's done proposal)");
  }
  if (options.session) {
    await sessionPost(
      root,
      "/api/session/approve",
      { session_id: options.session },
      "the convergence was not approved"
    );
    console.log(`Session ${options.session} is concluded on your approval.`);
    return;
  }
  await sessionPost(
    root,
    "/api/claim/approve",
    { thread_id: options.claim },
    "the claim was not approved"
  );
  console.log(`The work on ${options.claim} is done, concluded on your approval.`);
}
