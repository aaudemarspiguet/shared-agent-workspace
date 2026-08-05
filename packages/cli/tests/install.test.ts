// Unit tests for hook registration in hooks/install.ts.
// Each test gets a fresh temp root. The cleanup removes it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHooks } from "../src/hooks/install.js";

interface HookCommand {
  type: string;
  command: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

interface Settings {
  permissions?: { allow?: string[] };
  hooks?: Record<string, HookGroup[]>;
}

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saw-unit-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function settingsPath(): string {
  return join(root, ".claude", "settings.json");
}

function readSettings(): Settings {
  return JSON.parse(readFileSync(settingsPath(), "utf8")) as Settings;
}

describe("installHooks", () => {
  it("writes all four hook events into .claude/settings.json", () => {
    const result = installHooks(root, "saw");
    expect(result.added).toEqual(EVENTS);
    expect(result.path).toBe(settingsPath());

    const hooks = readSettings().hooks ?? {};
    expect(Object.keys(hooks).sort()).toEqual([...EVENTS].sort());
    expect(hooks.SessionStart?.[0]?.hooks[0]?.command).toBe("saw hook session-start");
    expect(hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe("saw hook prompt-submit");
    expect(hooks.PreToolUse?.[0]?.matcher).toBe("*");
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("saw hook pre-tool");
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe("saw hook stop");
  });

  it("adds nothing on a second call", () => {
    installHooks(root, "saw");
    const second = installHooks(root, "saw");
    expect(second.added).toEqual([]);
    expect(second.present).toEqual(EVENTS);

    const hooks = readSettings().hooks ?? {};
    for (const event of EVENTS) {
      expect(hooks[event], `${event} must keep one group`).toHaveLength(1);
    }
  });

  it("keeps existing settings and appends to an existing Stop event", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const existing = {
      permissions: { allow: ["Bash(x)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "custom" }] }] }
    };
    writeFileSync(settingsPath(), JSON.stringify(existing, null, 2) + "\n");

    const result = installHooks(root, "saw");
    expect(result.added).toEqual(EVENTS);

    const settings = readSettings();
    expect(settings.permissions).toEqual({ allow: ["Bash(x)"] });
    const stop = settings.hooks?.Stop ?? [];
    expect(stop).toHaveLength(2);
    expect(stop[0]?.hooks[0]?.command).toBe("custom");
    expect(stop[1]?.hooks[0]?.command).toBe("saw hook stop");
  });
});
