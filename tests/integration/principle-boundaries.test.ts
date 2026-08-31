// T136: the Principle III ceiling — an agent's readable set never exceeds
// its member's (SC-018). T137: the v1 run-origin boundary — zero runs start
// from another member's action, and zero start without the member's own
// prompt (SC-019, FR-019). Both assert behavior that exists today, so they
// carry no packages/shared schema dependency (the narrowed Phase 2 gate).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredLogEntry, StoredMessage } from "@saw/shared";
import {
  apiGet,
  startWeb,
  twoMemberWorkspace,
  waitFor,
  type TestWeb,
  type TestWorkspace
} from "./helpers.js";

let ws: TestWorkspace;
let bobWeb: TestWeb | undefined;

beforeEach(async () => {
  ws = await twoMemberWorkspace();
});
afterEach(async () => {
  await bobWeb?.close();
  bobWeb = undefined;
  await ws.close();
});

describe("Principle III ceiling (T136, SC-018)", () => {
  it("every message an agent can read, its member can read on their own surface", async () => {
    await ws.alice.daemon.post(
      { type: "status", body: "broadcast to the room", refs: [] },
      "agent"
    );
    await ws.alice.daemon.post(
      { type: "question", body: "aimed at bob", refs: [], target: "bob" },
      "human"
    );
    await ws.alice.daemon.post(
      { type: "intent", body: "claiming auth", refs: [], work_item: "auth" },
      "agent"
    );
    await ws.bob.daemon.post({ type: "status", body: "bob himself", refs: [] }, "agent");
    await waitFor(
      () => ws.bob.daemon.messages(0, 500).messages.length >= 4,
      "bob's daemon to hold all four messages"
    );

    // The agent's two read paths: the room_read backing store and injection.
    const agentRead = ws.bob.daemon.messages(0, 500).messages;
    const agentInjected = ws.bob.daemon.inject("prompt-submit").messages;

    // The member's own surface: the authenticated local web API.
    bobWeb = await startWeb(ws.bob);
    const res = await apiGet(bobWeb, "/api/messages?since_seq=0&limit=500");
    expect(res.status).toBe(200);
    const memberSeqs = new Set(
      ((res.json as { messages: StoredMessage[] }).messages ?? []).map((m) => m.seq)
    );

    for (const m of agentRead) {
      expect(memberSeqs.has(m.seq), `agent reads seq ${m.seq} the member cannot`).toBe(true);
    }
    for (const m of agentInjected) {
      expect(memberSeqs.has(m.seq), `agent is injected seq ${m.seq} the member cannot read`).toBe(
        true
      );
    }
  });

  it("every log entry an agent can read, its member can read on their own surface", async () => {
    const appended = await ws.alice.daemon.runStop({ tools_used: { Edit: 2 } });
    expect(appended.ok).toBe(true);
    // Poll the async producer: the run must become queryable by bob's agent.
    let agentEntries: StoredLogEntry[] = [];
    await waitFor(() => {
      void ws.bob.daemon.log({ member: "any" }).then((r) => (agentEntries = r.entries));
      return agentEntries.length >= 1;
    }, "bob's agent path to see the run");

    bobWeb = bobWeb ?? (await startWeb(ws.bob));
    const res = await apiGet(bobWeb, "/api/log?member=any&limit=200");
    expect(res.status).toBe(200);
    const memberIds = new Set(
      ((res.json as { entries: StoredLogEntry[] }).entries ?? []).map((e) => e.id)
    );
    for (const e of agentEntries) {
      expect(memberIds.has(e.id), `agent reads log entry ${e.id} the member cannot`).toBe(true);
    }
  });
});

describe("run-origin boundary (T137, SC-019)", () => {
  it("another member's actions start zero runs and move nothing without bob's own prompt", async () => {
    // Alice acts: a broadcast, a message aimed at bob, a claim, and a run of
    // her own. None of it may start anything on bob's side.
    await ws.alice.daemon.post({ type: "status", body: "working", refs: [] }, "agent");
    await ws.alice.daemon.post(
      { type: "decision", body: "bob please look at this", refs: [], target: "bob" },
      "human"
    );
    await ws.alice.daemon.post(
      { type: "intent", body: "claiming pipeline", refs: [], work_item: "pipeline" },
      "agent"
    );
    const aliceRun = await ws.alice.daemon.runStop({ tools_used: { Bash: 3 } });
    expect(aliceRun.ok).toBe(true);

    await waitFor(
      () => ws.bob.daemon.messages(0, 500).messages.length >= 3,
      "delivery to bob's daemon"
    );

    // Zero runs of bob's agent exist: the only writer of a run is bob's own
    // stop hook, and it never fired.
    const logs = await ws.bob.daemon.log({ member: "me" });
    expect(logs.ok).toBe(true);
    expect(logs.entries).toEqual([]);

    // Nothing consumed bob's unread stream either: injection happens only on
    // bob's own turn, so his cursor has not moved.
    expect(ws.bob.daemon.cursor.value).toBe(0);

    // Now bob's own prompt arrives — the one legitimate origin of a run.
    const injected = ws.bob.daemon.inject("prompt-submit", "bob's own prompt about pipeline");
    expect(injected.messages.length).toBeGreaterThan(0);
    ws.bob.daemon.ackInjection(injected.ack_seq, injected.ack_notices);
    const bobRun = await ws.bob.daemon.runStop({ tools_used: { Read: 1 } });
    expect(bobRun.ok).toBe(true);

    let mine: StoredLogEntry[] = [];
    await waitFor(() => {
      void ws.bob.daemon.log({ member: "me" }).then((r) => (mine = r.entries));
      return mine.length === 1;
    }, "exactly one bob run in the log");
    // The why names a bob-side trigger. v0's rule (spec 001, clarifications):
    // a pending human redirect outranks the member's own prompt as the
    // recorded why — both are triggers bob's own daemon captured; neither is
    // a run another member started.
    expect(mine[0]?.why_trigger ?? "").toMatch(/bob's own prompt|Redirect from alice/);
  });
});
