// T151/T152 through two real daemons with a fake wake adapter: the wake
// reaches the coding tool exactly when the law says, pause wins, the cap
// serializes runs, and the T155 mirror shows proposed-done until approval.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Daemon, joinWorkspace, mintInvite, registerWorkspace, writeMemberFiles } from "@saw/cli";
import type { WakeAdapter, WakeRun } from "@saw/cli";
import { startRelay, type RelayServer } from "@saw/relay";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "./helpers.js";

class FakeAdapter implements WakeAdapter {
  name = "fake";
  runs: WakeRun[] = [];
  private release: (() => void) | null = null;
  holdNext = false;

  supportsWake(): boolean {
    return true;
  }

  startRun(run: WakeRun): Promise<{ ok: boolean }> {
    this.runs.push(run);
    if (!this.holdNext) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      this.release = () => resolve({ ok: true });
    });
  }

  releaseHeld(): void {
    this.release?.();
    this.release = null;
  }
}

let relay: RelayServer;
let base: string;
let roots: string[] = [];
let daemons: Daemon[] = [];

async function member(
  name: string,
  workspaceId: string,
  token: string,
  members: string[],
  adapter?: WakeAdapter
): Promise<Daemon> {
  const root = mkdtempSync(join(tmpdir(), `saw-wake-${name}-`));
  roots.push(root);
  writeMemberFiles(root, {
    workspaceId,
    workspaceName: "waketest",
    relayUrl: base.replace("http", "ws"),
    github: name,
    repoRemote: "git@example.com:acme/app.git",
    members,
    token
  });
  const daemon = new Daemon({ root, clientName: `wake-${name}`, wakeAdapter: adapter });
  const connected = await daemon.start(6000);
  if (!connected) throw new Error(`${name} did not connect`);
  daemons.push(daemon);
  return daemon;
}

beforeEach(async () => {
  relay = await startRelay(":memory:", 0);
  base = `http://127.0.0.1:${relay.port}`;
  roots = [];
  daemons = [];
});
afterEach(async () => {
  for (const d of daemons) d.stop();
  await relay.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function pair(bobAdapter: WakeAdapter): Promise<{ alice: Daemon; bob: Daemon }> {
  const reg = await registerWorkspace(base, "waketest", "git@example.com:acme/app.git", "alice");
  if (!reg.ok) throw new Error("register failed");
  const inv = await mintInvite(base, reg.value.workspace_id, reg.value.token, "bob", 1);
  if (!inv.ok) throw new Error("invite failed");
  const joined = await joinWorkspace(base, inv.value, "bob");
  if (!joined.ok) throw new Error("join failed");
  const alice = await member("alice", reg.value.workspace_id, reg.value.token, ["alice"]);
  const bob = await member(
    "bob",
    reg.value.workspace_id,
    joined.value.token,
    joined.value.members,
    bobAdapter
  );
  return { alice, bob };
}

describe("wakes reach the coding tool (T151, T152)", () => {
  it("a live session turn starts a run on the other side; pause stops it; the cap serializes", async () => {
    const adapter = new FakeAdapter();
    const { alice, bob } = await pair(adapter);

    const opened = await alice.threadOpen({ type: "work_item", title: "auto build" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const threadId = opened.thread.id;
    await waitFor(() => bob.threads().some((t) => t.id === threadId), "thread mirror");

    // Handshake: alice names the task, bob readies. Live for both.
    alice.sessionReady(threadId, "build the auto flow together");
    await waitFor(
      () => bob.sessions().some((s) => s.thread_id === threadId && s.state === "forming"),
      "forming on bob"
    );
    bob.sessionReady(threadId);
    await waitFor(
      () => bob.sessions().some((s) => s.thread_id === threadId && s.state === "live"),
      "live on bob"
    );

    // Alice's AGENT message wakes bob's tool with the session turn.
    await alice.post(
      { type: "status", body: "took the first half", refs: [], thread_id: threadId },
      "agent"
    );
    await waitFor(() => adapter.runs.length === 1, "the wake to reach bob's adapter");
    expect(adapter.runs[0]?.reason).toBe("session_turn");
    expect(adapter.runs[0]?.threadId).toBe(threadId);

    // Paused bob: the next turn wakes nothing on his machine.
    bob.pauseMirror.seedOwn(true);
    await alice.post(
      { type: "status", body: "second half thoughts", refs: [], thread_id: threadId },
      "agent"
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(adapter.runs.length).toBe(1);
    bob.pauseMirror.seedOwn(false);

    // The cap: while one run is in flight, further wakes queue and run
    // serially - never two at once (FR-028 interim cap).
    adapter.holdNext = true;
    await alice.post(
      { type: "status", body: "third turn", refs: [], thread_id: threadId },
      "agent"
    );
    await waitFor(() => adapter.runs.length === 2, "held run started");
    await alice.post(
      { type: "status", body: "fourth turn", refs: [], thread_id: threadId },
      "agent"
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(adapter.runs.length).toBe(2);
    adapter.holdNext = false;
    adapter.releaseHeld();
    await waitFor(() => adapter.runs.length === 3, "queued wake ran after release");
  });

  it("an agent's decision shows as proposed on the mirror until its member approves (T155)", async () => {
    const adapter = new FakeAdapter();
    const { alice, bob } = await pair(adapter);
    const opened = await alice.threadOpen({ type: "work_item", title: "close me right" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const threadId = opened.thread.id;

    await alice.post(
      { type: "intent", body: "claiming", refs: [], thread_id: threadId },
      "agent"
    );
    await alice.post(
      { type: "decision", body: "i believe this is finished", refs: [], thread_id: threadId },
      "agent"
    );
    await waitFor(() => {
      const view = bob.threads().find((t) => t.id === threadId);
      return view?.claim_state === "done_proposed";
    }, "the proposal to reach the mirror");

    // Alice (the proposing agent's member) approves; the mirror concludes.
    alice.claimApprove(threadId);
    await waitFor(() => {
      const view = bob.threads().find((t) => t.id === threadId);
      return view?.claim_state === "done";
    }, "the approval to conclude");
  });
});
