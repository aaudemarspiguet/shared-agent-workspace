// saw init and saw invite.
// init creates the workspace. invite mints a signed join link. Creator only.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_WEB_PORT,
  appendGitignore,
  readConfig,
  readCredential,
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
}

export async function runInit(options: InitOptions): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) {
    fail("this directory is not inside a git repository", EXIT_ENV_ERROR);
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
  console.log("  .saw/config.json    — workspace settings. Commit this file.");
  console.log("  .saw/credential     — your token. Git ignores this file. Never share it.");
  console.log("  .saw/AGENT.md       — instructions for your coding agent.");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Commit .saw/config.json and .saw/AGENT.md so your teammate gets them.");
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
  const config = readConfig(root);
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
