// HTTP calls to the relay: register, invite mint, and join.
// The WebSocket protocol lives in daemon/client.ts. This file is HTTP only.

/** Both faces of one relay URL. */
export interface RelayUrls {
  http: string;
  ws: string;
}

/**
 * Accept a relay URL in ws://, wss://, http://, or https:// form.
 * Return the HTTP base URL and the WebSocket endpoint URL.
 */
export function relayUrls(input: string): RelayUrls {
  const url = new URL(input);
  const secure = url.protocol === "wss:" || url.protocol === "https:";
  const host = url.host;
  return {
    http: `${secure ? "https" : "http"}://${host}`,
    ws: `${secure ? "wss" : "ws"}://${host}/ws`
  };
}

export interface RegisterResponse {
  workspace_id: string;
  member: string;
  token: string;
}

export type RelayHttpResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<RelayHttpResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body)
    });
  } catch {
    return { ok: false, error: "the relay is not reachable" };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: "the relay sent a response that is not JSON" };
  }
  const obj = json as { ok?: boolean; error?: string };
  if (!res.ok || obj.ok === false) {
    return { ok: false, error: obj.error ?? `the relay answered with status ${res.status}` };
  }
  return { ok: true, value: json as T };
}

/** Register a new workspace. Returns the creator credential. */
export function registerWorkspace(
  relayHttp: string,
  name: string,
  repoRemote: string,
  creator: string
): Promise<RelayHttpResult<RegisterResponse>> {
  return postJson<RegisterResponse>(`${relayHttp}/workspaces`, {
    name,
    repo_remote: repoRemote,
    creator
  });
}

/** Mint a signed invite link. Creator only. */
export async function mintInvite(
  relayHttp: string,
  workspaceId: string,
  token: string,
  invitee: string,
  expiresInHours: number
): Promise<RelayHttpResult<string>> {
  const result = await postJson<{ ok: true; invite: string }>(
    `${relayHttp}/workspaces/${workspaceId}/invites`,
    { invitee, expires_in_hours: expiresInHours },
    { authorization: `Bearer ${token}` }
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.invite };
}

export interface JoinResponse {
  workspace_id: string;
  member: string;
  token: string;
  members: string[];
}

/** Redeem an invite. Returns the new member credential. */
export function joinWorkspace(
  relayHttp: string,
  invite: string,
  github: string
): Promise<RelayHttpResult<JoinResponse>> {
  return postJson<JoinResponse>(`${relayHttp}/join`, { invite, github });
}
