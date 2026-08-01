// Pause state. The relay is the authority.
// The frame carries no member field. A pause always applies to the sender,
// so no member can ever pause the other member through the protocol.
import type { ConnectionRegistry } from "./presence.js";
import type { MemberRow, RelayStore } from "./store.js";

export function handlePauseSet(
  store: RelayStore,
  registry: ConnectionRegistry,
  member: MemberRow,
  paused: boolean
): void {
  store.setPause(member.id, paused);
  registry.broadcast(store, member.workspace_id, {
    kind: "pause_state",
    member: member.github_username,
    paused
  });
}
