// Tests for the guards on `saw init` and `saw join`, and for the split of the
// shared config from the personal config.
//
// A second init made a new workspace and overwrote .saw/credential. The old
// credential is git-ignored, so the member lost the first workspace forever.
// A committed member identity made the peer's `saw up` report the wrong
// member. Both faults are user-visible, so these tests drive the commands,
// not the helpers alone.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configPath,
  memberConfigPath,
  readConfig,
  readCredential,
  sawDir,
  writeSharedConfig
} from "../src/config.js";
import {
  initGuardMessage,
  joinGuardMessage,
  runInit,
  writeMemberFiles
} from "../src/commands/init.js";
import { runJoin } from "../src/commands/join.js";

let root: string;
let startCwd: string;
let errors: string[];

/** The error thrown in place of process.exit, so a test can see the code. */
interface ExitError extends Error {
  exitCode?: number;
}

beforeEach(() => {
  startCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "saw-guard-"));
  errors = [];
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    const error = new Error(`process.exit(${code ?? 0})`) as ExitError;
    error.exitCode = code;
    throw error;
  }) as unknown as typeof process.exit);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  process.chdir(startCwd);
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Make a workspace in `dir` as `saw init` or `saw join` does. */
function makeWorkspace(dir: string, github: string, token: string): void {
  writeMemberFiles(dir, {
    workspaceId: "01KZMDSW0000000000000000",
    workspaceName: "demo",
    relayUrl: "ws://localhost:8787",
    github,
    repoRemote: "git@github.com:acme/app.git",
    members: [github],
    token
  });
}

/** Run a command that must stop, and give back the exit code. */
async function expectExit(run: () => Promise<void>): Promise<number | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as ExitError).exitCode;
  }
  throw new Error("the command did not stop");
}

describe("saw init in a repository that has a workspace", () => {
  it("refuses, keeps the credential, and keeps the workspace id", async () => {
    makeWorkspace(root, "alice", "tok_alice");
    const before = readFileSync(configPath(root), "utf8");
    process.chdir(root);

    const code = await expectExit(() => runInit({ name: "second-try" }));

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain('already in the SAW workspace "demo"');
    // The credential and the workspace id must be exactly as they were.
    expect(readCredential(root)).toBe("tok_alice");
    expect(readFileSync(configPath(root), "utf8")).toBe(before);
    expect(readConfig(root)?.workspace_id).toBe("01KZMDSW0000000000000000");
  });

  it("names the workspace and the safe commands", () => {
    makeWorkspace(root, "alice", "tok_alice");
    const message = initGuardMessage(root) ?? "";
    expect(message).toContain("demo");
    expect(message).toContain("01KZMDSW0000000000000000");
    expect(message).toContain("saw up");
    expect(message).toContain("saw invite");
  });

  it("asks a clone that is not a member to join, not to init", () => {
    // git brought config.json. This member has no credential yet.
    writeSharedConfig(root, {
      workspace_id: "01KZMDSW0000000000000000",
      workspace_name: "demo",
      relay_url: "ws://localhost:8787",
      repo_remote: "git@github.com:acme/app.git",
      members: ["alice"],
      web_port: 7420
    });
    const message = initGuardMessage(root) ?? "";
    expect(message).toContain("saw join");
    expect(message).not.toContain("saw invite");
  });

  it("lets init run when the repository has no workspace", () => {
    expect(initGuardMessage(root)).toBeUndefined();
  });

  it("passes the guard with --force and stops later, at the remote check", async () => {
    makeWorkspace(root, "alice", "tok_alice");
    process.chdir(root);

    const code = await expectExit(() => runInit({ name: "second-try", force: true }));

    // Exit 2 is the environment error from the remote check. It proves the
    // guard did not stop the run. No relay call happened.
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("no remote");
    expect(readCredential(root)).toBe("tok_alice");
  });
});

describe("saw join in a clone that is already a member", () => {
  it("refuses before it redeems the invite, and keeps the credential", async () => {
    makeWorkspace(root, "bob", "tok_bob");
    process.chdir(root);

    const code = await expectExit(() =>
      runJoin({ invite: "not-redeemed", github: "bob" })
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("already a member");
    expect(errors.join("\n")).toContain("bob");
    expect(readCredential(root)).toBe("tok_bob");
  });

  it("lets a clone with only the committed shared config join", () => {
    writeSharedConfig(root, {
      workspace_id: "01KZMDSW0000000000000000",
      workspace_name: "demo",
      relay_url: "ws://localhost:8787",
      repo_remote: "git@github.com:acme/app.git",
      members: ["alice"],
      web_port: 7420
    });
    expect(joinGuardMessage(root)).toBeUndefined();
  });
});

describe("two clones after init and join", () => {
  it("keeps each member on their own identity when config.json travels", () => {
    const bobRoot = mkdtempSync(join(tmpdir(), "saw-guard-bob-"));
    try {
      // alice runs saw init and commits .saw/config.json.
      makeWorkspace(root, "alice", "tok_alice");
      // bob clones. git gives him the shared file only.
      copyFileSync(configPath(root), pathIn(bobRoot, "config.json"));
      // bob runs saw join.
      writeMemberFiles(bobRoot, {
        workspaceId: "01KZMDSW0000000000000000",
        workspaceName: "demo",
        relayUrl: "ws://localhost:8787",
        github: "bob",
        repoRemote: "git@github.com:acme/app.git",
        members: ["alice", "bob"],
        token: "tok_bob"
      });
      // bob commits every file git still tracks. alice pulls.
      copyFileSync(configPath(bobRoot), configPath(root));

      expect(readConfig(root)?.github_username).toBe("alice");
      expect(readConfig(root)?.branch_prefix).toBe("alice/");
      expect(readConfig(bobRoot)?.github_username).toBe("bob");
      expect(readConfig(bobRoot)?.branch_prefix).toBe("bob/");
      // The agent file follows the member, not the commit.
      expect(agentMd(root)).toContain('Your member is "alice"');
      expect(agentMd(bobRoot)).toContain('Your member is "bob"');
      // Both clones still point at one workspace.
      expect(readConfig(root)?.workspace_id).toBe(readConfig(bobRoot)?.workspace_id);
      // The personal file exists in each clone, and git ignores it.
      expect(readFileSync(memberConfigPath(bobRoot), "utf8")).toContain("bob");
      const ignore = readFileSync(join(bobRoot, ".gitignore"), "utf8");
      expect(ignore).toContain(".saw/member.json");
      expect(ignore).toContain(".saw/AGENT.md");
    } finally {
      rmSync(bobRoot, { recursive: true, force: true });
    }
  });
});

/** A path inside .saw/ of a clone. The directory is made if it is missing. */
function pathIn(dir: string, name: string): string {
  mkdirSync(sawDir(dir), { recursive: true });
  return join(sawDir(dir), name);
}

function agentMd(dir: string): string {
  return readFileSync(join(sawDir(dir), "AGENT.md"), "utf8");
}
