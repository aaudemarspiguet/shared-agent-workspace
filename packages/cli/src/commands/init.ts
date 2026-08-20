// saw init and saw invite.
// init creates the workspace. invite mints a signed join link. Creator only.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_WEB_PORT,
  appendGitignore,
  readCredential,
  readMemberConfig,
  readSharedConfig,
  resolveRepoRoot,
  resolveRepoRemote,
  sawDir,
  writeConfig,
  writeCredential
} from "../config.js";
import { mintInvite, registerWorkspace, relayUrls } from "../relay-http.js";
import { renderAgentMd } from "../templates/agent-md.js";

export const DEFAULT_RELAY_URL = "ws://localhost:8787";

/** Exit codes from contracts/cli.md. */
export const EXIT_USER_ERROR = 1;
export const EXIT_ENV_ERROR = 2;

export function fail(message: string, code: number): never {
  console.error(`saw: ${message}`);
  process.exit(code);
}

/** Find the GitHub username: flag first, then git config github.user. */
export function resolveGithubUsername(flag: string | undefined, root: string): string {
  if (flag) return flag;
  try {
    const out = execFileSync("git", ["config", "github.user"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString("utf8")
      .trim();
    if (out) return out;
  } catch {
    // Not set. Fall through to the error.
  }
  fail(
    "GitHub username is not known. Pass --github <username>, or set it once with: git config github.user <username>",
    EXIT_USER_ERROR
  );
}

/**
 * Say why `saw init` must stop, or return undefined when it can continue.
 *
 * A second init makes a different workspace. It overwrites .saw/config.json
 * and .saw/credential. Git ignores the credential, so no clone and no server
 * keeps a copy: the old workspace is then closed for this member forever.
 * Because of that, init refuses by default.
 */
export function initGuardMessage(root: string): string | undefined {
  const shared = readSharedConfig(root);
  if (!shared) return undefined;
  const name = shared.workspace_name || shared.workspace_id;
  const lines = [
    `this repository is already in the SAW workspace "${name}" (id ${shared.workspace_id}).`,
    "A second init makes a different workspace. It overwrites .saw/config.json and",
    "your .saw/credential, and nobody can get the old credential back.",
    ""
  ];
  if (readCredential(root)) {
    lines.push("  To start the workspace:  saw up");
    lines.push("  To add your teammate:    saw invite --github <their-username>");
  } else {
    lines.push("  git gave this clone the workspace file. You are not a member yet.");
    lines.push("  To become a member:      saw join <invite-link>");
  }
  lines.push(
    "  To make a new workspace and lose this one: delete .saw/config.json and",
    "  .saw/credential first, then run saw init again."
  );
  return lines.join("\n");
}

/**
 * Say why `saw join` must stop, or return undefined when it can continue.
 *
 * A clone with only the committed .saw/config.json can join. That is the
 * normal flow. A clone that already holds a credential is a member, and a
 * second join overwrites that credential.
 */
export function joinGuardMessage(root: string): string | undefined {
  const shared = readSharedConfig(root);
  if (!shared || !readCredential(root)) return undefined;
  const name = shared.workspace_name || shared.workspace_id;
  const member = readMemberConfig(root);
  const who = member ? ` as ${member.github_username}` : "";
  return [
    `this clone is already a member of the SAW workspace "${name}"${who}.`,
    "A second join overwrites your .saw/credential, and nobody can get the old",
    "credential back.",
    "",
    "  To start the workspace:  saw up",
    "  To join with a new invite and lose the old credential: delete .saw/credential",
    "  first, then run saw join again."
  ].join("\n");
}

/** Write config, credential, and AGENT.md. Shared by init and join. */
export function writeMemberFiles(
  root: string,
  params: {
    workspaceId: string;
    workspaceName: string;
    relayUrl: string;
    github: string;
    repoRemote: string;
    members: string[];
    token: string;
  }
): void {
  writeConfig(root, {
    workspace_id: params.workspaceId,
    workspace_name: params.workspaceName,
    relay_url: params.relayUrl,
    github_username: params.github,
    repo_remote: params.repoRemote,
    branch_prefix: `${params.github}/`,
    members: params.members,
    web_port: DEFAULT_WEB_PORT
  });
  writeCredential(root, params.token);
  writeFileSync(
    join(sawDir(root), "AGENT.md"),
    renderAgentMd({
      workspaceName: params.workspaceName,
      githubUsername: params.github,
      branchPrefix: `${params.github}/`
    })
  );
  appendGitignore(root);
}

export interface InitOptions {
  name: string;
  relay?: string;
  github?: string;
  /** Make a new workspace even when this repository has one. It loses the old. */
  force?: boolean;
}

export async function runInit(options: InitOptions): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) {
    fail("this directory is not inside a git repository", EXIT_ENV_ERROR);
  }
  // Refuse before any file write and before the relay call. A repository
  // keeps one workspace.
  const blocked = options.force ? undefined : initGuardMessage(root);
  if (blocked) {
    fail(blocked, EXIT_USER_ERROR);
  }
  const remote = resolveRepoRemote(root);
  if (!remote) {
    fail(
      "this repository has no remote. Add one first: git remote add origin <url>",
      EXIT_ENV_ERROR
    );
  }
  const github = resolveGithubUsername(options.github, root);
  const relay = options.relay ?? DEFAULT_RELAY_URL;
  const urls = relayUrls(relay);

  const registered = await registerWorkspace(urls.http, options.name, remote, github);
  if (!registered.ok) {
    fail(`workspace registration failed: ${registered.error}`, EXIT_ENV_ERROR);
  }

  writeMemberFiles(root, {
    workspaceId: registered.value.workspace_id,
    workspaceName: options.name,
    relayUrl: relay,
    github,
    repoRemote: remote,
    members: [github],
    token: registered.value.token
  });

  console.log(`Workspace "${options.name}" is ready.`);
  console.log(`Member: ${github} (creator)`);
  console.log(`Relay: ${relay}`);
  console.log("");
  console.log("Files written:");
  console.log("  .saw/config.json    — shared workspace settings. Commit this file.");
  console.log("  .saw/member.json    — your username and branch prefix. Git ignores it.");
  console.log("  .saw/credential     — your token. Git ignores this file. Never share it.");
  console.log("  .saw/AGENT.md       — instructions for your agent. Git ignores it.");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Commit .saw/config.json only. Your teammate needs that file. The");
  console.log("     other three files are yours alone. Their saw join writes their own.");
  console.log("  2. Invite your teammate: saw invite --github <their-username>");
  console.log("  3. Start SAW: saw up");
}

export interface InviteOptions {
  github: string;
  expires?: string;
}

/** Parse an --expires value like "72h" or "48" (hours). */
export function parseExpiresHours(value: string | undefined): number {
  if (!value) return 72;
  const match = /^(\d+)h?$/.exec(value.trim());
  if (!match || !match[1]) {
    fail(`--expires must be a number of hours, like 72h. Got: ${value}`, EXIT_USER_ERROR);
  }
  return Number(match[1]);
}

export async function runInvite(options: InviteOptions): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) {
    fail("this directory is not inside a git repository", EXIT_ENV_ERROR);
  }
  const config = readSharedConfig(root);
  const token = readCredential(root);
  if (!config || !token) {
    fail("this repository has no SAW workspace. Run saw init first.", EXIT_ENV_ERROR);
  }
  const hours = parseExpiresHours(options.expires);
  const urls = relayUrls(config.relay_url);
  const minted = await mintInvite(
    urls.http,
    config.workspace_id,
    token,
    options.github,
    hours
  );
  if (!minted.ok) {
    fail(`invite mint failed: ${minted.error}`, EXIT_USER_ERROR);
  }
  console.log(`Invite for ${options.github} (valid ${hours}h):`);
  console.log("");
  console.log(`  ${minted.value}`);
  console.log("");
  console.log("Send this link to your teammate. They run, in their clone:");
  console.log(`  saw join "${minted.value}" --github ${options.github}`);
}
