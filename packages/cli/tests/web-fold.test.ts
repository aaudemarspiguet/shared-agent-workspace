// The page's fold, run for real. The other web tests read app.js as text;
// this one lifts the two pure functions out of it and executes them, because
// three reviewers found the fold's bugs by running it and none by reading it.
// No DOM is involved: splitPost and sentenceCount touch only strings.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATIC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "static");
const js = readFileSync(join(STATIC, "app.js"), "utf8");

function lift(name: string): string {
  const m = js.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`));
  if (!m) throw new Error(`${name} is not in app.js`);
  return m[0];
}

const splitPost = new Function(`${lift("sentenceCount")}\n${lift("splitPost")}\nreturn splitPost;`)() as (
  body: string
) => { summary: string; rest: string };

describe("the fold, executed", () => {
  it("shows a summary-only post whole, with nothing to open", () => {
    const out = splitPost("The fix is in. Nothing for you to press. The other agent can merge.");
    expect(out.summary).toBe("The fix is in. Nothing for you to press. The other agent can merge.");
    expect(out.rest).toBe("");
  });

  it("shows a registered post's summary whole and folds only the details", () => {
    const out = splitPost("Done, and it needs your review as PR 233.\n\nT155 at 9190b75; mirror re-derives.");
    expect(out.summary).toBe("Done, and it needs your review as PR 233.");
    expect(out.rest).toBe("T155 at 9190b75; mirror re-derives.");
  });

  it("a six-sentence summary of ordinary length shows whole", () => {
    const six = Array.from({ length: 6 }, (_, i) => `Sentence number ${i} says a normal amount of things about the work.`).join(" ");
    expect(splitPost(`${six}\n\ndetails`).summary).toBe(six);
  });

  it("an old wall of eight sentences folds to its first sentence, not the wall", () => {
    const wall = Array.from({ length: 8 }, (_, i) => `Old style sentence ${i}.`).join(" ");
    const out = splitPost(wall);
    expect(out.summary).toBe("Old style sentence 0.");
    expect(out.rest.startsWith("Old style sentence 1.")).toBe(true);
  });

  it("skips a shouted heading and a bare greeting before the paragraph split", () => {
    expect(splitPost("STATUS UPDATE\n\nThe fix is in. More.").summary).toBe("The fix is in. More.");
    expect(splitPost("shrey -\n\nMerged the branch. Next is tests.").summary).toBe(
      "Merged the branch. Next is tests."
    );
  });

  it("never repeats the summary inside the details", () => {
    const out = splitPost("One. Two.\n\nThree.");
    expect(out.rest).not.toContain("One.");
  });

  it("cuts a run-on legacy wall at a word boundary", () => {
    // Over the paragraph cap and never punctuated: the legacy path, cut
    // at a space rather than mid-word.
    const long = "word ".repeat(250).trim();
    const out = splitPost(long);
    expect(out.summary.endsWith("…")).toBe(true);
    expect(out.summary).not.toMatch(/wor…$/);
    expect(out.rest).toBe(long);
  });

  it("shows a short unpunctuated line whole rather than cutting it", () => {
    const line = "merged the branch and the tests are green";
    expect(splitPost(line).summary).toBe(line);
  });
});
