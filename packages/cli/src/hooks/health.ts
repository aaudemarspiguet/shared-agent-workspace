// Is this repository's agent integration actually wired (FR-047)?
//
// `installHooks` writes the four hook entries on `saw up` and reports what it
// added. That report is a moment in time: it says nothing an hour later, and
// nothing at all to a surface that did not run the install. The developer
// console needs the standing answer instead — which of the four events are
// wired right now, and whether they still point at THIS checkout.
//
// The second half is the failure that actually happens. The hook command
// holds an absolute path to this member's node and this member's repository
// (see the note at the top of install.ts). Move or rename the checkout and
// every hook keeps parsing, keeps looking installed, and silently runs
// nothing — so a console that only counted entries would report health while
// the integration was dead. This reads the file and compares.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sawHookCommandBase } from "./install.js";

/** The four events, in the order the contract lists them. */
const HOOK_SUBS: { event: string; sub: string }[] = [
  { event: "SessionStart", sub: "session-start" },
  { event: "UserPromptSubmit", sub: "prompt-submit" },
  { event: "PreToolUse", sub: "pre-tool" },
  { event: "Stop", sub: "stop" }
];

export interface HookReport {
  /** The event name, as the settings file spells it. */
  event: string;
  /** A hook entry for this event exists. */
  wired: boolean;
  /** That entry calls the saw of this checkout, not another one. */
  current: boolean;
}

export interface IntegrationHealth {
  /** Absolute path of the settings file the hooks live in. */
  settings_path: string;
  /** The settings file exists and parses. */
  settings_readable: boolean;
  hooks: HookReport[];
  /** All four wired and pointing here. The console's single green light. */
  ok: boolean;
}

interface HookEntry {
  command?: unknown;
}
interface HookGroup {
  hooks?: HookEntry[];
}

/**
 * Read the hook wiring for one repository. Never throws and never writes:
 * a console read must not repair the thing it is reporting on, or it can
 * never report a problem.
 */
export function readIntegrationHealth(
  root: string,
  commandBase = safeCommandBase()
): IntegrationHealth {
  const settingsPath = join(root, ".claude", "settings.local.json");
  let parsed: Record<string, HookGroup[]> | null = null;
  try {
    const file = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks?: Record<string, HookGroup[]>;
    };
    parsed = file.hooks ?? {};
  } catch {
    // Missing, unreadable, or not JSON. All three mean "not wired here".
    parsed = null;
  }

  const hooks = HOOK_SUBS.map(({ event, sub }) => {
    const groups = parsed?.[event] ?? [];
    const commands = groups
      .flatMap((group) => group.hooks ?? [])
      .map((entry) => entry.command)
      .filter((command): command is string => typeof command === "string")
      .filter((command) => command.includes(`hook ${sub}`));
    return {
      event,
      wired: commands.length > 0,
      // `commandBase` is "" when it could not be resolved. Claiming every
      // hook is stale would be worse than saying nothing, so an unknown
      // base leaves a wired hook reported as current.
      current:
        commands.length > 0 &&
        (commandBase === "" || commands.some((c) => c.startsWith(commandBase)))
    };
  });

  return {
    settings_path: settingsPath,
    settings_readable: parsed !== null,
    hooks,
    ok: hooks.every((h) => h.wired && h.current)
  };
}

/** The command base, or "" when this process cannot work it out. */
function safeCommandBase(): string {
  try {
    return sawHookCommandBase();
  } catch {
    return "";
  }
}
