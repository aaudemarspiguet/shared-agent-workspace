// Hook registration (part of T021).
// saw up writes the four hook entries into the repo's .claude/settings.json.
// The merge keeps every setting that is already there.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface HookCommand {
  type: "command";
  command: string;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
  [key: string]: unknown;
}

type HooksConfig = Record<string, HookGroup[]>;

interface SettingsFile {
  hooks?: HooksConfig;
  [key: string]: unknown;
}

/**
 * Find how the hook entries must call saw.
 * Use plain "saw" when it is on PATH. Fall back to the absolute script path.
 */
export function sawHookCommandBase(): string {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["saw"], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    return "saw";
  } catch {
    const script = resolve(process.argv[1] ?? "saw");
    return `"${process.execPath}" "${script}"`;
  }
}

/** The four hook events and their saw subcommands (contracts/hooks-adapter.md). */
const HOOK_EVENTS: { event: string; sub: string; matcher?: string }[] = [
  { event: "SessionStart", sub: "session-start" },
  { event: "UserPromptSubmit", sub: "prompt-submit" },
  { event: "PreToolUse", sub: "pre-tool", matcher: "*" },
  { event: "Stop", sub: "stop" }
];

export interface InstallResult {
  path: string;
  added: string[];
  present: string[];
}

/** Install or verify the four hook entries. Idempotent. */
export function installHooks(root: string, commandBase = sawHookCommandBase()): InstallResult {
  const path = join(root, ".claude", "settings.json");
  let settings: SettingsFile = {};
  try {
    settings = JSON.parse(readFileSync(path, "utf8")) as SettingsFile;
  } catch {
    // No settings file yet. Start from an empty one.
  }
  const hooks: HooksConfig = settings.hooks ?? {};
  const added: string[] = [];
  const present: string[] = [];

  for (const { event, sub, matcher } of HOOK_EVENTS) {
    const groups = hooks[event] ?? [];
    const has = groups.some((group) =>
      (group.hooks ?? []).some(
        (h) => typeof h.command === "string" && h.command.includes(`hook ${sub}`)
      )
    );
    if (has) {
      present.push(event);
      continue;
    }
    const group: HookGroup = {
      hooks: [{ type: "command", command: `${commandBase} hook ${sub}` }]
    };
    if (matcher) group.matcher = matcher;
    groups.push(group);
    hooks[event] = groups;
    added.push(event);
  }

  if (added.length > 0) {
    settings.hooks = hooks;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  }
  return { path, added, present };
}
