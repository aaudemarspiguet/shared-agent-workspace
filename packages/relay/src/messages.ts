// Message flow: accept a post, assign seq, persist, broadcast in order.
import type { MessagePost } from "@saw/shared";
import { applyWorkItemTransition } from "./claims.js";
import type { ConnectionRegistry } from "./presence.js";
import type { MemberRow, RelayStore } from "./store.js";

/**
 * Handle one boundary-validated post from an authenticated member.
 * The sender identity always comes from the connection, never from the frame.
 */
export function handlePost(
  store: RelayStore,
  registry: ConnectionRegistry,
  sender: MemberRow,
  post: MessagePost,
  senderKind: "agent" | "human"
): void {
  const workspaceId = sender.workspace_id;
  const message = store.insertMessage(workspaceId, sender, senderKind, post);

  registry.sendTo(sender.id, {
    kind: "post_ok",
    seq: message.seq,
    sent_at: message.sent_at
  });

  // Deliver to the other members. Paused members catch up through sync.
  registry.broadcast(
    store,
    workspaceId,
    { kind: "message", message },
    { excludeMemberId: sender.id }
  );

  // Claims resolve in the same order the messages were recorded.
  if (post.work_item) {
    const claim = applyWorkItemTransition(store, workspaceId, sender, post.type, post.work_item);
    if (claim) registry.broadcast(store, workspaceId, claim);
  }
}
