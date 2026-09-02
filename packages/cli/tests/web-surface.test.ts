// The web page's own wiring (T145-T147).
//
// app.js has no DOM tests, and adding a browser environment to this project
// is a dependency decision, not a task decision. But the failure a surface
// rewrite actually causes needs no browser to catch: the script asks for an
// element the markup no longer has, the call returns null, and the page dies
// on the first line that touches it — silently, because nothing here runs
// during `npm test`. These read the two files as text and check they agree.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATIC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "static");
const html = readFileSync(join(STATIC, "index.html"), "utf8");
const js = readFileSync(join(STATIC, "app.js"), "utf8");
const css = readFileSync(join(STATIC, "style.css"), "utf8");

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

describe("the web surface's wiring", () => {
  it("defines every element the script looks up", () => {
    const declared = new Set(matches(html, /\bid="([^"]+)"/g));
    const used = new Set([
      ...matches(js, /\$\("([^"]+)"\)/g),
      ...matches(js, /getElementById\("([^"]+)"\)/g)
    ]);
    const missing = [...used].filter((id) => !declared.has(id)).sort();
    expect(missing).toEqual([]);
  });

  it("points every tab at a panel that exists", () => {
    const tabs = matches(html, /class="tab[^"]*"\s+data-tab="([^"]+)"/g);
    expect(tabs.length).toBeGreaterThan(0);
    const declared = new Set(matches(html, /\bid="([^"]+)"/g));
    tabs.forEach((tab) => expect(declared.has(tab)).toBe(true));
  });

  // The scroll chain #213 fixed, asserted rather than trusted: .panel hides
  // its overflow, so the feed can only scroll if every box between it and
  // the panel gives up a bounded height. T145 rebuilt this area; a silent
  // return of the unscrollable feed is the regression to catch.
  it("keeps the flex chain that lets the feed scroll", () => {
    expect(css).toMatch(/\.room-layout\s*\{[^}]*flex:\s*1/);
    expect(css).toMatch(/\.room-layout\s*\{[^}]*min-height:\s*0/);
    expect(css).toMatch(/\.room-main\s*\{[^}]*flex-direction:\s*column/);
    expect(css).toMatch(/\.room-main\s*\{[^}]*min-height:\s*0/);
    expect(css).toMatch(/\.feed\s*\{[^}]*flex:\s*1/);
    expect(css).toMatch(/\.feed\s*\{[^}]*overflow-y:\s*auto/);
  });

  // The console is a document, not a feed. .panel's overflow: hidden would
  // cut it off at the fold with no way to reach the rest.
  it("lets the console scroll on its own", () => {
    expect(css).toMatch(/#console\s*\{[^}]*overflow-y:\s*auto/);
  });

  // The mention treatment an addressed message gets (T146, FR-045).
  it("styles an addressed message as a mention", () => {
    expect(js).toContain('m.target === state.me');
    expect(css).toMatch(/\.msg\.mention/);
  });

  // No inline script or style: the page is served under a strict CSP, and
  // either one would be blocked with no error the member can see.
  it("keeps script and style out of the markup", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\son[a-z]+="/);
  });
});
