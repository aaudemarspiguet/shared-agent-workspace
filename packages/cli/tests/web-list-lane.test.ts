// The list lane (seq 89 items 1 and 2): unread red dots, and a default
// view that answers "waiting on me". Same discipline as web-surface.test.ts:
// no browser environment here, so these read the static files as text and
// pin the decisions a refactor could silently undo. Each one fails against
// the pre-lane surface.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATIC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "static");
const js = readFileSync(join(STATIC, "app.js"), "utf8");
const css = readFileSync(join(STATIC, "style.css"), "utf8");

describe("the list lane: unread and waiting-on-you", () => {
  it("opens on the waiting view, not on everything", () => {
    expect(js).toMatch(/selection:\s*\{\s*mode:\s*"waiting"/);
  });

  it("lists Waiting on you before All activity", () => {
    const waiting = js.indexOf('"Waiting on you"');
    const all = js.indexOf('"All activity"');
    expect(waiting).toBeGreaterThan(-1);
    expect(all).toBeGreaterThan(-1);
    expect(waiting).toBeLessThan(all);
  });

  it("renders the unread dot, and the style for it exists", () => {
    expect(js).toContain('"unread-dot"');
    expect(css).toContain(".unread-dot");
    expect(css).toContain(".unread-dot.strong");
  });

  it("keeps seen-state guarded: storage can be absent without breaking", () => {
    // Every touch of the seen map goes through the two guarded helpers.
    expect(js).toContain('"saw-last-seen"');
    const guarded = js.match(/function seenMap\(\)[\s\S]*?catch/);
    expect(guarded).not.toBeNull();
  });

  it("a glance is not a read: aggregate views never mark seen", () => {
    // markThreadSeen is called from exactly three places: opening a thread
    // view, opening the broadcasts view, and a live arrival in the open
    // focused view. Nothing in the all/waiting branches touches it.
    const calls = js.match(/markThreadSeen\(/g) || [];
    expect(calls.length).toBe(4); // 3 call sites + the declaration
    expect(js).toMatch(/if \(mode === "thread"\) markThreadSeen\(threadId\);/);
    expect(js).toMatch(/if \(mode === "broadcasts"\) markThreadSeen\(""\);/);
  });

  it("the waiting filter is a real branch of the view filter", () => {
    expect(js).toMatch(/selection\.mode === "waiting"/);
    expect(js).toContain("Nothing is waiting on you.");
  });
});
