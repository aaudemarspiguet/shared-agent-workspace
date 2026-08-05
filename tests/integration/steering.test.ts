// T038 — User Story 2: a human steers and pauses the agents.
// Maps to quickstart.md Scenario 2 (FR-012, FR-013, FR-014, SC-006).
// The first test also holds the T051 timing assertion for SC-006.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  apiGet,
  apiPost,
  startWeb,
  twoMemberWorkspace,
  waitFor,
  waitForValue,
  type TestWorkspace
} from "./helpers.js";

type WebHandle = Awaited<ReturnType<typeof startWeb>>;

const REDIRECT_BODY = "Stop the parser. Switch to the API.";

describe("human steering and pause (US2)", () => {
  let ws: TestWorkspace;
  // Web handles live at describe scope so afterAll can close leftovers.
  let bobWeb: WebHandle | undefined;
  let aliceWeb: WebHandle | undefined;
  let aliceUrl = "";

  beforeAll(async () => {
    ws = await twoMemberWorkspace();
  });

  afterAll(async () => {
    await bobWeb?.close();
    await aliceWeb?.close();
    await ws.close();
  });

  it("human redirect reaches the target daemon in under 5 s and injects at the next turn", async () => {
    const web = await startWeb(ws.bob);
    bobWeb = web;

    // Bob's human sends a redirect to alice's agent from bob's web UI.
    const clockStart = performance.now();
    const posted = await apiPost(web.url, "/api/post", {
      type: "status",
      body: REDIRECT_BODY,
      sender_kind: "human",
      target: "alice"
    });
    expect(posted.status).toBe(200);

    await waitFor(
      () => ws.alice.daemon.messages(0).messages.some((m) => m.body === REDIRECT_BODY),
      "alice's daemon to receive the redirect"
    );
    // SC-006 / T051: delivery to the target daemon takes less than 5 s.
    expect(performance.now() - clockStart).toBeLessThan(5000);

    // The next agent turn receives the redirect as injected context.
    const injected = ws.alice.daemon.inject("prompt-submit", "continue");
    const redirect = injected.messages.find((m) => m.body === REDIRECT_BODY);
    expect(redirect?.sender).toBe("bob");
    expect(redirect?.sender_kind).toBe("human");
    expect(redirect?.target).toBe("alice");

    // The run log names the redirect as the trigger, not the prompt.
    const stopped = await ws.alice.daemon.runStop({ tools_used: {} });
    expect(stopped.ok).toBe(true);
    const entry = await waitForValue(async () => {
      const result = await ws.alice.daemon.log({ member: "me" });
      return result.entries.find((e) => e.why_trigger.startsWith("Redirect from bob:"));
    }, "the redirect trigger to appear in alice's work log");
    expect(entry.why_trigger).toContain(REDIRECT_BODY);

    await web.close();
    bobWeb = undefined;
  });

  it("pause blocks the paused member's agent but not their human", async () => {
    const web = await startWeb(ws.alice);
    aliceWeb = web;
    aliceUrl = web.url;

    const paused = await apiPost(aliceUrl, "/api/pause", { paused: true });
    expect(paused.status).toBe(200);

    // The PreToolUse hook reads this state and denies tool calls on it.
    const state = await apiGet(aliceUrl, "/api/pause");
    expect(state.status).toBe(200);
    expect((state.json as { paused: boolean }).paused).toBe(true);

    // The paused member's agent cannot post.
    const agentPost = await ws.alice.daemon.post(
      { type: "status", body: "The agent tries to speak.", refs: [] },
      "agent"
    );
    expect(agentPost.ok).toBe(false);
    if (!agentPost.ok) expect(agentPost.message).toBe("paused");

    // The same member's human still can post from her own web UI.
    const humanPost = await apiPost(aliceUrl, "/api/post", {
      type: "status",
      body: "The human speaks while the agent is paused.",
      sender_kind: "human"
    });
    expect(humanPost.status).toBe(200);
    // Alice stays paused for the next test.
  });

  it("messages queue while paused and deliver in seq order on resume (FR-014)", async () => {
    expect(ws.alice.daemon.pauseMirror.ownPaused).toBe(true);

    const first = await ws.bob.daemon.post(
      { type: "status", body: "queued one", refs: [] },
      "agent"
    );
    const second = await ws.bob.daemon.post(
      { type: "status", body: "queued two", refs: [] },
      "agent"
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // Small settle wait. The relay must hold the messages back, so there
    // is no delivery event to wait for on alice's side.
    await new Promise((r) => setTimeout(r, 400));
    const heldBodies = ws.alice.daemon.messages(0).messages.map((m) => m.body);
    expect(heldBodies).not.toContain("queued one");
    expect(heldBodies).not.toContain("queued two");

    // Resume. The daemon syncs and the relay replays the held messages.
    const resumed = await apiPost(aliceUrl, "/api/pause", { paused: false });
    expect(resumed.status).toBe(200);
    await waitFor(() => {
      const bodies = ws.alice.daemon.messages(0).messages.map((m) => m.body);
      return bodies.includes("queued one") && bodies.includes("queued two");
    }, "the queued messages to replay after resume");

    // The replay keeps the posted order and ascending seq order.
    const replayed = ws.alice.daemon
      .messages(0)
      .messages.filter((m) => m.body.startsWith("queued "));
    expect(replayed.map((m) => m.body)).toEqual(["queued one", "queued two"]);
    const seqs = replayed.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    // The next agent turn injects both messages in the same order.
    const injected = ws.alice.daemon.inject("prompt-submit");
    const injectedBodies = injected.messages
      .filter((m) => m.body.startsWith("queued "))
      .map((m) => m.body);
    expect(injectedBodies).toEqual(["queued one", "queued two"]);

    await aliceWeb?.close();
    aliceWeb = undefined;
  });

  it("a member cannot pause the peer (FR-013)", async () => {
    // Speak the relay protocol directly as bob. The relay allows one live
    // connection per member, so this hello kicks bob's daemon off. The
    // daemon reconnects with backoff after the raw socket closes.
    const raw = new WebSocket(`${ws.relayWs}/ws`);
    const frames: { kind?: string }[] = [];
    raw.on("message", (data) => {
      frames.push(JSON.parse(String(data)) as { kind?: string });
    });
    await new Promise<void>((resolve, reject) => {
      raw.once("open", resolve);
      raw.once("error", reject);
    });
    raw.send(
      JSON.stringify({
        kind: "hello",
        workspace_id: ws.workspaceId,
        token: ws.bobToken,
        client: "forge-test"
      })
    );
    await waitFor(() => frames.some((f) => f.kind === "hello_ok"), "the raw hello_ok");

    // Send a forged pause aimed at alice. The frame schema drops the
    // member field, so the pause applies to the sender (bob) only.
    raw.send(JSON.stringify({ kind: "pause_set", paused: true, member: "alice" }));
    await waitFor(
      () =>
        ws.alice.daemon
          .status()
          .members.some((m) => m.github_username === "bob" && m.paused),
      "alice to observe bob paused"
    );

    // Alice is not touched by the forged frame.
    expect(ws.alice.daemon.pauseMirror.ownPaused).toBe(false);
    const aliceRow = ws.alice.daemon
      .status()
      .members.find((m) => m.github_username === "alice");
    expect(aliceRow?.paused).toBe(false);

    // Clean up: unpause bob, then give the connection back to his daemon.
    raw.send(JSON.stringify({ kind: "pause_set", paused: false }));
    await waitFor(
      () =>
        ws.alice.daemon
          .status()
          .members.some((m) => m.github_username === "bob" && !m.paused),
      "alice to observe bob resumed"
    );
    raw.close();
    await waitFor(() => ws.bob.daemon.connected, "bob's daemon to reconnect", 15000);
  });
});
