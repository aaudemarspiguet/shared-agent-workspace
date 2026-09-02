// T050 — Reconnect ordering after an offline window.
// Maps to quickstart.md Scenario 5 (SC-007): 100% in-order replay.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon } from "@saw/cli";
import {
  RecordingWakeAdapter,
  twoMemberWorkspace,
  waitFor,
  type TestWorkspace
} from "./helpers.js";

describe("reconnect ordering (Scenario 5)", () => {
  let ws: TestWorkspace;
  let bob2: Daemon;

  beforeAll(async () => {
    ws = await twoMemberWorkspace();
  });

  afterAll(async () => {
    bob2?.stop();
    await ws.close();
  });

  it("a member that was offline replays every missed message in seq order", async () => {
    const before = ws.bob.daemon.messages(0).messages.length;
    const latestBefore = ws.bob.daemon.messages(0).latest_seq;
    ws.bob.daemon.stop();

    // Alice posts six updates while bob is offline.
    for (let i = 1; i <= 6; i += 1) {
      const posted = await ws.alice.daemon.post(
        { type: "status", body: `offline update ${i}`, refs: [] },
        "agent"
      );
      expect(posted.ok).toBe(true);
    }

    // Bob comes back. A fresh daemon on the same root syncs from the relay.
    bob2 = new Daemon({ root: ws.bob.root, wakeAdapter: new RecordingWakeAdapter() });
    expect(await bob2.start(6000)).toBe(true);
    await waitFor(
      () => bob2.messages(0).messages.length >= before + 6,
      "bob to replay the six missed messages"
    );

    // Every missed message arrived, in post order.
    const messages = bob2.messages(0).messages;
    const missed = messages.filter((m) => m.seq > latestBefore);
    expect(missed.map((m) => m.body)).toEqual(
      [1, 2, 3, 4, 5, 6].map((i) => `offline update ${i}`)
    );

    // The relay seq is gapless. Each seq is the previous seq plus one.
    // Replay depends on seq, not on clock time. A 24 h offline window
    // behaves the same as this short one.
    const bobSeqs = messages.map((m) => m.seq);
    for (let i = 0; i + 1 < bobSeqs.length; i += 1) {
      expect(bobSeqs[i + 1]).toBe(bobSeqs[i] + 1);
    }

    // Both members hold one identical ordered history (SC-007).
    const aliceSeqs = ws.alice.daemon.messages(0).messages.map((m) => m.seq);
    expect(bobSeqs).toEqual(aliceSeqs);
  });

  it("injection after reconnect delivers the missed messages in order", () => {
    const first = bob2.inject("prompt-submit");
    const bodies = first.messages.map((m) => m.body);
    for (let i = 1; i <= 6; i += 1) {
      expect(bodies).toContain(`offline update ${i}`);
    }
    const seqs = first.messages.map((m) => m.seq);
    for (let i = 0; i + 1 < seqs.length; i += 1) {
      expect(seqs[i + 1]).toBeGreaterThan(seqs[i]);
    }

    // Delivery is two-phase. Until the hook acknowledges, the same messages
    // come back, so a hook that dies cannot lose them.
    const repeat = bob2.inject("prompt-submit");
    expect(repeat.messages.map((m) => m.seq)).toEqual(seqs);

    // After the acknowledgement the cursor moves and persists.
    bob2.ackInjection(first.ack_seq, first.ack_notices);
    const second = bob2.inject("prompt-submit");
    expect(second.messages.length).toBe(0);
  });
});
