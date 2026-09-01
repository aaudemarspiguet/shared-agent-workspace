// Spec 002 US8 through two real daemons: the ordered agent gate (T122,
// T124), binding decisions that settle the record without touching the
// receiving machine (T131, SC-021) and persist until answered (T129), and
// two members in edit landing prefixed refs with no code crossing (T144).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentGate, renderContext, writeDaemonInfo, type InjectResponse } from "@saw/cli";
import {
  apiPost,
  startWeb,
  twoMemberWorkspace,
  waitFor,
  type TestWeb,
  type TestWorkspace
} from "./helpers.js";

let ws: TestWorkspace;
let web: TestWeb | undefined;
beforeEach(async () => {
  ws = await twoMemberWorkspace();
});
afterEach(async () => {
  await web?.close();
  web = undefined;
  await ws.close();
});

describe("the ordered agent gate (T119, T122, T124)", () => {
  it("denies above-mode actions with the mode named, pause outranking mode", async () => {
    const opened = await ws.bob.daemon.threadOpen({ type: "work_item", title: "gated" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const threadId = opened.thread.id;

    // The gate reads the daemon the way tools do: through daemon.json.
    web = await startWeb(ws.bob);
    writeDaemonInfo(ws.bob.root, {
      port: web.port,
      pid: process.pid,
      started_at: new Date().toISOString(),
      token: web.token
    });

    // Default mode comment: posting passes, claiming is denied (SC-015).
    expect(await agentGate(ws.bob.root, { threadId, action: "post" })).toBeUndefined();
    const claimDenied = await agentGate(ws.bob.root, { threadId, action: "claim" });
    expect(JSON.stringify(claimDenied)).toContain("mode_denied");
    expect(JSON.stringify(claimDenied)).toContain("comment");

    // Binding a ref needs `edit` too (FR-014, CHK007). This action was
    // defined in the shared ladder and passed by no caller, so a member in
    // `comment` bound refs by hanging them on a post, which needs one rung
    // less. Now the same rung as claiming.
    const bindDenied = await agentGate(ws.bob.root, { threadId, action: "bind_ref" });
    expect(JSON.stringify(bindDenied)).toContain("mode_denied");
    expect(JSON.stringify(bindDenied)).toContain("bind_ref");
    ws.bob.daemon.setThreadMode(threadId, "edit");
    expect(await agentGate(ws.bob.root, { threadId, action: "bind_ref" })).toBeUndefined();
    ws.bob.daemon.setThreadMode(threadId, "comment");

    // view: even posting is denied, and the denial is recorded (T120).
    ws.bob.daemon.setThreadMode(threadId, "view");
    const postDenied = await agentGate(ws.bob.root, { threadId, action: "post" });
    expect(JSON.stringify(postDenied)).toContain("mode_denied");
    let denialLogged = false;
    await waitFor(() => {
      void ws.bob.daemon
        .log({ member: "me" })
        .then(
          (r) => (denialLogged = r.entries.some((e) => e.why_trigger.includes("mode denial")))
        );
      return denialLogged;
    }, "the denial to reach the log");

    // Pause outranks mode (T124): the same call now reports paused, not mode.
    await apiPost(web, "/api/pause", { paused: true });
    await waitFor(() => ws.bob.daemon.pauseMirror.ownPaused, "pause to land");
    const paused = await agentGate(ws.bob.root, { threadId, action: "post" });
    expect(JSON.stringify(paused)).toContain("paused");
    expect(JSON.stringify(paused)).not.toContain("mode_denied");
  });
});

describe("binding decisions (T128, T129, T131)", () => {
  it("settles the record, starts nothing on the other machine, persists until answered", async () => {
    const opened = await ws.alice.daemon.threadOpen({ type: "work_item", title: "ship date" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const threadId = opened.thread.id;

    // alice is the workspace creator: her binding decision lands.
    const posted = await ws.alice.daemon.post(
      { type: "decision", body: "we ship monday", refs: [], thread_id: threadId, force: "binding" },
      "human"
    );
    expect(posted.ok).toBe(true);
    await waitFor(
      () => ws.bob.daemon.messages(0, 100).messages.some((m) => m.force === "binding"),
      "the decision to reach bob"
    );

    // SC-021: zero runs, zero cursor movement on bob's machine.
    const logs = await ws.bob.daemon.log({ member: "me" });
    expect(logs.entries).toEqual([]);
    expect(ws.bob.daemon.cursor.value).toBe(0);

    // The decision is surfaced with the settles-not-directs contract, and
    // repeats across an acknowledged injection (T129).
    const first = ws.bob.daemon.inject("prompt-submit");
    const text = renderContext("prompt-submit", first as unknown as InjectResponse);
    expect(text).toContain("Binding decisions on the record, unanswered (1):");
    expect(text).toContain("we ship monday");
    expect(text).toContain("None directs you");
    ws.bob.daemon.ackInjection(first.ack_seq, first.ack_notices);
    const second = ws.bob.daemon.inject("prompt-submit");
    expect(second.binding_decisions.length).toBe(1);

    // Answering into the thread clears it.
    const answer = await ws.bob.daemon.post(
      { type: "status", body: "acknowledged, monday works", refs: [], thread_id: threadId },
      "agent"
    );
    expect(answer.ok).toBe(true);
    expect(ws.bob.daemon.inject("prompt-submit").binding_decisions.length).toBe(0);
  });

  it("refuses a binding post from the non-owner with a plain reason", async () => {
    const opened = await ws.bob.daemon.threadOpen({ type: "work_item", title: "bob tries" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const posted = await ws.bob.daemon.post(
      {
        type: "decision",
        body: "i decree",
        refs: [],
        thread_id: opened.thread.id,
        force: "binding"
      },
      "human"
    );
    expect(posted.ok).toBe(false);
    if (!posted.ok) expect(posted.message).toContain("authority");
  });
});

describe("two members in edit on one thread (T144, SC-017)", () => {
  it("lands both prefixed refs bound to the thread, and code never crosses", async () => {
    const opened = await ws.alice.daemon.threadOpen({ type: "work_item", title: "shared work" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const threadId = opened.thread.id;
    ws.alice.daemon.setThreadMode(threadId, "edit");
    ws.bob.daemon.setThreadMode(threadId, "edit");

    await ws.alice.daemon.post(
      {
        type: "status",
        body: "my half is pushed",
        refs: [{ kind: "branch", value: "alice/shared-work" }],
        thread_id: threadId
      },
      "agent"
    );
    await waitFor(
      () => ws.bob.daemon.messages(0, 100).messages.some((m) => m.body === "my half is pushed"),
      "delivery to bob"
    );
    await ws.bob.daemon.post(
      {
        type: "status",
        body: "continuing from your tip",
        refs: [{ kind: "branch", value: "bob/shared-work" }],
        thread_id: threadId
      },
      "agent"
    );

    await waitFor(() => {
      const view = ws.alice.daemon.threads().find((t) => t.id === threadId);
      return (view?.refs.length ?? 0) >= 2;
    }, "both bindings to reach alice");
    const refs = ws.alice.daemon
      .threads()
      .find((t) => t.id === threadId)
      ?.refs.map((b) => b.ref.value)
      .sort();
    expect(refs).toEqual(["alice/shared-work", "bob/shared-work"]);

    // Code still cannot cross: a pasted file is rejected at the boundary.
    const smuggle = await ws.alice.daemon.post(
      {
        type: "status",
        body: "```" + Array.from({ length: 30 }, (_, i) => `const x${i}=${i};`).join("\n") + "```",
        refs: [],
        thread_id: threadId
      },
      "agent"
    );
    expect(smuggle.ok).toBe(false);
  });
});
