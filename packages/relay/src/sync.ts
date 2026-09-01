// Sync: replay missed messages in seq order, then the thread snapshot.
// A member that reconnects, or resumes from pause, sends `sync` with the
// last seq it has. The relay streams everything after that seq, in order,
// and closes with the current thread state so the client's mirror is whole.
import type { MemberRow, RelayStore } from "./store.js";
import type { ConnectionRegistry } from "./presence.js";

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
  sendThreadSnapshot(store, registry, member);
}

/**
 * The whole thread state of the member's workspace in one frame: threads,
 * modes, handoffs, and ref bindings (spec 002 contracts 2.2). Sent after
 * hello_ok and after every sync replay.
 */
export function sendThreadSnapshot(
  store: RelayStore,
  registry: ConnectionRegistry,
  member: MemberRow
): void {
  registry.sendTo(member.id, {
    kind: "thread_snapshot",
    threads: store.threads(member.workspace_id),
    modes: store.threadModes(member.workspace_id),
    handoffs: store.handoffs(member.workspace_id),
    refs: store.threadRefs(member.workspace_id)
  });
}
