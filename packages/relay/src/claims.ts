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
  thread: StoredThread,
  senderKind: "agent" | "human" | "companion" = "agent"
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
        return result(thread, true, senderName, "claimed");
      }
      if (claim.state === "handed_off" && claim.claimed_by === senderName) {
        store.setThreadClaim(thread.id, "claimed", senderName);
        return result(thread, true, senderName, "claimed");
      }
      if (claim.state === "done_proposed" && claim.claimed_by === senderName) {
        // The holder's agent kept going, so the proposal no longer stands.
        store.setThreadClaim(thread.id, "claimed", senderName);
        return result(thread, true, senderName, "claimed");
      }
      // The thread is already taken. First claim wins. Reject visibly.
      return result(thread, false, claim.claimed_by ?? senderName, claim.state);
    }

    if (type === "handoff" && claim.state === "claimed" && claim.claimed_by === senderName) {
      const other = store
        .members(workspaceId)
        .find((m) => m.github_username !== senderName);
      if (other) {
        store.setThreadClaim(thread.id, "handed_off", other.github_username);
        return result(thread, true, other.github_username, "handed_off");
      }
    }

    if (type === "decision" && claim.state === "claimed" && claim.claimed_by === senderName) {
      // FR-052 (T155): who authored the decision decides what it does. A
      // human's decision IS the concluding act. An agent's decision is a
      // proposal: the claim waits for its own member's approval
      // (claim_approve). This was the live defect from the #178 review -
      // an agent could close its own member's claim with nobody involved.
      if (senderKind === "human") {
        store.setThreadClaim(thread.id, "done", senderName);
        return result(thread, true, senderName, "done");
      }
      store.setThreadClaim(thread.id, "done_proposed", senderName);
      return result(thread, true, senderName, "done_proposed");
    }

    return null;
  });
}

/**
 * The holder's own member approves the agent-proposed done (FR-052).
 * Self-directed: nobody approves another member's proposal.
 */
export function applyClaimApprove(
  store: RelayStore,
  member: MemberRow,
  threadId: string
): { ok: true; frame: ClaimResultFrame } | { ok: false; message: string } {
  const thread = store.threadById(threadId);
  if (!thread || thread.workspace_id !== member.workspace_id) {
    return { ok: false, message: "thread not found" };
  }
  const claim = store.threadClaim(threadId);
  if (!claim || claim.state !== "done_proposed") {
    return { ok: false, message: "nothing is proposed done on this thread" };
  }
  if (claim.claimed_by !== member.github_username) {
    return {
      ok: false,
      message:
        "approving is self-directed: the proposal belongs to the other member's agent, so their member approves it"
    };
  }
  store.setThreadClaim(threadId, "done", member.github_username);
  return { ok: true, frame: result(thread, true, member.github_username, "done") };
}

/**
 * The frame carries both names through the migration window: `thread_id`
 * for v1 clients, `work_item` (the tag the thread came from, or its title)
 * for a client that still thinks in tags (PR #173, wire decision 2).
 */
function result(
  thread: StoredThread,
  granted: boolean,
  claimedBy: string,
  state?: ClaimResultFrame["state"]
): ClaimResultFrame {
  return {
    kind: "claim_result",
    work_item: thread.migrated_from_tag ?? thread.title,
    thread_id: thread.id,
    granted,
    claimed_by: claimedBy,
    ...(state ? { state } : {})
  };
}
