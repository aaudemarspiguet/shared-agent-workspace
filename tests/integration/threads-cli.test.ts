// Spec 002 phase 3, CLI half: threads through two real daemons (T107,
// T110-T114 backing paths). The relay half is covered in
// packages/relay/tests; this covers the daemon mirror, the thread-scoped
// reads, and the grouped injection.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderContext, type InjectResponse } from "@saw/cli";
import { twoMemberWorkspace, waitFor, type TestWorkspace } from "./helpers.js";

let ws: TestWorkspace;
beforeEach(async () => {
  ws = await twoMemberWorkspace();
});
afterEach(async () => {
  await ws.close();
});

describe("threads through the daemons (spec 002 phase 3)", () => {
  it("opens a thread, mirrors it on both sides, reads it in isolation", async () => {
    const opened = await ws.alice.daemon.threadOpen({ type: "work_item", title: "auth" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const auth = opened.thread;

    await waitFor(
      () => ws.bob.daemon.threads().some((t) => t.id === auth.id),
      "bob's mirror to hold the thread"
    );

    await ws.alice.daemon.post(
      { type: "intent", body: "claiming auth", refs: [], thread_id: auth.id },
      "agent"
    );
    await ws.alice.daemon.post({ type: "status", body: "a broadcast", refs: [] }, "agent");
    await waitFor(
      () => ws.bob.daemon.messages(0, 100).messages.length >= 2,
      "delivery to bob"
    );

    // The thread read returns that thread only (FR-011).
    const inThread = ws.bob.daemon.messages(0, 100, undefined, auth.id).messages;
    expect(inThread.length).toBe(1);
    expect(inThread[0]?.body).toBe("claiming auth");
    expect(inThread[0]?.thread_seq).toBe(1);

    // The claim shows on the thread view, assignee-style (T112).
    await waitFor(() => {
      const view = ws.bob.daemon.threads().find((t) => t.id === auth.id);
      return view?.claim_state === "claimed" && view.claimed_by === "alice";
    }, "the claim to reach bob's thread view");
    expect(ws.bob.daemon.status().threads.some((t) => t.id === auth.id)).toBe(true);
  });

  it("groups injected context by thread with titles (T114)", async () => {
    const opened = await ws.alice.daemon.threadOpen({ type: "brainstorm", title: "image gen" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await ws.alice.daemon.post(
      { type: "status", body: "first idea", refs: [], thread_id: opened.thread.id },
      "agent"
    );
    await ws.alice.daemon.post({ type: "status", body: "hello everyone", refs: [] }, "human");
    await waitFor(() => ws.bob.daemon.messages(0, 100).messages.length >= 2, "delivery");

    const injected = ws.bob.daemon.inject("prompt-submit");
    const text = renderContext("prompt-submit", injected as unknown as InjectResponse);
    expect(text).toContain('Thread "image gen" (1 new):');
    expect(text).toContain("Broadcasts:");
    expect(text).toContain("first idea");
    expect(text).toContain("hello everyone");
  });

  it("a ref on a threaded post binds to the thread on both mirrors (T115)", async () => {
    const opened = await ws.alice.daemon.threadOpen({ type: "work_item", title: "pipeline" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await ws.alice.daemon.post(
      {
        type: "status",
        body: "pushed the branch",
        refs: [{ kind: "branch", value: "alice/pipeline" }],
        thread_id: opened.thread.id
      },
      "agent"
    );
    await waitFor(() => {
      const view = ws.bob.daemon.threads().find((t) => t.id === opened.thread.id);
      return (view?.refs.length ?? 0) >= 1;
    }, "the binding to reach bob");
    const view = ws.bob.daemon.threads().find((t) => t.id === opened.thread.id);
    expect(view?.refs[0]?.ref).toEqual({ kind: "branch", value: "alice/pipeline" });
  });
});
