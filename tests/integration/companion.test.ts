// T153/T159: the companion answers when the member's side does not, stays
// silent when it does, takes the companion identity structurally, and does
// nothing privileged. T157/T158 additions: one-sided auto mode and the full
// session round trip through the daemons.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Daemon,
  joinWorkspace,
  mintInvite,
  registerWorkspace,
  startWebServer,
  writeMemberFiles
} from "@saw/cli";
import type { WakeAdapter, WakeRun } from "@saw/cli";
import { startRelay, type RelayServer } from "@saw/relay";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "./helpers.js";

class FakeAdapter implements WakeAdapter {
  name = "fake";
  runs: WakeRun[] = [];
  supportsWake(): boolean {
    return true;
  }
  startRun(run: WakeRun): Promise<{ ok: boolean }> {
    this.runs.push(run);
    return Promise.resolve({ ok: true });
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
  adapter: WakeAdapter,
  graceMs: number
): Promise<Daemon> {
  const root = mkdtempSync(join(tmpdir(), `saw-comp-${name}-`));
  roots.push(root);
  writeMemberFiles(root, {
    workspaceId,
    workspaceName: "comptest",
    relayUrl: base.replace("http", "ws"),
    github: name,
    repoRemote: "git@example.com:acme/app.git",
    members,
    token
  });
  const daemon = new Daemon({
    root,
    clientName: `comp-${name}`,
    wakeAdapter: adapter,
    companionGraceMs: graceMs
  });
  const connected = await daemon.start(6000);
  if (!connected) throw new Error(`${name} did not connect`);
  daemons.push(daemon);
  return daemon;
}

async function pair(
  aliceAdapter: FakeAdapter,
  bobAdapter: FakeAdapter,
  graceMs = 120
): Promise<{ alice: Daemon; bob: Daemon }> {
  const reg = await registerWorkspace(base, "comptest", "git@example.com:acme/app.git", "alice");
  if (!reg.ok) throw new Error("register failed");
  const inv = await mintInvite(base, reg.value.workspace_id, reg.value.token, "bob", 1);
  if (!inv.ok) throw new Error("invite failed");
  const joined = await joinWorkspace(base, inv.value, "bob");
  if (!joined.ok) throw new Error("join failed");
  const alice = await member(
    "alice",
    reg.value.workspace_id,
    reg.value.token,
    ["alice"],
    aliceAdapter,
    graceMs
  );
  const bob = await member(
    "bob",
    reg.value.workspace_id,
    joined.value.token,
    joined.value.members,
    bobAdapter,
    graceMs
  );
  return { alice, bob };
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

describe("the companion (T153, T159, SC-028)", () => {
  it("answers a targeted question after the grace, with the companion prompt", async () => {
    const aliceAdapter = new FakeAdapter();
    const bobAdapter = new FakeAdapter();
    const { alice, bob } = await pair(aliceAdapter, bobAdapter);
    const opened = await alice.threadOpen({ type: "work_item", title: "status of auth" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const threadId = opened.thread.id;
    await waitFor(() => bob.threads().some((t) => t.id === threadId), "mirror");

    // Alice's human asks bob a question in the thread. Bob's side is idle.
    await alice.post(
      {
        type: "question",
        body: "where does the auth work stand?",
        refs: [],
        thread_id: threadId,
        target: "bob"
      },
      "human"
    );
    await waitFor(
      () => bobAdapter.runs.some((r) => r.companionPrompt !== undefined),
      "the companion to answer"
    );
    const run = bobAdapter.runs.find((r) => r.companionPrompt !== undefined);
    expect(run?.companionPrompt).toContain("bob's SAW companion");
    expect(run?.companionPrompt).toContain("where does the auth work stand?");
    expect(run?.companionPrompt).toContain("must not edit files");
    // Alice's own question woke HER agent (her words, her prompt) - but no
    // companion ran on her side: the question was not for her.
    expect(aliceAdapter.runs.every((r) => r.companionPrompt === undefined)).toBe(true);
  });

  it("stays silent when the member's own side answers within the grace", async () => {
    const aliceAdapter = new FakeAdapter();
    const bobAdapter = new FakeAdapter();
    const { alice, bob } = await pair(aliceAdapter, bobAdapter, 300);
    const opened = await alice.threadOpen({ type: "work_item", title: "quick answer" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const threadId = opened.thread.id;
    await waitFor(() => bob.threads().some((t) => t.id === threadId), "mirror");

    await alice.post(
      { type: "question", body: "quick one?", refs: [], thread_id: threadId, target: "bob" },
      "human"
    );
    // Bob answers himself before the grace runs out.
    await bob.post(
      { type: "status", body: "on it, answer is yes", refs: [], thread_id: threadId },
      "agent"
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(bobAdapter.runs.every((r) => r.companionPrompt === undefined)).toBe(true);
  });

  it("a companion post carries the companion identity end to end", async () => {
    const aliceAdapter = new FakeAdapter();
    const bobAdapter = new FakeAdapter();
    const { alice, bob } = await pair(aliceAdapter, bobAdapter);
    const opened = await alice.threadOpen({ type: "work_item", title: "identity check" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const threadId = opened.thread.id;
    await waitFor(() => bob.threads().some((t) => t.id === threadId), "mirror");

    // Over HTTP, because that is the real path: the MCP layer reads
    // SAW_COMPANION from the run's environment and POSTs /api/post. The
    // first version of this test called daemon.post directly — and reached
    // past the one hop that erased the identity (#205 review): local-api
    // coerced "companion" to "agent", so every relay-side companion rule
    // was unreachable from a real companion run.
    const web = await startWebServer(bob, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${web.port}/api/post`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${web.token}`
        },
        body: JSON.stringify({
          type: "status",
          body: "from the record: auth is claimed and one branch is bound",
          refs: [],
          thread_id: threadId,
          sender_kind: "companion"
        })
      });
      expect(res.status).toBe(200);
      await waitFor(
        () => alice.messages(0, 100).messages.some((m) => m.sender_kind === "companion"),
        "the companion post to arrive typed"
      );
    } finally {
      await web.close();
    }
    const msg = alice.messages(0, 100).messages.find((m) => m.sender_kind === "companion");
    expect(msg?.sender).toBe("bob");
    // And a companion message wakes nobody, even inside a live session.
    expect(aliceAdapter.runs.every((r) => r.companionPrompt === undefined)).toBe(true);
    expect(aliceAdapter.runs.filter((r) => r.reason === "session_turn").length).toBe(0);
  });

  it("a paused member's companion is refused at the boundary: pause is total", async () => {
    const aliceAdapter = new FakeAdapter();
    const bobAdapter = new FakeAdapter();
    const { alice, bob } = await pair(aliceAdapter, bobAdapter);
    const opened = await alice.threadOpen({ type: "work_item", title: "paused companion" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const threadId = opened.thread.id;
    await waitFor(() => bob.threads().some((t) => t.id === threadId), "mirror");

    // Decided at the #205 review: pause silences every automated voice,
    // the companion included, and only the member's own human words pass.
    // Enforced at /api/post rather than left to the spawn-side check, so a
    // run already going when the pause lands is still refused.
    const web = await startWebServer(bob, 0);
    try {
      const post = (kind: "agent" | "human" | "companion") =>
        fetch(`http://127.0.0.1:${web.port}/api/post`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${web.token}`
          },
          body: JSON.stringify({
            type: "status",
            body: `${kind} speaking while paused`,
            refs: [],
            thread_id: threadId,
            sender_kind: kind
          })
        });
      const pausing = await fetch(`http://127.0.0.1:${web.port}/api/pause`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${web.token}`
        },
        body: JSON.stringify({ paused: true })
      });
      expect(pausing.status).toBe(200);
      await waitFor(() => bob.pauseMirror.ownPaused, "the pause to land");

      expect((await post("companion")).status).toBe(423);
      expect((await post("agent")).status).toBe(423);
      expect((await post("human")).status).toBe(200);
    } finally {
      await web.close();
    }
  });
});

describe("one-sided auto mode and the round trip (T157, T158, SC-026, SC-027)", () => {
  it("one member ready alone: forming, autonomous on their side only, zero runs opposite", async () => {
    const aliceAdapter = new FakeAdapter();
    const bobAdapter = new FakeAdapter();
    const { alice, bob } = await pair(aliceAdapter, bobAdapter);
    const opened = await alice.threadOpen({ type: "work_item", title: "solo auto" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const threadId = opened.thread.id;
    await waitFor(() => bob.threads().some((t) => t.id === threadId), "mirror");

    alice.sessionReady(threadId, "solo grind");
    await waitFor(
      () => alice.sessions().some((s) => s.thread_id === threadId && s.state === "forming"),
      "forming"
    );
    // Alice's own human message wakes her own agent (autonomy on her side).
    await alice.post(
      { type: "status", body: "keep going on this", refs: [], thread_id: threadId },
      "human"
    );
    await waitFor(() => aliceAdapter.runs.length === 1, "own-message wake");
    // Her AGENT's messages wake nobody: the session never went live.
    await alice.post(
      { type: "status", body: "progress from the agent", refs: [], thread_id: threadId },
      "agent"
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(bobAdapter.runs.length).toBe(0);
  });

  it("the full round trip: ready, three turns each, propose, human approves, concluded (SC-026)", async () => {
    const aliceAdapter = new FakeAdapter();
    const bobAdapter = new FakeAdapter();
    const { alice, bob } = await pair(aliceAdapter, bobAdapter);
    const opened = await alice.threadOpen({ type: "work_item", title: "the real thing" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const threadId = opened.thread.id;
    await waitFor(() => bob.threads().some((t) => t.id === threadId), "mirror");

    alice.sessionReady(threadId, "build it together", 10);
    await waitFor(
      () => bob.sessions().some((s) => s.thread_id === threadId && s.state === "forming"),
      "forming on bob"
    );
    bob.sessionReady(threadId, undefined, 10);
    await waitFor(
      () => alice.sessions().some((s) => s.thread_id === threadId && s.state === "live"),
      "live"
    );

    // Three autonomous turns each: the test plays both agents, posting a
    // turn whenever the fake adapter records a wake.
    for (let i = 0; i < 3; i++) {
      await alice.post(
        { type: "status", body: `alice turn ${i + 1}`, refs: [], thread_id: threadId },
        "agent"
      );
      await waitFor(() => bobAdapter.runs.length === i + 1, `bob wake ${i + 1}`);
      await bob.post(
        { type: "status", body: `bob turn ${i + 1}`, refs: [], thread_id: threadId },
        "agent"
      );
      await waitFor(() => aliceAdapter.runs.length === i + 1, `alice wake ${i + 1}`);
    }
    const session = alice.sessions().find((s) => s.thread_id === threadId);
    expect(session?.state).toBe("live");
    for (const m of session?.members ?? []) {
      expect(m.turns_used).toBeLessThanOrEqual(m.max_turns);
    }

    // Bob's agent proposes done; only bob's human approval concludes.
    bob.convergePropose(session?.id ?? "", "both halves built and reviewed", [
      { kind: "branch", value: "bob/the-real-thing" }
    ]);
    await waitFor(
      () => alice.sessions().some((s) => s.id === session?.id && s.state === "converged"),
      "converged"
    );
    bob.convergeApprove(session?.id ?? "");
    await waitFor(
      () => alice.sessions().some((s) => s.id === session?.id && s.state === "concluded"),
      "concluded"
    );
    const final = alice.sessions().find((s) => s.id === session?.id);
    expect(final?.convergence?.approved_by).toBe("bob");
  });
});
