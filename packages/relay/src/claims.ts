// Thread claims (spec 002 T098: rekeyed from workspace tags to threads).
// Claims resolve in message seq order. The first claim wins.
// A rejected claim is broadcast so both humans see it. Nothing drops silently.
import type { ClaimResultFrame, MessageType, StoredThread } from "@saw/shared";
import type { MemberRow, RelayStore } from "./store.js";

/**
 * Apply the claim transition for one accepted message posted into a thread.
 * The state machine is v0's, keyed by thread (data-model.md):
 *   open       -> claimed     (intent, first claim wins)
 *   claimed    -> handed_off  (handoff by the claimer; reassigns claimed_by)
 *   handed_off -> claimed     (intent by the new claimed_by accepts)
 *   claimed    -> done        (decision by the claimer)
 * Only a work_item thread takes claims: an intent in a brainstorm or a
 * general thread is conversation, not a claim.
 * Returns a claim_result frame to broadcast, or null when nothing changed.
 */
export function applyClaimTransition(
  store: RelayStore,
  workspaceId: string,
  sender: MemberRow,
  type: MessageType,
  thread: StoredThread
): ClaimResultFrame | null {
  if (thread.type !== "work_item") return null;
  return store.transact(() => {
    const claim = store.threadClaim(thread.id) ?? {
      thread_id: thread.id,
      state: "open" as const,
      claimed_by: null,
      updated_at: thread.created_at
    };
    const senderName = sender.github_username;

    if (type === "intent") {
      if (claim.state === "open") {
        store.setThreadClaim(thread.id, "claimed", senderName);
        return result(thread, true, senderName);
      }
      if (claim.state === "handed_off" && claim.claimed_by === senderName) {
        store.setThreadClaim(thread.id, "claimed", senderName);
        return result(thread, true, senderName);
      }
      // The thread is already taken. First claim wins. Reject visibly.
      return result(thread, false, claim.claimed_by ?? senderName);
    }

    if (type === "handoff" && claim.state === "claimed" && claim.claimed_by === senderName) {
      const other = store
        .members(workspaceId)
        .find((m) => m.github_username !== senderName);
      if (other) {
        store.setThreadClaim(thread.id, "handed_off", other.github_username);
        return result(thread, true, other.github_username);
      }
    }

    if (type === "decision" && claim.state === "claimed" && claim.claimed_by === senderName) {
      store.setThreadClaim(thread.id, "done", senderName);
      return result(thread, true, senderName);
    }

    return null;
  });
}

/**
 * The frame carries both names through the migration window: `thread_id`
 * for v1 clients, `work_item` (the tag the thread came from, or its title)
 * for a client that still thinks in tags (PR #173, wire decision 2).
 */
function result(thread: StoredThread, granted: boolean, claimedBy: string): ClaimResultFrame {
  return {
    kind: "claim_result",
    work_item: thread.migrated_from_tag ?? thread.title,
    thread_id: thread.id,
    granted,
    claimed_by: claimedBy
  };
}
