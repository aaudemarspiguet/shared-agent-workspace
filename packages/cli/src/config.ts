// Local .saw/ files: config, credential, daemon info, and cursor state.
// The config file is safe to commit. The credential file is not.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

/** The contents of .saw/config.json. This file is safe to commit. */
export interface SawConfig {
  workspace_id: string;
  workspace_name: string;
  relay_url: string;
  github_username: string;
  repo_remote: string;
  branch_prefix: string;
  /** Usernames of all known members. The join flow fills this in. */
  members: string[];
  web_port: number;
}

/** Runtime info for a running daemon. Hooks and the MCP server read this. */
export interface DaemonInfo {
  port: number;
  pid: number;
  started_at: string;
  /**
   * The run token for the local surfaces (T057). A caller must present it on
   * every local API request and on the /ws handshake. Each run of `saw up`
   * makes a new one. The field is optional only so that a file written by an
   * older version still parses; a request with no token is refused.
   */
  token?: string;
}

/** Local daemon state that must survive restarts. */
export interface LocalState {
  /** Highest message seq already injected into the agent context. */
  last_injected_seq: number;
}

export const DEFAULT_WEB_PORT = 7420;

/**
 * Find the repository root for a directory.
 * Ask git first. Fall back to a walk up the tree that looks for .saw or .git.
 * Return undefined when there is no repository.
 */
export function resolveRepoRoot(cwd: string = process.cwd()): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const root = out.toString("utf8").trim();
    if (root) return root;
  } catch {
    // No git on PATH, or not a repository. Try the walk instead.
  }
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".saw")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Return the remote URL for `origin`, or the first remote, or undefined. */
export function resolveRepoRemote(root: string): string | undefined {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const url = out.toString("utf8").trim();
    if (url) return url;
  } catch {
    // No origin. Try the first remote below.
  }
  try {
    const list = execFileSync("git", ["remote"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const first = list[0];
    if (!first) return undefined;
    const out = execFileSync("git", ["remote", "get-url", first], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out.toString("utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function sawDir(root: string): string {
  return join(root, ".saw");
}

/**
 * Compare two git remote values that may point at the same repository.
 * The same repository can appear as ssh, https, or a filesystem path.
 * Reduce each form to a stable core before the comparison.
 */
export function remotesMatch(a: string, b: string): boolean {
  return normalizeRemote(a) === normalizeRemote(b);
}

function normalizeRemote(remote: string): string {
  let value = remote.trim().toLowerCase();
  value = value.replace(/\/+$/, "");
  value = value.replace(/\.git$/, "");
  // scp-like form: git@host:owner/repo
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(value);
  if (scp) return `${scp[1]}/${scp[2]}`;
  // URL forms: https://host/owner/repo, ssh://git@host/owner/repo
  const url = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(value);
  if (url) return `${url[1]}/${url[2]}`;
  // Filesystem path. Relative and absolute forms of one path cannot be
  // resolved against each other from a different clone. Compare the tail.
  const parts = value.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(value, null, 2) + "\n";
  if (mode === undefined) {
    writeFileSync(path, text, "utf8");
    return;
  }
  writeFileSync(path, text, { encoding: "utf8", mode });
  // chmod again: writeFileSync does not change the mode of an existing file.
  chmodSync(path, mode);
}

// ---- config.json ----

export function configPath(root: string): string {
  return join(sawDir(root), "config.json");
}

export function readConfig(root: string): SawConfig | undefined {
  return readJson<SawConfig>(configPath(root));
}

export function writeConfig(root: string, config: SawConfig): void {
  writeJson(configPath(root), config);
}

// ---- credential ----

export function credentialPath(root: string): string {
  return join(sawDir(root), "credential");
}

export function readCredential(root: string): string | undefined {
  try {
    const token = readFileSync(credentialPath(root), "utf8").trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/** Write the bearer token. Only the owner may read the file (mode 0600). */
export function writeCredential(root: string, token: string): void {
  const path = credentialPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token + "\n", { encoding: "utf8", mode: 0o600 });
  // chmod again: writeFileSync does not change the mode of an existing file.
  chmodSync(path, 0o600);
}

// ---- daemon.json ----

export function daemonInfoPath(root: string): string {
  return join(sawDir(root), "daemon.json");
}

export function readDaemonInfo(root: string): DaemonInfo | undefined {
  return readJson<DaemonInfo>(daemonInfoPath(root));
}

/**
 * Write the daemon info file. Only the owner may read it (mode 0600).
 * The file holds the run token for the local surfaces, so it is a secret.
 */
export function writeDaemonInfo(root: string, info: DaemonInfo): void {
  writeJson(daemonInfoPath(root), info, 0o600);
}

export function removeDaemonInfo(root: string): void {
  try {
    rmSync(daemonInfoPath(root));
  } catch {
    // Already gone. That is fine.
  }
}

// ---- state.json ----

export function statePath(root: string): string {
  return join(sawDir(root), "state.json");
}

export function readState(root: string): LocalState {
  return readJson<LocalState>(statePath(root)) ?? { last_injected_seq: 0 };
}

export function writeState(root: string, state: LocalState): void {
  writeJson(statePath(root), state);
}

// ---- .gitignore ----

/** Lines that keep member-local .saw files out of git. */
export const GITIGNORE_LINES = [
  ".saw/credential",
  ".saw/daemon.json",
  ".saw/state.json"
];

/** Append the .saw ignore lines to the repo .gitignore. Skip lines already there. */
export function appendGitignore(root: string): void {
  const path = join(root, ".gitignore");
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // No .gitignore yet. Create one below.
  }
  const have = new Set(current.split("\n").map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  const next =
    current.length === 0 || current.endsWith("\n") ? current : current + "\n";
  writeFileSync(path, next + "# SAW member-local files\n" + missing.join("\n") + "\n");
}
