// T078 — what the real surfaces read, and what the work log records.
//
// Three faults that only a real run showed. Every earlier test drove the
// HTTP API with small rooms, so none of them could see any of these:
//   - a bounded room read answered with the OLDEST window, so a workspace
//     past the limit hid every later message (FR-007);
//   - a run carried the FIRST work item the member ever claimed, so the
//     feature attribution in the work log went stale for the session;
//   - files_changed counted the untracked files SAW writes itself, so a
//     run that changed nothing reported several files changed.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitWhat } from "@saw/cli";
import type { StoredLogEntry } from "@saw/shared";
import {
  apiGet,
  startWeb,
  twoMemberWorkspace,
  waitFor,
  type TestWorkspace
} from "./helpers.js";

interface MessagePage {
  messages: { seq: number; body: string; work_item?: string }[];
  latest_seq: number;
}

/** More messages than any limit the tests below ask for. */
const NOTE_COUNT = 12;

describe("room reads and run log correctness (T078)", () => {
  let ws: TestWorkspace;
  let web: Awaited<ReturnType<typeof startWeb>>;

  /** Post one message as alice. Fail loudly when the relay refuses it. */
  async function post(
    type: "intent" | "status" | "decision",
    body: string,
    workItem?: string
  ): Promise<void> {
    const outcome = await ws.alice.daemon.post(
      { type, body, refs: [], work_item: workItem },
      "agent"
    );
    if (!outcome.ok) throw new Error(`post failed: ${outcome.message}`);
  }

  /** Read one page from bob's local API. This is the room_read path. */
  async function read(query: string): Promise<MessagePage> {
    const res = await apiGet(web, `/api/messages?${query}`);
    expect(res.status).toBe(200);
    return res.json as MessagePage;
  }

  /** Every message bob holds, oldest first. */
  function bobSeqs(): number[] {
    return ws.bob.daemon.messages(0, 500).messages.map((m) => m.seq);
  }

  beforeAll(async () => {
    ws = await twoMemberWorkspace();
    web = await startWeb(ws.bob);

    for (let i = 1; i <= NOTE_COUNT; i += 1) await post("status", `note ${i}`);
    await waitFor(
      () => ws.bob.daemon.messages(0, 500).messages.length === NOTE_COUNT,
      `bob to receive all ${NOTE_COUNT} messages`
    );
  });

  afterAll(async () => {
    await web.close();
    await ws.close();
  });

  // ---- The bounded read ----

  it("answers a bounded read with the newest messages, not the oldest", async () => {
    const page = await read("since_seq=0&limit=5");
    expect(page.messages.map((m) => m.body)).toEqual([
      "note 8",
      "note 9",
      "note 10",
      "note 11",
      "note 12"
    ]);
    // Newest last, and the page reaches the end of the room.
    expect(page.messages.map((m) => m.seq)).toEqual(bobSeqs().slice(-5));
    expect(page.latest_seq).toBe(ws.bob.daemon.state.latestSeq());
    expect(page.messages[page.messages.length - 1].seq).toBe(page.latest_seq);
  });

  // The web room snapshot reads `daemon.messages(0, 500)`. A limit smaller
  // than the room proves the same window the web page gets past 500 messages.
  it("shows the end of the room in the web snapshot", () => {
    const snapshot = ws.bob.daemon.messages(0, 4);
    expect(snapshot.messages.map((m) => m.body)).toEqual([
      "note 9",
      "note 10",
      "note 11",
      "note 12"
    ]);
    expect(snapshot.latest_seq).toBe(snapshot.messages[3].seq);
  });

  it("narrows to one work item before the limit, and still ends at the newest", async () => {
    await post("intent", "I take the cache fix.", "cache-fix");
    for (const step of ["cache step 1", "cache step 2", "cache step 3"]) {
      await post("status", step, "cache-fix");
    }
    await waitFor(
      () =>
        ws.bob.daemon.messages(0, 500).messages.some((m) => m.body === "cache step 3"),
      "bob to receive the tagged messages"
    );

    const page = await read("since_seq=0&limit=2&work_item=cache-fix");
    expect(page.messages.every((m) => m.work_item === "cache-fix")).toBe(true);
    // Two messages OF THAT ITEM, and the two newest of them.
    expect(page.messages.map((m) => m.body)).toEqual(["cache step 2", "cache step 3"]);
    // A filter is a view. It never changes the caller's sense of position.
    expect(page.latest_seq).toBe(ws.bob.daemon.state.latestSeq());
  });

  // ---- The read cursor ----

  it("keeps the delivery window contiguous while the bounded read takes the tail", () => {
    const state = ws.bob.daemon.state;
    const seqs = bobSeqs();
    expect(seqs.length).toBeGreaterThan(3);
    // The window injection reads starts at the cursor: it must never skip.
    expect(state.messages(0, 3).map((m) => m.seq)).toEqual(seqs.slice(0, 3));
    // The window a reader gets ends at the newest message.
    expect(state.recentMessages(0, 3).map((m) => m.seq)).toEqual(seqs.slice(-3));
  });

  it("still injects the oldest unread and moves the cursor in seq order", async () => {
    const unread = bobSeqs().filter((seq) => seq > ws.bob.daemon.cursor.value);
    expect(unread.length).toBeGreaterThan(3);

    const first = ws.bob.daemon.inject("prompt-submit");
    expect(first.messages.map((m) => m.seq)).toEqual(unread);
    expect(first.ack_seq).toBe(unread[unread.length - 1]);

    ws.bob.daemon.ackInjection(first.ack_seq, first.ack_notices);
    expect(ws.bob.daemon.cursor.value).toBe(first.ack_seq);
    expect(ws.bob.daemon.inject("prompt-submit").messages).toEqual([]);

    await post("status", "after the cursor moved");
    await waitFor(
      () =>
        ws.bob.daemon
          .messages(0, 500)
          .messages.some((m) => m.body === "after the cursor moved"),
      "bob to receive the message after the cursor moved"
    );

    const next = ws.bob.daemon.inject("prompt-submit");
    expect(next.messages.map((m) => m.body)).toEqual(["after the cursor moved"]);
    expect(next.ack_seq).toBeGreaterThan(first.ack_seq);
    ws.bob.daemon.ackInjection(next.ack_seq, next.ack_notices);
    expect(ws.bob.daemon.cursor.value).toBe(next.ack_seq);
  });

  // ---- The work item tag on a run ----

  it("tags a run with the most recent claim, not the first one", async () => {
    const alice = ws.alice.daemon;
    // "cache-fix" above is already claimed and still open. Two more claims
    // follow it, so the mirror holds three claims for this member at once.
    await post("intent", "I take alpha.", "alpha");
    expect(alice.state.myActiveWorkItem()).toBe("alpha");
    await post("intent", "I take beta.", "beta");
    expect(alice.state.myActiveWorkItem()).toBe("beta");

    const stopped = await alice.runStop({ tools_used: { BetaRun: 1 } });
    expect(stopped.ok).toBe(true);
    expect(await loggedRun(alice, "BetaRun")).toMatchObject({ work_item: "beta" });
  });

  it("falls back to the claim that is still open when the newest one closes", async () => {
    const alice = ws.alice.daemon;
    await post("decision", "Beta is done.", "beta");
    // "alpha" is the newest claim that is still open. "cache-fix" is older.
    expect(alice.state.myActiveWorkItem()).toBe("alpha");

    const stopped = await alice.runStop({ tools_used: { AlphaRun: 1 } });
    expect(stopped.ok).toBe(true);
    expect(await loggedRun(alice, "AlphaRun")).toMatchObject({ work_item: "alpha" });
  });

  // ---- files_changed ----

  it("logs 0 files changed for a run that left only the SAW footprint", async () => {
    const repo = mkdtempSync(join(tmpdir(), "saw-clean-repo-"));
    try {
      initRepo(repo);
      writeSawFootprint(repo);

      const what = gitWhat(repo);
      expect(what.files_changed).toBe(0);
      expect(what.head).toMatch(/^[0-9a-f]{40}$/);

      const stopped = await ws.bob.daemon.runStop({
        tools_used: { CleanRun: 1 },
        ...what
      });
      expect(stopped.ok).toBe(true);
      const entry = await loggedRun(ws.bob.daemon, "CleanRun");
      expect(entry.what.files_changed).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("counts the work a run really did, next to the SAW footprint", async () => {
    const repo = mkdtempSync(join(tmpdir(), "saw-dirty-repo-"));
    try {
      initRepo(repo);
      writeSawFootprint(repo);
      writeFileSync(join(repo, "tracked.txt"), "changed\n");
      writeFileSync(join(repo, "feature.ts"), "export const a = 1;\n");

      const what = gitWhat(repo);
      expect(what.files_changed).toBe(2);

      const stopped = await ws.bob.daemon.runStop({
        tools_used: { DirtyRun: 1 },
        ...what
      });
      expect(stopped.ok).toBe(true);
      const entry = await loggedRun(ws.bob.daemon, "DirtyRun");
      expect(entry.what.files_changed).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/** Read back the one run of this member that used `toolName`. */
async function loggedRun(
  daemon: TestWorkspace["alice"]["daemon"],
  toolName: string
): Promise<StoredLogEntry> {
  const result = await daemon.log({ member: "me", limit: 50 });
  expect(result.ok).toBe(true);
  const matches = result.entries.filter((e) => e.what.tools_used[toolName] === 1);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A git repo with one commit that holds one file. */
function initRepo(cwd: string): void {
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "tracked.txt"), "one\n");
  git(cwd, ["add", "tracked.txt"]);
  git(cwd, ["commit", "-m", "init"]);
}

/** The files `saw up` leaves in a workspace. None of them are the run's work. */
function writeSawFootprint(cwd: string): void {
  mkdirSync(join(cwd, ".saw"), { recursive: true });
  writeFileSync(join(cwd, ".saw", "config.json"), "{}\n");
  writeFileSync(join(cwd, ".saw", "credential"), "token\n");
  writeFileSync(join(cwd, ".saw", "AGENT.md"), "rules\n");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(cwd, ".gitignore"), ".saw/credential\n");
}
