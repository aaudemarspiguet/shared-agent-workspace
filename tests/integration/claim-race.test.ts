// Regression test for the two defects found in review of PR #54.
// Both are silent: nothing fails, the wrong state just persists.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { twoMemberWorkspace, waitFor, type TestWorkspace } from "./helpers.js";

describe("claim race and injection delivery (PR #54 review)", () => {
  let ws: TestWorkspace;

  beforeAll(async () => {
    ws = await twoMemberWorkspace();
  });

  afterAll(async () => {
    await ws.close();
  });

  it("corrects the loser's work item mirror when a claim loses the race", async () => {
    // Both members claim the same item before either has seen the other's
    // message. Each mirror optimistically records its own member as owner,
    // so the loser starts out wrong and cannot self-heal from the message
    // stream: the item is no longer `open` when the winner's intent lands.
    const [aliceResult, bobResult] = await Promise.all([
      ws.alice.daemon.post(
        { type: "intent", body: "Taking the parser.", refs: [], work_item: "parser" },
        "agent"
      ),
      ws.bob.daemon.post(
        { type: "intent", body: "Taking the parser too.", refs: [], work_item: "parser" },
        "agent"
      )
    ]);
    expect(aliceResult.ok).toBe(true);
    expect(bobResult.ok).toBe(true);

    // The relay resolves in seq order, so the lower seq wins.
    const winner =
      aliceResult.ok && bobResult.ok && aliceResult.seq < bobResult.seq ? "alice" : "bob";
    const loser = winner === "alice" ? ws.bob : ws.alice;

    await waitFor(
      () =>
        loser.daemon.state
          .recentClaimNotices()
          .some((n) => n.work_item === "parser" && !n.granted),
      "the loser to receive the rejection"
    );

    // Both mirrors must name the winner. Before the fix the loser kept
    // itself as owner for the life of the daemon.
    await waitFor(
      () =>
        loser.daemon
          .status()
          .work_items.find((w) => w.feature_tag === "parser")?.claimed_by === winner,
      "the loser's mirror to name the winner"
    );
    for (const member of [ws.alice, ws.bob]) {
      const item = member.daemon.status().work_items.find((w) => w.feature_tag === "parser");
      expect(item?.claimed_by, `${member.name} mirror owner`).toBe(winner);
      expect(item?.state).toBe("claimed");
    }

    // The loser must not tag its runs with work it does not hold.
    expect(loser.daemon.state.myActiveWorkItem()).not.toBe("parser");
  });

  it("keeps unread messages until the injection is acknowledged", async () => {
    const posted = await ws.alice.daemon.post(
      { type: "status", body: "must not be lost", refs: [] },
      "agent"
    );
    expect(posted.ok).toBe(true);
    await waitFor(
      () => ws.bob.daemon.messages(0).messages.some((m) => m.body === "must not be lost"),
      "bob to receive the message"
    );

    // A hook fetches the message and then dies before it writes its output.
    const first = ws.bob.daemon.inject("prompt-submit", "carry on");
    expect(first.messages.some((m) => m.body === "must not be lost")).toBe(true);

    // The next turn must see it again. Losing it here would be permanent.
    const retry = ws.bob.daemon.inject("prompt-submit", "carry on");
    expect(retry.messages.some((m) => m.body === "must not be lost")).toBe(true);
    expect(ws.bob.daemon.status().unread_count).toBeGreaterThan(0);

    // Only the acknowledgement moves the cursor.
    ws.bob.daemon.ackInjection(retry.ack_seq, retry.ack_notices);
    const after = ws.bob.daemon.inject("prompt-submit", "carry on");
    expect(after.messages.some((m) => m.body === "must not be lost")).toBe(false);
  });

  it("keeps claim notices until the injection that carried them is acknowledged", async () => {
    await ws.alice.daemon.post(
      { type: "intent", body: "Taking the cache.", refs: [], work_item: "cache" },
      "agent"
    );
    await ws.bob.daemon.post(
      { type: "intent", body: "Taking the cache too.", refs: [], work_item: "cache" },
      "agent"
    );
    const loser = await waitFor(
      () =>
        ws.bob.daemon.state.recentClaimNotices().some((n) => n.work_item === "cache"),
      "a claim verdict for the cache item"
    ).then(() => ws.bob);

    const first = loser.daemon.inject("prompt-submit");
    const noticeCount = first.notices.length;
    expect(noticeCount).toBeGreaterThan(0);

    // Unacknowledged, the notices come back rather than vanishing.
    const retry = loser.daemon.inject("prompt-submit");
    expect(retry.notices.length).toBe(noticeCount);

    loser.daemon.ackInjection(retry.ack_seq, retry.ack_notices);
    const after = loser.daemon.inject("prompt-submit");
    expect(after.notices.length).toBe(0);
  });
});
