// T055 — the durable local log spool.
// Maps to FR-015 ("a log entry for every run") and SC-003 ("100%").
//
// The relay here is real and it really goes away. The database is a file, so
// the relay comes back with the same workspace and the same token, on the
// same port. That is what a relay restart, a laptop that slept, or an
// offline stretch looks like to the daemon.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelay, type RelayServer } from "@saw/relay";
import { Daemon, registerWorkspace, writeMemberFiles } from "@saw/cli";
import { REPO_REMOTE, RecordingWakeAdapter, waitFor, waitForValue } from "./helpers.js";

/** A small cap, so the cap test does not need hundreds of runs. */
const TEST_CAPACITY = 4;

/** The relay needs a moment to come back. Reconnect backoff starts at 1 s. */
const RECONNECT_MS = 15_000;

let base: string;
let dbPath: string;
let root: string;
let port: number;
let relay: RelayServer;
let daemon: Daemon;

/** Take the relay away and wait until the daemon has noticed. */
async function relayDown(): Promise<void> {
  await relay.close();
  await waitFor(() => !daemon.connected, "the daemon to see the relay go down");
}

/** Bring the relay back on the same port and database. */
async function relayUp(): Promise<void> {
  relay = await startRelay(dbPath, port);
  await waitFor(() => daemon.connected, "the daemon to reconnect", RECONNECT_MS);
}

/** Run one agent turn: a prompt goes in, the Stop hook fires. */
async function oneRun(trigger: string) {
  daemon.inject("prompt-submit", trigger);
  return daemon.runStop({ tools_used: { Bash: 1 } });
}

/** Every run this member has logged, oldest end first. */
async function loggedTriggers(): Promise<string[]> {
  const result = await daemon.log({ member: "me", limit: 200 });
  return result.entries.map((e) => e.why_trigger);
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "saw-spool-itest-"));
  dbPath = join(base, "relay.db");
  root = join(base, "alice");

  relay = await startRelay(dbPath, 0);
  port = relay.port;

  const registered = await registerWorkspace(
    `http://127.0.0.1:${port}`,
    "spool-itest",
    REPO_REMOTE,
    "alice"
  );
  if (!registered.ok) throw new Error(`register failed: ${registered.error}`);

  writeMemberFiles(root, {
    workspaceId: registered.value.workspace_id,
    workspaceName: "spool-itest",
    relayUrl: `ws://127.0.0.1:${port}`,
    github: "alice",
    repoRemote: REPO_REMOTE,
    members: ["alice"],
    token: registered.value.token
  });

  daemon = new Daemon({
    root,
    clientName: "itest-spool",
    logSpoolCapacity: TEST_CAPACITY,
    wakeAdapter: new RecordingWakeAdapter()
  });
  if (!(await daemon.start(6000))) throw new Error("the daemon did not connect");
});

afterAll(async () => {
  daemon?.stop();
  await new Promise((r) => setTimeout(r, 100));
  await relay?.close();
  rmSync(base, { recursive: true, force: true });
});

describe("durable log spool (T055)", () => {
  it("logs a run that ended while the relay was down, with its own times", async () => {
    await relayDown();

    const marker = "Fix the parser while the relay is away";
    const before = new Date().toISOString();
    const outcome = await oneRun(marker);
    const after = new Date().toISOString();

    // The Stop path reports the failure but never loses the run.
    expect(outcome.ok).toBe(false);
    expect(outcome.spooled).toBe(true);
    expect(daemon.logSpool.size).toBe(1);

    await relayUp();

    const entry = await waitForValue(async () => {
      const result = await daemon.log({ member: "me", limit: 200 });
      return result.entries.find((e) => e.why_trigger === marker);
    }, "the spooled run to reach the work log", RECONNECT_MS);

    // This is the whole point: the entry reports when the run happened, not
    // when the spool flushed it. The flush is seconds later, after relayUp.
    expect(entry.started_at <= entry.ended_at).toBe(true);
    expect(entry.ended_at >= before).toBe(true);
    expect(entry.ended_at <= after).toBe(true);
    expect(entry.source).toBe("hook_stop");
    expect(daemon.logSpool.size).toBe(0);
  });

  it("several runs from one outage arrive in the order they happened", async () => {
    await relayDown();

    const marks = ["outage run one", "outage run two", "outage run three"];
    for (const mark of marks) {
      const outcome = await oneRun(mark);
      expect(outcome.spooled).toBe(true);
      // Space the runs, so the log order is the run order and not a tie.
      await new Promise((r) => setTimeout(r, 5));
    }
    // The spool holds them oldest first. The drain walks the head, so this
    // order is the send order.
    expect(daemon.logSpool.list().map((r) => r.entry.why_trigger)).toEqual(marks);

    await relayUp();
    await waitFor(() => daemon.logSpool.size === 0, "the spool to drain", RECONNECT_MS);

    const logged = await waitForValue(async () => {
      const all = await loggedTriggers();
      const found = all.filter((t) => marks.includes(t));
      return found.length === marks.length ? found : undefined;
    }, "all three spooled runs to reach the work log", RECONNECT_MS);
    expect(logged).toEqual(marks);
  });

  it("at the cap the oldest run goes and the newest runs survive", async () => {
    await relayDown();

    const droppedBefore = daemon.logSpool.dropped;
    const marks = [1, 2, 3, 4, 5, 6].map((n) => `capped run ${n}`);
    for (const mark of marks) {
      await oneRun(mark);
      await new Promise((r) => setTimeout(r, 5));
    }

    // Six runs, a cap of four. The two oldest are gone, as documented.
    expect(daemon.logSpool.size).toBe(TEST_CAPACITY);
    expect(daemon.logSpool.dropped - droppedBefore).toBe(2);
    expect(daemon.logSpool.list().map((r) => r.entry.why_trigger)).toEqual(
      marks.slice(2)
    );

    await relayUp();
    await waitFor(() => daemon.logSpool.size === 0, "the spool to drain", RECONNECT_MS);

    const logged = await waitForValue(async () => {
      const all = await loggedTriggers();
      const found = all.filter((t) => marks.includes(t));
      return found.length === TEST_CAPACITY ? found : undefined;
    }, "the four surviving runs to reach the work log", RECONNECT_MS);
    expect(logged).toEqual(marks.slice(2));
    expect(logged).not.toContain("capped run 1");
  });

  it("a spooled run is logged once, however many drains run", async () => {
    await relayDown();
    const marker = "exactly once run";
    expect((await oneRun(marker)).spooled).toBe(true);
    await relayUp();
    await waitFor(() => daemon.logSpool.size === 0, "the spool to drain", RECONNECT_MS);

    // Two more drains, at the same time, on an empty spool.
    const extra = await Promise.all([daemon.drainLogSpool(), daemon.drainLogSpool()]);
    expect(extra).toEqual([0, 0]);

    await waitForValue(async () => {
      const all = await loggedTriggers();
      return all.includes(marker) ? all : undefined;
    }, "the run to reach the work log", RECONNECT_MS);

    // No run from any test in this file appears twice.
    const all = await loggedTriggers();
    const counts = new Map<string, number>();
    for (const trigger of all) counts.set(trigger, (counts.get(trigger) ?? 0) + 1);
    const repeated = [...counts.entries()].filter(([, n]) => n > 1);
    expect(repeated).toEqual([]);
  });

  it("a daemon restart during the outage keeps the spooled run", async () => {
    await relayDown();
    const marker = "run held across a restart";
    expect((await oneRun(marker)).spooled).toBe(true);

    // The member closes the laptop. The spool is on disk, not in memory.
    daemon.stop();
    daemon = new Daemon({
      root,
      clientName: "itest-spool-restart",
      logSpoolCapacity: TEST_CAPACITY,
      wakeAdapter: new RecordingWakeAdapter()
    });
    expect(daemon.logSpool.size).toBe(1);

    relay = await startRelay(dbPath, port);
    expect(await daemon.start(6000)).toBe(true);
    await waitFor(() => daemon.logSpool.size === 0, "the spool to drain", RECONNECT_MS);

    const entry = await waitForValue(async () => {
      const result = await daemon.log({ member: "me", limit: 200 });
      return result.entries.find((e) => e.why_trigger === marker);
    }, "the run from before the restart to reach the work log", RECONNECT_MS);
    expect(entry.member).toBe("alice");
  });
});
