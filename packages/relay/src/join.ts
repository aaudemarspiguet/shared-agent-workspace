// Workspace registration, invite mint, and join redemption.
// These run over plain HTTP JSON endpoints on the relay.
import { randomBytes } from "node:crypto";
import { mintInvite, verifyInvite } from "@saw/shared";
import type { RelayStore } from "./store.js";

export interface RegisterResult {
  workspace_id: string;
  member: string;
  token: string;
}

export function registerWorkspace(
  store: RelayStore,
  name: string,
  repoRemote: string,
  creatorGithub: string
): RegisterResult {
  const { workspace, member, token } = store.createWorkspace(name, repoRemote, creatorGithub);
  return { workspace_id: workspace.id, member: member.github_username, token };
}

export type MintResult = { ok: true; invite: string } | { ok: false; error: string };

/** Mint a signed invite link. Only the workspace creator may do this. */
export function mintWorkspaceInvite(
  store: RelayStore,
  workspaceId: string,
  token: string,
  invitee: string,
  expiresInHours = 72
): MintResult {
  const ws = store.getWorkspace(workspaceId);
  if (!ws) return { ok: false, error: "workspace not found" };
  const member = store.authMember(workspaceId, token);
  if (!member) return { ok: false, error: "not authorized" };
  if (member.role !== "creator") {
    return { ok: false, error: "only the workspace creator can mint invites" };
  }
  if (store.members(workspaceId).length >= 2) {
    return { ok: false, error: "workspace already has two members" };
  }
  const payload = {
    workspace_id: workspaceId,
    invitee,
    expires_at: new Date(Date.now() + expiresInHours * 3600_000).toISOString(),
    nonce: randomBytes(16).toString("hex")
  };
  store.recordInvite(payload.nonce, workspaceId, invitee, payload.expires_at);
  return { ok: true, invite: mintInvite(payload, ws.invite_secret) };
}

export type JoinResult =
  | {
      ok: true;
      workspace_id: string;
      member: string;
      token: string;
      members: string[];
      /** The remote the workspace was registered against. The joiner has no
       * other way to learn it, and needs it to check that the repository they
       * are in is the one the workspace refers to (Principle VI). */
      repo_remote: string;
    }
  | { ok: false; error: string };

/** Redeem an invite token. Issues the new member their own credential. */
export function joinWorkspace(
  store: RelayStore,
  inviteToken: string,
  github: string
): JoinResult {
  // The payload names the workspace. Read it first, then verify the signature
  // with that workspace's own secret.
  const body = inviteToken.split(".")[0];
  if (!body) return { ok: false, error: "invite format is not valid" };
  let workspaceId: string;
  try {
    const json = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      workspace_id?: string;
    };
    if (!json.workspace_id) return { ok: false, error: "invite format is not valid" };
    workspaceId = json.workspace_id;
  } catch {
    return { ok: false, error: "invite format is not valid" };
  }
  const ws = store.getWorkspace(workspaceId);
  if (!ws) return { ok: false, error: "workspace not found" };
  const verified = verifyInvite(inviteToken, ws.invite_secret);
  if (!verified.ok) {
    const reasons = {
      bad_format: "invite format is not valid",
      bad_signature: "invite signature is not valid",
      expired: "invite is expired"
    } as const;
    return { ok: false, error: reasons[verified.reason] };
  }
  const redeemed = store.redeemInvite(verified.payload.nonce, workspaceId, github);
  if (!redeemed.ok) return { ok: false, error: redeemed.error };
  return {
    ok: true,
    workspace_id: workspaceId,
    member: redeemed.member.github_username,
    token: redeemed.token,
    members: store.members(workspaceId).map((m) => m.github_username),
    repo_remote: ws.repo_remote
  };
}
