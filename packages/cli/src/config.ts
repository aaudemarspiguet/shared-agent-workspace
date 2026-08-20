// Local .saw/ files: config, credential, daemon info, and cursor state.
//
// Two files hold the settings. The split keeps one member out of the other
// member's clone:
//   .saw/config.json — the shared workspace settings. Every member has the
//                      same values. Commit this file.
//   .saw/member.json — the settings of this member only. Git ignores it.
// The credential file is a secret. Git ignores it too.
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

/**
 * The contents of .saw/config.json. The values are the same for every member,
 * so this file is safe to commit. It holds no name of one member.
 */
export interface SharedConfig {
  workspace_id: string;
  workspace_name: string;
  relay_url: string;
  repo_remote: string;
  /** Usernames of all known members. The join flow fills this in. */
  members: string[];
  web_port: number;
}

/**
 * The contents of .saw/member.json. The values name one member, so each
 * member has different values. Git must ignore this file. A committed
 * member.json gives your identity and your branch prefix to your teammate,
 * and their agent then works as you.
 */
export interface MemberConfig {
  github_username: string;
  branch_prefix: string;
}

/** The full settings for this member. `readConfig` merges the two files. */
export interface SawConfig extends SharedConfig, MemberConfig {}

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

// ---- config.json and member.json ----

export function configPath(root: string): string {
  return join(sawDir(root), "config.json");
}

export function memberConfigPath(root: string): string {
  return join(sawDir(root), "member.json");
}

/**
 * Read the shared settings. A clone that has the committed config.json but no
 * member yet gets a result here. Use this function when the command needs the
 * workspace, not the member: `saw join` and `saw invite` do.
 */
export function readSharedConfig(root: string): SharedConfig | undefined {
  const raw = readJson<Partial<SawConfig>>(configPath(root));
  if (!raw?.workspace_id) return undefined;
  return {
    workspace_id: raw.workspace_id,
    workspace_name: raw.workspace_name ?? raw.workspace_id,
    relay_url: raw.relay_url ?? "",
    repo_remote: raw.repo_remote ?? "",
    members: raw.members ?? [],
    web_port: raw.web_port ?? DEFAULT_WEB_PORT
  };
}

/**
 * Read the settings of this member from .saw/member.json.
 *
 * Upgrade path: a workspace made before the split kept these fields in
 * config.json. Read them from there when member.json is not present. A later
 * write puts them in the correct file.
 */
export function readMemberConfig(root: string): MemberConfig | undefined {
  const own = readJson<Partial<MemberConfig>>(memberConfigPath(root));
  if (own?.github_username) return completeMember(own);
  const legacy = readJson<Partial<SawConfig>>(configPath(root));
  if (legacy?.github_username) return completeMember(legacy);
  return undefined;
}

function completeMember(raw: Partial<MemberConfig>): MemberConfig | undefined {
  const username = raw.github_username;
  if (!username) return undefined;
  return {
    github_username: username,
    branch_prefix: raw.branch_prefix ?? `${username}/`
  };
}

/**
 * Read the full settings for this member: the shared file merged with the
 * personal file. Return undefined when either part is missing. A clone with
 * only the committed config.json has no member yet, so the caller must ask
 * for `saw join` and must not use the teammate's identity.
 */
export function readConfig(root: string): SawConfig | undefined {
  const shared = readSharedConfig(root);
  if (!shared) return undefined;
  const member = readMemberConfig(root);
  if (!member) return undefined;
  return { ...shared, ...member };
}

/** Write the shared file. It gets no field that names one member. */
export function writeSharedConfig(root: string, config: SharedConfig): void {
  writeJson(configPath(root), {
    workspace_id: config.workspace_id,
    workspace_name: config.workspace_name,
    relay_url: config.relay_url,
    repo_remote: config.repo_remote,
    members: config.members,
    web_port: config.web_port
  });
}

/** Write the personal file. Git ignores it. */
export function writeMemberConfig(root: string, config: MemberConfig): void {
  writeJson(memberConfigPath(root), {
    github_username: config.github_username,
    branch_prefix: config.branch_prefix
  });
}

/**
 * Write both files. This also upgrades a workspace made before the split:
 * the shared file loses the personal fields, and the personal file gets them.
 */
export function writeConfig(root: string, config: SawConfig): void {
  writeSharedConfig(root, config);
  writeMemberConfig(root, config);
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

// ---- log-spool.jsonl ----

/**
 * The local spool of run log entries the relay has not accepted yet (T055).
 *
 * The name is fixed and plain. It carries no member name, no workspace id,
 * and no token, so the name itself tells a reader nothing. The file holds
 * run metadata only: tool counts, a branch name, a head SHA, a changed-file
 * count, and the run trigger. It never holds file paths or file contents.
 */
export function logSpoolPath(root: string): string {
  return join(sawDir(root), "log-spool.jsonl");
}

/** Where the spool writes before it renames over the real file. */
export function logSpoolTempPath(root: string): string {
  return logSpoolPath(root) + ".tmp";
}

// ---- .gitignore ----

/**
 * Lines that keep member-local .saw files out of git.
 *
 * member.json and AGENT.md name one member. If git carries them to the other
 * clone, the teammate's `saw up` reports the wrong member, and their agent
 * gets the wrong branch prefix. Only .saw/config.json is shared.
 */
export const GITIGNORE_LINES = [
  ".saw/credential",
  ".saw/member.json",
  ".saw/AGENT.md",
  ".saw/daemon.json",
  ".saw/state.json",
  ".saw/log-spool.jsonl",
  ".saw/log-spool.jsonl.tmp",
  // `saw up` writes this member's hook entries here. The command inside holds
  // an absolute path to their own machine, so it is never shareable (T065).
  ".claude/settings.local.json"
];

const GITIGNORE_HEADER = "# SAW member-local files";

/**
 * Append the .saw ignore lines to the repo .gitignore. Skip lines already
 * there. The call is safe to repeat: a workspace made before a line existed
 * gets that line the next time any code path asks.
 */
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
  // Write the header once. An older clone already has it above its own lines.
  const header = have.has(GITIGNORE_HEADER) ? "" : GITIGNORE_HEADER + "\n";
  writeFileSync(path, next + header + missing.join("\n") + "\n");
}
