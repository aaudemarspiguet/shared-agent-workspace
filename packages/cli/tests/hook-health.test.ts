// The console's integration card is only worth having if it can report bad
// news (T147, FR-047). These drive the four states it can show: nothing
// wired, all wired here, wired to a checkout that has moved, and a settings
// file that does not parse.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIntegrationHealth } from "../src/hooks/health.js";

const BASE = '"C:\\node.exe" "C:\\repo\\saw"';
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"];
const SUBS = ["session-start", "prompt-submit", "pre-tool", "stop"];

let root: string;

function writeSettings(contents: string): void {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.local.json"), contents);
}

/** A settings file with every hook pointing at `base`. */
function settingsFor(base: string): string {
  const hooks: Record<string, unknown[]> = {};
  EVENTS.forEach((event, i) => {
    hooks[event] = [{ hooks: [{ type: "command", command: `${base} hook ${SUBS[i]}` }] }];
  });
  return JSON.stringify({ hooks });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saw-health-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readIntegrationHealth (T147)", () => {
  it("reports every hook unwired when there is no settings file", () => {
    const health = readIntegrationHealth(root, BASE);
    expect(health.settings_readable).toBe(false);
    expect(health.ok).toBe(false);
    expect(health.hooks).toHaveLength(4);
    expect(health.hooks.every((h) => !h.wired)).toBe(true);
    expect(health.hooks.map((h) => h.event)).toEqual(EVENTS);
  });

  it("reports healthy when all four are wired to this checkout", () => {
    writeSettings(settingsFor(BASE));
    const health = readIntegrationHealth(root, BASE);
    expect(health.settings_readable).toBe(true);
    expect(health.ok).toBe(true);
    expect(health.hooks.every((h) => h.wired && h.current)).toBe(true);
  });

  // The failure that actually happens: the checkout moves, every hook still
  // parses and still looks installed, and none of them run. Counting entries
  // would call this healthy.
  it("sees a hook that points at another checkout as wired but not current", () => {
    writeSettings(settingsFor('"C:\\node.exe" "C:\\old-repo\\saw"'));
    const health = readIntegrationHealth(root, BASE);
    expect(health.ok).toBe(false);
    expect(health.hooks.every((h) => h.wired)).toBe(true);
    expect(health.hooks.every((h) => h.current)).toBe(false);
  });

  it("misses one hook without claiming the other three are broken", () => {
    const hooks: Record<string, unknown[]> = {};
    EVENTS.slice(0, 3).forEach((event, i) => {
      hooks[event] = [{ hooks: [{ type: "command", command: `${BASE} hook ${SUBS[i]}` }] }];
    });
    writeSettings(JSON.stringify({ hooks }));
    const health = readIntegrationHealth(root, BASE);
    expect(health.ok).toBe(false);
    const stop = health.hooks.find((h) => h.event === "Stop");
    expect(stop?.wired).toBe(false);
    expect(health.hooks.filter((h) => h.wired && h.current)).toHaveLength(3);
  });

  it("treats a settings file that does not parse as unreadable, and does not throw", () => {
    writeSettings("{ not json");
    const health = readIntegrationHealth(root, BASE);
    expect(health.settings_readable).toBe(false);
    expect(health.ok).toBe(false);
  });

  // An unresolvable command base must not paint every hook red: saying
  // nothing beats saying something false.
  it("leaves a wired hook current when the command base is unknown", () => {
    writeSettings(settingsFor('"anything" "at all"'));
    const health = readIntegrationHealth(root, "");
    expect(health.ok).toBe(true);
  });

  it("never writes to the settings file it reads", () => {
    const health = readIntegrationHealth(root, BASE);
    expect(health.settings_path).toBe(join(root, ".claude", "settings.local.json"));
    // The read found nothing; it must not have created anything either.
    expect(readIntegrationHealth(root, BASE).settings_readable).toBe(false);
  });
});
