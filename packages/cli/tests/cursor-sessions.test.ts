// T106: one read cursor per coding-tool session (issues #68, #130).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadCursor } from "../src/daemon/cursor.js";
import { readState } from "../src/config.js";

let root: string;
function freshRoot(): string {
  root = mkdtempSync(join(tmpdir(), "saw-cursor-"));
  // The cursor writes .saw/state.json under the root.
  return root;
}
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("per-session read cursors", () => {
  it("keeps two concurrent sessions independent (the #68 defect)", () => {
    const cursor = new ReadCursor(freshRoot());
    // B is at seq 4 when A races ahead to 10. Before T106 there was one
    // shared cursor: A's ack moved it to 10 and B silently lost 5..10.
    cursor.advance(4, "session-b");
    cursor.advance(10, "session-a");
    expect(cursor.valueFor("session-a")).toBe(10);
    expect(cursor.valueFor("session-b")).toBe(4);
    // B catches up on its own schedule.
    cursor.advance(10, "session-b");
    expect(cursor.valueFor("session-b")).toBe(10);
  });

  it("starts a brand-new session at the floor, not at zero", () => {
    const cursor = new ReadCursor(freshRoot());
    cursor.advance(25, "session-a");
    // A session opened later must not replay history the member already saw.
    expect(cursor.valueFor("session-new")).toBe(25);
  });

  it("keeps the floor as the highest ack from any session", () => {
    const cursor = new ReadCursor(freshRoot());
    cursor.advance(10, "session-a");
    cursor.advance(7, "session-b");
    expect(cursor.value).toBe(10);
  });

  it("falls back to the legacy single cursor when no session is named", () => {
    const cursor = new ReadCursor(freshRoot());
    cursor.advance(5);
    expect(cursor.value).toBe(5);
    expect(cursor.valueFor(undefined)).toBe(5);
  });

  it("never moves a cursor backward", () => {
    const cursor = new ReadCursor(freshRoot());
    cursor.advance(10, "session-a");
    cursor.advance(3, "session-a");
    expect(cursor.valueFor("session-a")).toBe(10);
  });

  it("survives a restart", () => {
    const r = freshRoot();
    const first = new ReadCursor(r);
    first.advance(9, "session-a");
    const second = new ReadCursor(r);
    expect(second.valueFor("session-a")).toBe(9);
    expect(second.value).toBe(9);
  });

  it("caps the session map and drops the oldest", () => {
    const r = freshRoot();
    const cursor = new ReadCursor(r);
    for (let i = 1; i <= 55; i++) cursor.advance(i, `session-${i}`);
    const state = readState(r);
    const kept = Object.keys(state.sessions ?? {});
    expect(kept.length).toBe(50);
    // The oldest five fell off; a pruned session restarts at the floor.
    expect(kept).not.toContain("session-1");
    expect(cursor.valueFor("session-1")).toBe(cursor.value);
  });
});
