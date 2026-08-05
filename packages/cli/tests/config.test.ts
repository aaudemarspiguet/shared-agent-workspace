// Unit tests for the .saw file helpers in config.ts.
// Each test gets a fresh temp dir. The cleanup removes it.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendGitignore,
  credentialPath,
  GITIGNORE_LINES,
  readConfig,
  readCredential,
  remotesMatch,
  writeConfig,
  writeCredential,
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

describe("config", () => {
  it("returns undefined when config.json is missing", () => {
    expect(readConfig(root)).toBeUndefined();
  });

  it("round-trips a config through write and read", () => {
    writeConfig(root, CONFIG);
    expect(readConfig(root)).toEqual(CONFIG);
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
  it("creates .gitignore with the three .saw lines", () => {
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
