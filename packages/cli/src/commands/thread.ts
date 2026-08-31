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
