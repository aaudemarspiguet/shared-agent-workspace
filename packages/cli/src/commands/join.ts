// saw join: connect the second member with an invite link.
import {
  readConfig,
  remotesMatch,
  resolveRepoRoot,
  resolveRepoRemote
} from "../config.js";
import { joinWorkspace, relayUrls } from "../relay-http.js";
import {
  DEFAULT_RELAY_URL,
  EXIT_ENV_ERROR,
  EXIT_USER_ERROR,
  fail,
  resolveGithubUsername,
  writeMemberFiles
} from "./init.js";

export interface JoinOptions {
  invite: string;
  github?: string;
  relay?: string;
}

/** Read the workspace id from the invite payload without trust. */
function inviteWorkspaceId(invite: string): string | undefined {
  const body = invite.split(".")[0];
  if (!body) return undefined;
  try {
    const json = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      workspace_id?: string;
    };
    return json.workspace_id;
  } catch {
    return undefined;
  }
}

export async function runJoin(options: JoinOptions): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) {
    fail("this directory is not inside a git repository", EXIT_ENV_ERROR);
  }
  const remote = resolveRepoRemote(root);
  if (!remote) {
    fail(
      "this repository has no remote. Clone the shared repository, then join from inside it.",
      EXIT_ENV_ERROR
    );
  }
  const github = resolveGithubUsername(options.github, root);

  // The creator commits .saw/config.json. A clone of the right repository
  // already has it, and it names the relay and the workspace.
  const committed = readConfig(root);
  const relay = options.relay ?? committed?.relay_url ?? DEFAULT_RELAY_URL;
  const urls = relayUrls(relay);

  // Check what we can check before we redeem the single-use invite.
  const claimedId = inviteWorkspaceId(options.invite);
  if (!claimedId) {
    fail("the invite link format is not valid", EXIT_USER_ERROR);
  }
  if (committed && committed.workspace_id !== claimedId) {
    fail(
      "the invite is for a different workspace than .saw/config.json in this clone",
      EXIT_USER_ERROR
    );
  }
  if (committed && committed.repo_remote && !remotesMatch(committed.repo_remote, remote)) {
    fail(
      `remote URL mismatch. The workspace uses ${committed.repo_remote} and this clone uses ${remote}. Join from a clone of the shared repository.`,
      EXIT_USER_ERROR
    );
  }

  const joined = await joinWorkspace(urls.http, options.invite, github);
  if (!joined.ok) {
    fail(`join failed: ${joined.error}`, EXIT_USER_ERROR);
  }

  writeMemberFiles(root, {
    workspaceId: joined.value.workspace_id,
    workspaceName: committed?.workspace_name ?? joined.value.workspace_id,
    relayUrl: relay,
    github,
    repoRemote: committed?.repo_remote ?? remote,
    members: joined.value.members,
    token: joined.value.token
  });

  console.log(`You joined the workspace.`);
  console.log(`Members: ${joined.value.members.join(", ")}`);
  console.log("");
  console.log("Files written: .saw/config.json, .saw/credential, .saw/AGENT.md");
  console.log("Next step: saw up");
}
