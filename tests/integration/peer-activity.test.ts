// T047 — User Story 4: ask what the peer's agent did while the peer is offline.
// Maps to quickstart.md Scenario 4 (FR-018, FR-019, SC-004).
// The answer comes from relay storage only. It also includes the T051
// timing check: the answer must arrive in less than 30 seconds.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { twoMemberWorkspace, waitFor, type TestWorkspace } from "./helpers.js";

describe("peer activity (US4)", () => {
  let ws: TestWorkspace;

  beforeAll(async () => {
    ws = await twoMemberWorkspace();
  });

  afterAll(async () => {
    // Bob's daemon is already stopped. A second stop is safe.
    await ws.close();
  });

  it(
    "the answer comes from stored history while the peer is fully offline (SC-004, FR-019)",
    async () => {
      // Bob does some work first. He claims an item and reports a branch.
      const intent = await ws.bob.daemon.post(
        {
          type: "intent",
          body: "I will build the search feature.",
          refs: [],
          work_item: "search"
        },
        "agent"
      );
      expect(intent.ok).toBe(true);

      const status = await ws.bob.daemon.post(
        {
          type: "status",
          body: "Search work is on my branch.",
          refs: [{ kind: "branch", value: "bob/search" }],
          work_item: "search"
        },
        "agent"
      );
      expect(status.ok).toBe(true);

      // Bob completes one full run. The injection records the trigger.
      // The stop hook writes the run summary to the relay log.
      ws.bob.daemon.inject("prompt-submit", "Build search");
      const logged = await ws.bob.daemon.runStop({ tools_used: { Edit: 5 } });
      expect(logged.ok).toBe(true);

      // Alice holds bob's messages before bob goes away.
      await waitFor(
        () =>
          ws.alice.daemon.messages(0).messages.filter((m) => m.sender === "bob").length >= 2,
        "alice to receive bob's messages"
      );

      // Bob goes fully offline. The relay broadcasts his presence change.
      ws.bob.daemon.stop();
      await waitFor(
        () =>
          ws.alice.daemon
            .status()
            .members.some((m) => m.github_username === "bob" && m.online === false),
        "alice to see bob offline"
      );

      // Alice asks about the last day. Time the call (SC-004: under 30 s).
      const startedAt = performance.now();
      const result = await ws.alice.daemon.peerActivity(
        new Date(Date.now() - 86_400_000).toISOString()
      );
      const elapsed = performance.now() - startedAt;
      expect(elapsed).toBeLessThan(30_000);

      expect(result.ok).toBe(true);
      const activity = result.activity;
      expect(activity).toBeDefined();
      if (!activity) return;
      expect(activity.peer).toBe("bob");
      expect(activity.peer_online).toBe(false);
      expect(activity.runs.length).toBeGreaterThanOrEqual(1);
      expect(activity.messages.length).toBeGreaterThanOrEqual(2);
      for (const message of activity.messages) {
        expect(message.sender).toBe("bob");
      }
      expect(activity.note).toBe("Answer built from stored workspace history only.");
    }
  );

  it("an empty window gets an honest empty answer", async () => {
    // A window one year in the future holds no recorded activity.
    // The answer must say so. It must not invent activity.
    const result = await ws.alice.daemon.peerActivity(
      new Date(Date.now() + 31_536_000_000).toISOString()
    );
    expect(result.ok).toBe(true);
    const activity = result.activity;
    expect(activity).toBeDefined();
    if (!activity) return;
    expect(activity.runs).toEqual([]);
    expect(activity.messages).toEqual([]);
    expect(activity.note).toBe("Answer built from stored workspace history only.");
  });
});
