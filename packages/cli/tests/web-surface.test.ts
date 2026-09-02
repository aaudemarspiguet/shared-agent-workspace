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

  // Every control the page offers must reach a route that exists. A button
  // wired to a misspelled or removed path fails only when a member presses
  // it, in a browser, with the error in a console nobody is watching — so
  // the page's routes are checked against the daemon's here (T154).
  it("calls only local API routes the daemon actually serves", () => {
    const api = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "daemon", "local-api.ts");
    const routes = readFileSync(api, "utf8");
    // Any "/api/..." literal in the page, however it reaches fetch. The
    // session controls pass their path through a helper rather than naming
    // it at the call site, and those are exactly the new ones.
    const called = new Set(matches(js, /"(\/api\/[^"?]*)"/g));
    expect(called.size).toBeGreaterThan(5);
    const unserved = [...called].filter((path) => !routes.includes(`"${path}"`)).sort();
    expect(unserved).toEqual([]);
  });

  // The session controls are consent, not decoration. If the panel stops
  // reading a member's OWN auto-mode state it silently shows everyone the
  // default, which would misreport whether consent had been given.
  it("reads auto mode from the member's own thread view", () => {
    expect(js).toContain("my_auto_mode");
    expect(css).toMatch(/\.auto-toggle\.on/);
  });

  // Items 3-7 of the UI plan agreed in the room. Each of these is a claim
  // about WHERE a control lives or WHAT SHAPE it has, and each was a real
  // complaint from a member using the page, so each gets an assertion that
  // fails if the control drifts back.

  // 3. The header says what the thread IS. The session controls grow tall
  // mid-session, and inside the header they pushed the title off the pane.
  it("keeps the session controls out of the thread header", () => {
    expect(html).toContain('id="session-strip"');
    // The panel is built into the lane, never appended to the header.
    expect(js).toMatch(/renderSessionStrip\(/);
    const header = js.slice(js.indexOf("function renderThreadHeader()"));
    expect(header).not.toMatch(/head\.appendChild\(\s*panel/);
  });

  // 4. Auto mode is standing consent (FR-050), so it must read as a switch
  // and cost a second press to give. Withdrawing it stays one press.
  it("makes auto mode a switch that asks before it turns on", () => {
    expect(js).toMatch(/setAttribute\("role", "switch"\)/);
    expect(js).toMatch(/aria-checked/);
    expect(js).toContain("auto-confirm");
    // Turning it off must not route through the confirmation.
    const fn = js.slice(js.indexOf("function autoModeSwitch("));
    const offFirst = fn.indexOf("enabled: false");
    const askFirst = fn.indexOf("auto-confirm");
    expect(offFirst).toBeGreaterThan(-1);
    expect(offFirst).toBeLessThan(askFirst);
  });

  // 5. A free number box asked members to invent a figure. The choices are
  // fixed, and the default stays DEFAULT_MAX_TURNS from packages/shared.
  it("offers turn budgets as choices rather than a number to type", () => {
    expect(js).not.toContain("turns-input");
    expect(js).toContain("budget-chip");
    expect(js).toMatch(/let chosen = 50;/);
  });

  // 6. Refs are unbounded and were printed flat into the header.
  it("collapses refs into a lineage that opens", () => {
    expect(js).toMatch(/function renderRefLineage\(/);
    expect(css).toContain(".lineage-list");
  });

  // 7. The mode control belongs where the member acts, and each option must
  // say what it costs. FR-037: it governs the agent, and only its own
  // member may set it — so the menu must never offer another member's.
  it("puts the mode control by the composer and says what each mode means", () => {
    expect(html).toContain('id="composer-mode"');
    const composer = html.slice(html.indexOf('<form id="composer"'));
    expect(composer).toContain('id="composer-mode"');
    expect(js).toMatch(/const MODES = \[/);
    ["Editing", "Commenting", "Viewing"].forEach((name) => expect(js).toContain(name));
    expect(js).toContain("Only you can set it.");
    // The control posts a thread id and a mode, never a member.
    const control = js.slice(js.indexOf("function renderModeControl("));
    const body = control.slice(0, control.indexOf("document.addEventListener"));
    expect(body).not.toMatch(/member:/);
  });

  // No inline script or style: the page is served under a strict CSP, and
  // either one would be blocked with no error the member can see.
  it("keeps script and style out of the markup", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\son[a-z]+="/);
  });
});
