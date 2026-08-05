// Unit tests for the Stop hook summary mechanics in hooks/summary.ts.
// The git tests run inside a fresh temp repo. The cleanup removes it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeRunWhat, countToolUses, gitWhat } from "../src/hooks/summary.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saw-unit-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

/** Turn the temp root into a git repo with one empty commit. */
function initRepo(): void {
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["commit", "--allow-empty", "-m", "init"]);
}

describe("countToolUses", () => {
  it("counts tool_use parts by name and skips bad lines", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit" },
            { type: "text", text: "x" }
          ]
        }
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Edit" }] }
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash" }] }
      }),
      "{this line is not valid json",
      JSON.stringify({ type: "assistant", message: { content: "not an array" } })
    ];
    expect(countToolUses(lines.join("\n"))).toEqual({ Edit: 2, Bash: 1 });
  });

  it("returns an empty record for an empty transcript", () => {
    expect(countToolUses("")).toEqual({});
  });
});

describe("gitWhat", () => {
  it("reports branch, head, and files_changed for a fresh repo", () => {
    initRepo();
    const clean = gitWhat(root);
    expect(clean.branch).toBeDefined();
    expect(clean.head).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.files_changed).toBe(0);

    writeFileSync(join(root, "new-file.txt"), "hello\n");
    const dirty = gitWhat(root);
    expect(dirty.files_changed).toBe(1);
  });
});

describe("composeRunWhat", () => {
  it("returns empty tools_used when the transcript path is missing", () => {
    initRepo();
    const what = composeRunWhat(join(root, "no-such-transcript.jsonl"), root);
    expect(what.tools_used).toEqual({});
    expect(what.head).toMatch(/^[0-9a-f]{40}$/);
  });
});
