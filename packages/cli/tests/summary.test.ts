// Unit tests for the Stop hook summary mechanics in hooks/summary.ts.
// The git tests run inside a fresh temp repo. The cleanup removes it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeRunWhat,
  countChangedFiles,
  countToolUses,
  gitWhat
} from "../src/hooks/summary.js";

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

/** Turn the temp root into a git repo with one commit that holds one file. */
function initRepo(): void {
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "tracked.txt"), "one\n");
  git(["add", "tracked.txt"]);
  git(["commit", "-m", "init"]);
}

/** Write the files that `saw up` leaves in a workspace. */
function writeSawFootprint(): void {
  mkdirSync(join(root, ".saw"), { recursive: true });
  writeFileSync(join(root, ".saw", "config.json"), "{}\n");
  writeFileSync(join(root, ".saw", "credential"), "token\n");
  writeFileSync(join(root, ".saw", "AGENT.md"), "rules\n");
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(root, ".gitignore"), ".saw/credential\n");
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

  it("counts a change to a tracked file", () => {
    initRepo();
    writeFileSync(join(root, "tracked.txt"), "two\n");
    expect(gitWhat(root).files_changed).toBe(1);
  });

  // The readiness run found this: a run that changed nothing reported
  // several files changed, because git listed the files SAW wrote itself.
  it("reports 0 for a clean repo that holds only the SAW footprint", () => {
    initRepo();
    writeSawFootprint();
    expect(gitWhat(root).files_changed).toBe(0);
  });

  it("counts real work next to the SAW footprint", () => {
    initRepo();
    writeSawFootprint();
    writeFileSync(join(root, "tracked.txt"), "two\n");
    writeFileSync(join(root, "feature.ts"), "export const a = 1;\n");
    expect(gitWhat(root).files_changed).toBe(2);
  });
});

describe("countChangedFiles", () => {
  it("skips SAW paths, ignored files, and blank lines", () => {
    const porcelain = [
      "?? .saw/",
      "?? .claude/settings.json",
      "?? .gitignore",
      " M .saw/config.json",
      "!! dist/bundle.js",
      " M src/app.ts",
      "A  src/new.ts",
      ""
    ].join("\n");
    expect(countChangedFiles(porcelain)).toBe(2);
  });

  it("counts a rename once, under its new path", () => {
    expect(countChangedFiles("R  src/old.ts -> src/new.ts")).toBe(1);
    expect(countChangedFiles("R  .saw/a.json -> .saw/b.json")).toBe(0);
  });

  it("counts a path that git quoted", () => {
    expect(countChangedFiles('?? "src/a file.ts"')).toBe(1);
  });

  it("reads a path after a two-letter status", () => {
    expect(countChangedFiles("MM src/app.ts")).toBe(1);
  });

  it("returns 0 for empty output", () => {
    expect(countChangedFiles("")).toBe(0);
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
