// Work log endpoints: append and query.
// Queries read SQLite only. They work when the peer is offline (FR-019).
import type { LogQuery, RunLogEntryInput, StoredLogEntry, StoredMessage } from "@saw/shared";
import type { ConnectionRegistry } from "./presence.js";
import type { MemberRow, RelayStore } from "./store.js";

export function handleLogAppend(
  store: RelayStore,
  registry: ConnectionRegistry,
  member: MemberRow,
  entry: RunLogEntryInput
): void {
  const id = store.appendLog(member.workspace_id, member.id, entry, "hook_stop");
  registry.sendTo(member.id, { kind: "log_ok", id });
}

export function handleLogQuery(
  store: RelayStore,
  registry: ConnectionRegistry,
  member: MemberRow,
  query: LogQuery,
  peerActivity: boolean
): void {
  const workspaceId = member.workspace_id;
  const peer = store.members(workspaceId).find((m) => m.id !== member.id);

  let memberIdFilter: string | undefined;
  if (query.member === "me") memberIdFilter = member.id;
  if (query.member === "peer") memberIdFilter = peer?.id ?? "none";

  const entries: StoredLogEntry[] = store.queryLog(workspaceId, {
    memberId: memberIdFilter,
    workItem: query.work_item,
    since: query.since,
    limit: query.limit
  });

  if (!peerActivity || !peer) {
    registry.sendTo(member.id, { kind: "log_result", entries });
    return;
  }

  // Peer activity: stored history only. The peer's machine is never needed.
  const sinceTime = query.since ? new Date(query.since).getTime() : 0;
  const messages: StoredMessage[] = store
    .messagesSince(workspaceId, 0)
    .filter(
      (m) => m.sender === peer.github_username && new Date(m.sent_at).getTime() >= sinceTime
    )
    .slice(-query.limit);

  registry.sendTo(member.id, {
    kind: "log_result",
    entries,
    peer: peer.github_username,
    peer_online: registry.isOnline(peer.id),
    messages
  });
}
