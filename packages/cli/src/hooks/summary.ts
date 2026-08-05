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

/** Collect branch name, head SHA, and the changed-file count. */
export function gitWhat(cwd: string): Pick<RunWhat, "branch" | "head" | "files_changed"> {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const status = git(cwd, ["status", "--porcelain"]);
  const filesChanged =
    status === undefined ? undefined : status.split("\n").filter((l) => l.trim()).length;
  return {
    branch: branch && branch !== "HEAD" ? branch : undefined,
    head: head || undefined,
    files_changed: filesChanged
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
