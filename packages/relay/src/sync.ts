// Sync: replay missed messages in seq order.
// A member that reconnects, or resumes from pause, sends `sync` with the last
// seq it has. The relay streams everything after that seq, in order.
import type { ConnectionRegistry } from "./presence.js";
import type { MemberRow, RelayStore } from "./store.js";

export function handleSync(
  store: RelayStore,
  registry: ConnectionRegistry,
  member: MemberRow,
  sinceSeq: number
): void {
  const missed = store.messagesSince(member.workspace_id, sinceSeq);
  for (const message of missed) {
    registry.sendTo(member.id, { kind: "message", message });
  }
}
