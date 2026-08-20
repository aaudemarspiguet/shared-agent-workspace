// Run summary mechanics for the Stop hook (T039).
// Counts and git refs only. File paths and file contents never appear here.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { RunWhat } from "@saw/shared";

/**
 * Count tool uses per tool name from a Claude Code transcript (JSONL).
 * Lines that do not parse are skipped. The counter never throws.
 */
export function countToolUses(transcriptText: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of transcriptText.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = (entry as { message?: { content?: unknown } }).message;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: string; name?: string };
      if (p.type === "tool_use" && typeof p.name === "string") {
        counts[p.name] = (counts[p.name] ?? 0) + 1;
      }
    }
  }
  return counts;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
  } catch {
    return undefined;
  }
}

/**
 * The paths SAW writes itself.
 *
 * `saw up` creates `.saw/`, writes the hook entries into
 * `.claude/settings.json`, and appends the ignore lines to `.gitignore`.
 * Git reports all three, so a run that changed nothing else reported
 * several files changed. They are SAW's own footprint, never the work of
 * the run (T078).
 */
const SAW_OWN_PATHS = [".saw", ".claude", ".gitignore"];

/** True when a status path belongs to SAW itself. */
function isSawOwnPath(path: string): boolean {
  const clean = path.endsWith("/") ? path.slice(0, -1) : path;
  return SAW_OWN_PATHS.some((own) => clean === own || clean.startsWith(`${own}/`));
}

/**
 * The path of one `git status --porcelain` line.
 * The first three characters are the two status letters and a space. A
 * rename reads `ORIG -> NEW`; the new path is the one that changed. Git
 * quotes a path that holds an unusual character.
 */
function statusPath(line: string): string {
  const rest = line.slice(3);
  const arrow = rest.lastIndexOf(" -> ");
  const path = arrow === -1 ? rest : rest.slice(arrow + 4);
  const trimmed = path.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

/**
 * Count the files one run changed, from `git status --porcelain` output.
 *
 * Counts only. A path never leaves this function (Principle II).
 */
export function countChangedFiles(porcelain: string): number {
  const changed = new Set<string>();
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    // `!!` is an ignored file. It is build output or local state, not work.
    if (line.startsWith("!!")) continue;
    const path = statusPath(line);
    if (!path || isSawOwnPath(path)) continue;
    changed.add(path);
  }
  return changed.size;
}

/** Collect branch name, head SHA, and the changed-file count. */
export function gitWhat(cwd: string): Pick<RunWhat, "branch" | "head" | "files_changed"> {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  // `--untracked-files=all` lists each new file. The default collapses a new
  // directory into one entry, which would count a whole feature as one file
  // and would also hide the SAW paths inside a directory that is new.
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  return {
    branch: branch && branch !== "HEAD" ? branch : undefined,
    head: head || undefined,
    files_changed: status === undefined ? undefined : countChangedFiles(status)
  };
}

/** Build the full mechanical "what" for one finished run. */
export function composeRunWhat(transcriptPath: string | undefined, cwd: string): RunWhat {
  let counts: Record<string, number> = {};
  if (transcriptPath) {
    try {
      counts = countToolUses(readFileSync(transcriptPath, "utf8"));
    } catch {
      counts = {};
    }
  }
  return { tools_used: counts, ...gitWhat(cwd) };
}
