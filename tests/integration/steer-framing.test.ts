// T067 — a steer aimed at one agent is framed, not just listed.
// Alice's human posts a message targeted at bob. Bob's injected context must
// mark that message as addressed to bob, name the sender, and order bob to
// raise a conflict with his own human. An untargeted message must stay in the
// ordinary room list.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderContext } from "../../packages/cli/src/hooks/inject.js";
import { apiPost, startWeb, twoMemberWorkspace, waitFor, type TestWorkspace } from "./helpers.js";

type WebHandle = Awaited<ReturnType<typeof startWeb>>;

const STEER_BODY = "Stop the retry loop. Use the queue instead.";
const CHATTER_BODY = "The build on main is green again.";

const ADDRESSED_HEADING = "Messages addressed to you";

/** Split the rendered context into the ordinary block and the addressed block. */
function splitBlocks(text: string): { room: string; addressed: string } {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(ADDRESSED_HEADING));
  if (start === -1) return { room: text, addressed: "" };
  return {
    room: lines.slice(0, start).join("\n"),
    addressed: lines.slice(start).join("\n")
  };
}

describe("a steer addressed to one agent is framed for its human (T067)", () => {
  let ws: TestWorkspace;
  let aliceWeb: WebHandle | undefined;
  let rendered = "";

  beforeAll(async () => {
    ws = await twoMemberWorkspace();
    aliceWeb = await startWeb(ws.alice);

    // Alice's human steers bob's agent directly.
    const steer = await apiPost(aliceWeb, "/api/post", {
      type: "question",
      body: STEER_BODY,
      sender_kind: "human",
      target: "bob"
    });
    expect(steer.status).toBe(200);

    // Alice's agent also says something to the whole room.
    const chatter = await ws.alice.daemon.post(
      { type: "status", body: CHATTER_BODY, refs: [] },
      "agent"
    );
    expect(chatter.ok).toBe(true);

    await waitFor(() => {
      const bodies = ws.bob.daemon.messages(0).messages.map((m) => m.body);
      return bodies.includes(STEER_BODY) && bodies.includes(CHATTER_BODY);
    }, "bob's daemon to receive both messages");

    // Render through the same path the UserPromptSubmit hook uses.
    rendered = renderContext("prompt-submit", ws.bob.daemon.inject("prompt-submit", "continue"));
  });

  afterAll(async () => {
    await aliceWeb?.close();
    await ws.close();
  });

  it("puts the targeted message in its own addressed-to-you block", () => {
    expect(rendered).toContain(ADDRESSED_HEADING);
    const { addressed } = splitBlocks(rendered);
    expect(addressed).toContain(STEER_BODY);
    expect(addressed).toContain("→ bob");
  });

  it("names the sender and the sender kind", () => {
    const { addressed } = splitBlocks(rendered);
    expect(addressed).toContain("alice");
    expect(addressed).toContain("(human)");
  });

  it("orders the agent to raise a conflict with its own human", () => {
    const { addressed } = splitBlocks(rendered);
    expect(addressed).toMatch(/conflicts with your work/i);
    expect(addressed).toMatch(/ask your human what to do/i);
    expect(addressed).toMatch(/Do not comply in silence/i);
  });

  it("leaves an untargeted message in the ordinary room list", () => {
    const { room, addressed } = splitBlocks(rendered);
    expect(room).toContain("New room messages since your last turn");
    expect(room).toContain(CHATTER_BODY);
    expect(addressed).not.toContain(CHATTER_BODY);
  });

  it("never shows the same message in both blocks", () => {
    const { room } = splitBlocks(rendered);
    expect(room).not.toContain(STEER_BODY);
    expect(rendered.split(STEER_BODY).length - 1).toBe(1);
  });
});
