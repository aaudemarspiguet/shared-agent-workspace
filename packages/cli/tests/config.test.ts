// Unit tests for the .saw file helpers in config.ts.
// Each test gets a fresh temp dir. The cleanup removes it.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendGitignore,
  configPath,
  credentialPath,
  GITIGNORE_LINES,
  memberConfigPath,
  readConfig,
  readCredential,
  readMemberConfig,
  readSharedConfig,
  remotesMatch,
  writeConfig,
  writeCredential,
  writeSharedConfig,
  type SawConfig
} from "../src/config.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saw-unit-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const CONFIG: SawConfig = {
  workspace_id: "ws_123",
  workspace_name: "demo",
  relay_url: "http://127.0.0.1:8787",
  github_username: "alice",
  repo_remote: "git@github.com:acme/app.git",
  branch_prefix: "alice/",
  members: ["alice", "bob"],
  web_port: 7420
};

describe("credential", () => {
  it("writes the file with mode 0600 and reads the token back", () => {
    writeCredential(root, "tok_secret");
    const mode = statSync(credentialPath(root)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readCredential(root)).toBe("tok_secret");
  });

  it("keeps mode 0600 when the file is written again", () => {
    writeCredential(root, "tok_one");
    writeCredential(root, "tok_two");
    const mode = statSync(credentialPath(root)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readCredential(root)).toBe("tok_two");
  });
});

/** Write a raw JSON file, as an old version or as git would leave it. */
function writeRaw(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readRaw(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("config", () => {
  it("returns undefined when config.json is missing", () => {
    expect(readConfig(root)).toBeUndefined();
  });

  it("round-trips a config through write and read", () => {
    writeConfig(root, CONFIG);
    expect(readConfig(root)).toEqual(CONFIG);
  });

  it("keeps the member fields out of the shared file", () => {
    writeConfig(root, CONFIG);
    const shared = readRaw(configPath(root));
    expect(shared).not.toHaveProperty("github_username");
    expect(shared).not.toHaveProperty("branch_prefix");
    expect(shared.workspace_id).toBe("ws_123");
    const member = readRaw(memberConfigPath(root));
    expect(member).toEqual({ github_username: "alice", branch_prefix: "alice/" });
  });

  it("returns undefined when the clone has the shared file but no member", () => {
    // A fresh clone: git brought config.json, but this member did not join.
    writeSharedConfig(root, CONFIG);
    expect(readSharedConfig(root)?.workspace_id).toBe("ws_123");
    expect(readMemberConfig(root)).toBeUndefined();
    // It must not give the teammate's identity to this clone.
    expect(readConfig(root)).toBeUndefined();
  });

  it("loads a config written by the old single-file layout", () => {
    writeRaw(configPath(root), CONFIG);
    expect(readConfig(root)).toEqual(CONFIG);
    expect(readMemberConfig(root)).toEqual({
      github_username: "alice",
      branch_prefix: "alice/"
    });
  });

  it("fills a missing branch_prefix from the username in the old layout", () => {
    const old: Record<string, unknown> = { ...CONFIG };
    delete old.branch_prefix;
    writeRaw(configPath(root), old);
    expect(readConfig(root)?.branch_prefix).toBe("alice/");
  });

  it("moves the member fields out of an old config.json on the next write", () => {
    writeRaw(configPath(root), CONFIG);
    const loaded = readConfig(root);
    expect(loaded).toBeDefined();
    writeConfig(root, loaded as SawConfig);
    expect(readRaw(configPath(root))).not.toHaveProperty("github_username");
    expect(readRaw(memberConfigPath(root)).github_username).toBe("alice");
  });

  it("keeps each clone on its own identity when the shared file travels", () => {
    const other = mkdtempSync(join(tmpdir(), "saw-unit-b-"));
    try {
      writeConfig(root, CONFIG);
      writeConfig(other, { ...CONFIG, github_username: "bob", branch_prefix: "bob/" });
      // bob commits .saw/config.json and alice pulls it.
      writeRaw(configPath(root), readRaw(configPath(other)));
      expect(readConfig(root)?.github_username).toBe("alice");
      expect(readConfig(other)?.github_username).toBe("bob");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("remotesMatch", () => {
  it("matches the ssh and https forms of one GitHub repo", () => {
    expect(
      remotesMatch("git@github.com:acme/app.git", "https://github.com/acme/app.git")
    ).toBe(true);
  });

  it("ignores a .git suffix and a trailing slash", () => {
    expect(
      remotesMatch("https://github.com/acme/app.git", "https://github.com/acme/app")
    ).toBe(true);
    expect(
      remotesMatch("https://github.com/acme/app/", "https://github.com/acme/app")
    ).toBe(true);
  });

  it("matches relative and absolute paths to one bare repo by tail", () => {
    expect(remotesMatch("../remote.git", "/srv/git/remote.git")).toBe(true);
  });

  it("does not match different repos", () => {
    expect(
      remotesMatch("git@github.com:acme/app.git", "git@github.com:acme/other.git")
    ).toBe(false);
    expect(
      remotesMatch("https://github.com/acme/app.git", "https://gitlab.com/acme/app.git")
    ).toBe(false);
  });
});

describe("appendGitignore", () => {
  it("ignores the per-member files", () => {
    // These two name one member. Git must never carry them to the peer.
    expect(GITIGNORE_LINES).toContain(".saw/member.json");
    expect(GITIGNORE_LINES).toContain(".saw/AGENT.md");
    // The shared file stays committable.
    expect(GITIGNORE_LINES).not.toContain(".saw/config.json");
  });

  it("creates .gitignore with the .saw lines", () => {
    appendGitignore(root);
    const content = readFileSync(join(root, ".gitignore"), "utf8");
    for (const line of GITIGNORE_LINES) {
      expect(content, `line ${line} must appear`).toContain(line);
    }
  });

  it("adds nothing on a second call", () => {
    appendGitignore(root);
    appendGitignore(root);
    const content = readFileSync(join(root, ".gitignore"), "utf8");
    const count = content.split(".saw/credential").length - 1;
    expect(count).toBe(1);
  });
});
