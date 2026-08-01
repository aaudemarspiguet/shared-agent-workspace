// T031 — User Story 1: agents coordinate work in a shared room.
// Maps to quickstart.md Scenario 1 (SC-002, SC-005).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { twoMemberWorkspace, waitFor, waitForValue, type TestWorkspace } from "./helpers.js";

describe("room coordination (US1)", () => {
  let ws: TestWorkspace;

  beforeAll(async () => {
    ws = await twoMemberWorkspace();
  });

  afterAll(async () => {
    await ws.close();
  });

  it("delivers an intent to the peer and claims the work item", async () => {
    const posted = await ws.alice.daemon.post(
      {
        type: "intent",
        body: "I will take the login form.",
        refs: [],
        work_item: "login-form"
      },
      "agent"
    );
    expect(posted.ok).toBe(true);

    await waitFor(
      () => ws.bob.daemon.messages(0).messages.some((m) => m.work_item === "login-form"),
      "bob to receive alice's intent"
    );
    const seen = ws.bob.daemon.messages(0).messages.find((m) => m.work_item === "login-form");
    expect(seen?.sender).toBe("alice");
    expect(seen?.type).toBe("intent");

    await waitFor(
      () =>
        ws.bob.daemon
          .status()
          .work_items.some(
            (w) => w.feature_tag === "login-form" && w.state === "claimed" && w.claimed_by === "alice"
          ),
      "bob's mirror to show alice's claim"
    );
  });

  it("rejects a duplicate claim visibly for both members (first claim wins)", async () => {
    const posted = await ws.bob.daemon.post(
      { type: "intent", body: "I want login-form too.", refs: [], work_item: "login-form" },
      "agent"
    );
    // The message itself is accepted. Only the claim fails.
    expect(posted.ok).toBe(true);

    // Both daemons receive the claim_result rejection notice.
    await waitFor(
      () =>
        ws.bob.daemon.state
          .recentClaimNotices()
          .some((n) => n.work_item === "login-form" && !n.granted && n.claimed_by === "alice"),
      "bob to see his rejected claim"
    );
    await waitFor(
      () =>
        ws.alice.daemon.state
          .recentClaimNotices()
          .some((n) => n.work_item === "login-form" && !n.granted),
      "alice to see the rejected claim too"
    );

    // The item still belongs to alice.
    const item = ws.bob.daemon.status().work_items.find((w) => w.feature_tag === "login-form");
    expect(item?.claimed_by).toBe("alice");
    expect(item?.state).toBe("claimed");
  });

  it("hands off with a branch ref; the ref crosses, code does not", async () => {
    const posted = await ws.alice.daemon.post(
      {
        type: "handoff",
        body: "Login form is ready for review.",
        refs: [{ kind: "branch", value: "alice/login-form" }],
        work_item: "login-form"
      },
      "agent"
    );
    expect(posted.ok).toBe(true);

    await waitFor(
      () => ws.bob.daemon.messages(0).messages.some((m) => m.type === "handoff"),
      "bob to receive the handoff"
    );
    const handoff = ws.bob.daemon.messages(0).messages.find((m) => m.type === "handoff");
    expect(handoff?.refs).toEqual([{ kind: "branch", value: "alice/login-form" }]);

    // The handoff reassigns the item to bob (handed_off state).
    await waitFor(
      () =>
        ws.bob.daemon
          .status()
          .work_items.some((w) => w.feature_tag === "login-form" && w.state === "handed_off"),
      "the item to be handed off to bob"
    );

    // Bob accepts with an intent for the same work item.
    const accept = await ws.bob.daemon.post(
      { type: "intent", body: "Taking over the login form.", refs: [], work_item: "login-form" },
      "agent"
    );
    expect(accept.ok).toBe(true);
    await waitFor(
      () =>
        ws.alice.daemon
          .status()
          .work_items.some(
            (w) => w.feature_tag === "login-form" && w.state === "claimed" && w.claimed_by === "bob"
          ),
      "alice's mirror to show bob holding the item"
    );
  });

  it("rejects a smuggling body at the boundary and logs it (SC-005)", async () => {
    const fence = "```\n" + Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n```";
    const posted = await ws.alice.daemon.post(
      { type: "status", body: fence, refs: [] },
      "agent"
    );
    expect(posted.ok).toBe(false);
    if (!posted.ok) {
      expect(posted.code).toBe("rejected");
      expect(posted.message).toContain("content_smuggling");
    }

    // The rejected body is never delivered to the peer.
    const leaked = ws.bob.daemon.messages(0).messages.some((m) => m.body.includes("line 29"));
    expect(leaked).toBe(false);

    // The rejection lands in the work log without echoing the payload.
    const entry = await waitForValue(async () => {
      const result = await ws.alice.daemon.log({ member: "me", limit: 50 });
      return result.entries.find((e) => e.source === "boundary_rejection");
    }, "the boundary rejection to appear in the log");
    expect(entry.why_trigger).toContain("content_smuggling");
    expect(entry.why_trigger).not.toContain("line 29");
  });

  it("keeps one ordered history for both members (SC-002)", async () => {
    const aliceSeqs = ws.alice.daemon.messages(0).messages.map((m) => m.seq);
    const bobSeqs = ws.bob.daemon.messages(0).messages.map((m) => m.seq);
    expect(aliceSeqs).toEqual(bobSeqs);
    expect(aliceSeqs).toEqual([...aliceSeqs].sort((a, b) => a - b));
  });
});
