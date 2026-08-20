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
 * How another program must call saw.
 *
 * `file` and `args` go straight into a spawn call, one argument per entry.
 * Use `sawCommandLine` when a settings file needs the command as one string.
 */
export interface SawCommand {
  /** The program to run. */
  file: string;
  /** The arguments that come before the saw subcommand. */
  args: string[];
  /** True when the plain name "saw" resolves on PATH. */
  onPath: boolean;
}

/** True when a name resolves on PATH. */
function resolvesOnPath(name: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [name], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find how another program must call saw.
 *
 * Use the plain name "saw" when it is on PATH. In the documented install saw
 * is NOT on PATH: it sits in node_modules/.bin of the repository. Fall back
 * to the node binary plus the absolute path of this script, which always
 * resolves. Every caller that writes a saw command into a file for another
 * program to run must use this, or that program gets ENOENT.
 */
export function resolveSawCommand(): SawCommand {
  if (resolvesOnPath("saw")) return { file: "saw", args: [], onPath: true };
  return {
    file: process.execPath,
    args: [resolve(process.argv[1] ?? "saw")],
    onPath: false
  };
}

/** The command as one string. Quote the parts that can hold a space. */
export function sawCommandLine(command: SawCommand = resolveSawCommand()): string {
  if (command.onPath) return command.file;
  return [command.file, ...command.args].map((part) => `"${part}"`).join(" ");
}

/** Find how the hook entries must call saw. */
export function sawHookCommandBase(): string {
  return sawCommandLine();
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
