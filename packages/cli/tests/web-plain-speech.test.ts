// Plain speech, move 1: the page reads well before the agents write well.
// Same discipline as web-surface.test.ts - no browser here, so these read
// the static files as text and pin the decisions. Each fails against the
// page as it was before the fold.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATIC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "static");
const js = readFileSync(join(STATIC, "app.js"), "utf8");
const css = readFileSync(join(STATIC, "style.css"), "utf8");

describe("plain speech on the page", () => {
  it("folds an agent post to a headline with a details toggle", () => {
    expect(js).toMatch(/function headline\(/);
    expect(js).toContain('"details-toggle"');
    expect(css).toContain(".details-toggle");
  });

  it("the headline skips a shouted heading and a bare greeting line", () => {
    expect(js).toContain("l === l.toUpperCase()");
    expect(js).toMatch(/greeting = /);
  });

  it("a person's post shows in full and looks different from an agent's", () => {
    expect(js).toContain("from-human");
    expect(js).toContain("from-agent");
    expect(css).toContain(".msg.from-human");
    expect(css).toContain(".msg.from-agent");
  });

  it("no code in the head line: the post number lives under the words as a link", () => {
    expect(js).not.toContain('"#" + m.seq + " · "');
    expect(js).toContain('"seq-" + m.seq');
    expect(js).toContain('"postnum"');
  });

  it("the desktop notification says the headline, not the first 140 characters", () => {
    expect(js).toContain("const body = headline(m.body);");
    expect(js).not.toContain("m.body.slice(0, 140)");
  });
});
