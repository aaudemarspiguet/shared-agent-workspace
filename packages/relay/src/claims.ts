// Work item claims.
// Claims resolve in message seq order. The first claim wins.
// A rejected claim is broadcast so both humans see it. Nothing drops silently.
import type { ClaimResultFrame, MessageType } from "@saw/shared";
import type { MemberRow, RelayStore } from "./store.js";

/**
 * Apply the work item transition for one accepted message.
 * Transitions (data-model.md):
 *   open       -> claimed     (intent, first claim wins)
 *   claimed    -> handed_off  (handoff by the claimer; reassigns claimed_by)
 *   handed_off -> claimed     (intent by the new claimed_by accepts)
 *   claimed    -> done        (decision by the claimer)
 * Returns a claim_result frame to broadcast, or null when nothing changed.
 */
export function applyWorkItemTransition(
  store: RelayStore,
  workspaceId: string,
  sender: MemberRow,
  type: MessageType,
  featureTag: string
): ClaimResultFrame | null {
  return store.transact(() => {
    const item = store.upsertWorkItem(workspaceId, featureTag);
    const senderName = sender.github_username;

    if (type === "intent") {
      if (item.state === "open") {
        store.setWorkItemState(item.id, "claimed", senderName);
        return result(featureTag, true, senderName);
      }
      if (item.state === "handed_off" && item.claimed_by === senderName) {
        store.setWorkItemState(item.id, "claimed", senderName);
        return result(featureTag, true, senderName);
      }
      // The item is already taken. First claim wins. Reject visibly.
      return result(featureTag, false, item.claimed_by ?? senderName);
    }

    if (type === "handoff" && item.state === "claimed" && item.claimed_by === senderName) {
      const other = store
        .members(workspaceId)
        .find((m) => m.github_username !== senderName);
      if (other) {
        store.setWorkItemState(item.id, "handed_off", other.github_username);
        return result(featureTag, true, other.github_username);
      }
    }

    if (type === "decision" && item.state === "claimed" && item.claimed_by === senderName) {
      store.setWorkItemState(item.id, "done", senderName);
      return result(featureTag, true, senderName);
    }

    return null;
  });
}

function result(workItem: string, granted: boolean, claimedBy: string): ClaimResultFrame {
  return { kind: "claim_result", work_item: workItem, granted, claimed_by: claimedBy };
}
