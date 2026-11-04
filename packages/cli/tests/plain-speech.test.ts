// Plain speech, moves 2 and 3: two registers in one post, and the same rule
// everywhere an agent reads instructions. The composition is a pure
// function, tested directly; the instruction text is read as text, in the
// house pattern.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composePost, MAX_SUMMARY_SENTENCES, sentenceCount } from "../src/mcp/plain-speech.js";
import { renderAgentMd } from "../src/templates/agent-md.js";
import { wakePrompt } from "../src/daemon/wake.js";
import { companionPrompt } from "../src/daemon/companion.js";
import { renderContext, type InjectResponse } from "../src/hooks/inject.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const appJs = readFileSync(join(HERE, "..", "src", "web", "static", "app.js"), "utf8");

describe("two registers in one post (composePost)", () => {
  it("stores the summary first, a blank line, then the details", () => {
    const out = composePost({ summary: "The fix is in.", details: "T155 at 9190b75; mirror re-derives." });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).toBe("The fix is in.\n\nT155 at 9190b75; mirror re-derives.");
    expect(out.note).toBeUndefined();
  });

  it("a summary alone is a whole post", () => {
    const out = composePost({ summary: "Done. Nothing for you to press." });
    expect(out.ok && out.body).toBe("Done. Nothing for you to press.");
  });

  it("an older caller's bare body passes through unchanged", () => {
    const out = composePost({ body: "#96 T155 seq 54 all the codes" });
    expect(out.ok && out.body).toBe("#96 T155 seq 54 all the codes");
  });

  it("summary plus body treats the body as the details", () => {
    const out = composePost({ summary: "Short.", body: "long technical text" });
    expect(out.ok && out.body).toBe("Short.\n\nlong technical text");
  });

  it("never refuses over style: a long summary gets one note and still posts", () => {
    const long = Array.from({ length: MAX_SUMMARY_SENTENCES + 3 }, (_, i) => `Sentence ${i}.`).join(" ");
    const out = composePost({ summary: long });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).toBe(long);
    expect(out.note).toMatch(/people read about 6/);
  });

  it("exactly six sentences draws no note", () => {
    const six = Array.from({ length: MAX_SUMMARY_SENTENCES }, (_, i) => `S ${i}.`).join(" ");
    const out = composePost({ summary: six });
    expect(out.ok && out.note).toBeUndefined();
  });

  it("refuses only on shape: an empty post, details with no summary, or more than the room takes", () => {
    expect(composePost({}).ok).toBe(false);
    // A technical wall with no part for the humans is not a post.
    const wall = composePost({ details: "T155 at 9190b75; mirror re-derives; see #96." });
    expect(wall.ok).toBe(false);
    if (!wall.ok) expect(wall.message).toMatch(/needs a summary/);
    const huge = composePost({ summary: "Ok.", details: "x".repeat(4100) });
    expect(huge.ok).toBe(false);
  });

  it("keeps the summary one paragraph, so none of it falls below the fold", () => {
    const out = composePost({ summary: "First half.\n\nSecond half.", details: "tech" });
    expect(out.ok && out.body).toBe("First half.\nSecond half.\n\ntech");
  });

  it("counts sentences the way a reader does", () => {
    expect(sentenceCount("One. Two! Three? Four")).toBe(4);
    expect(sentenceCount("Just one line with no period")).toBe(1);
  });
});

describe("the rule, everywhere an agent reads instructions", () => {
  it("the room rules name the two registers", () => {
    const text = renderAgentMd({ github: "alice", members: ["alice", "bob"] } as never);
    expect(text).toContain("`summary` is for them");
    expect(text).toContain("`details` is for the other agent");
    expect(text).toContain("One topic per post");
  });

  it("the wake prompt and the companion prompt ask for the same shape", () => {
    const wake = wakePrompt({ threadId: "t1", threadTitle: "x", reason: "own_message", sessionId: null });
    expect(wake).toContain("summary for the humans");
    const comp = companionPrompt("bob", {
      threadId: "t1",
      threadTitle: "x",
      asker: "alice",
      question: "where does it stand?",
      seq: 1
    });
    expect(comp).toContain("summary a person can read");
  });

  it("the inbox no longer opens every message with a code", () => {
    const data = {
      messages: [
        {
          id: "m1",
          seq: 96,
          sender: "alice",
          sender_kind: "agent",
          type: "status",
          body: "The fix is in.\n\nT155 details.",
          refs: [],
          sent_at: "2026-09-06T00:00:00.000Z",
          thread_id: null
        }
      ],
      notices: [],
      paused: false,
      work_items: [],
      me: "bob",
      ack_seq: 96,
      ack_notices: 0
    } as unknown as InjectResponse;
    const text = renderContext("prompt-submit", data);
    expect(text).not.toMatch(/^- #96/m);
    expect(text).toContain("- alice (agent) status, post 96: The fix is in.");
  });

  it("the page folds a registered post to its whole first paragraph", () => {
    expect(appJs).toContain("split(/\\n\\s*\\n/)");
    expect(appJs).toContain('addEventListener("hashchange"');
  });
});
