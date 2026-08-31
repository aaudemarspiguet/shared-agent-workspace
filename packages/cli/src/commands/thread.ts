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
