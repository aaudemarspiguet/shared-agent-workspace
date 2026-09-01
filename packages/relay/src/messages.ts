// Message flow: accept a post, resolve its thread, assign order, persist,
// broadcast. Spec 002 T104: messages route by thread; a null thread_id is a
// project broadcast; a v0-era work_item tag resolves to its thread, so an
// old client keeps working through the migration window.
import type { MessagePost, StoredThread } from "@saw/shared";
import { applyClaimTransition } from "./claims.js";
import type { ConnectionRegistry } from "./presence.js";
import type { MemberRow, RelayStore } from "./store.js";

export type PostOutcome =
  | { ok: true }
  | { ok: false; code: "unknown_thread"; message: string };

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
): PostOutcome {
  const workspaceId = sender.workspace_id;

  // Resolve the container before anything is stored (T104):
  // an explicit thread_id must name a real thread of this workspace; a
  // work_item tag resolves through the fold map, creating the thread on
  // first mention exactly as v0 created work items; neither means a
  // project broadcast.
  let thread: StoredThread | null = null;
  if (post.thread_id) {
    const found = store.threadById(post.thread_id);
    if (!found || found.workspace_id !== workspaceId) {
      return { ok: false, code: "unknown_thread", message: "thread not found" };
    }
    thread = found;
  } else if (post.work_item) {
    thread = store.resolveThreadForTag(workspaceId, post.work_item, sender.github_username);
  }

  const message = store.insertMessage(workspaceId, sender, senderKind, post, thread?.id ?? null);

  if (thread) {
    // Posting into a thread makes the sender a participant (FR-012), and
    // the refs a post carries bind to the thread (FR-014, T115).
    store.addParticipant(thread.id, sender.github_username);
    for (const ref of post.refs) {
      const binding = store.bindThreadRef(thread.id, workspaceId, ref, sender.github_username);
      registry.broadcast(store, workspaceId, { kind: "thread_ref", binding });
    }
  }

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
  if (thread) {
    const claim = applyClaimTransition(store, workspaceId, sender, post.type, thread);
    if (claim) registry.broadcast(store, workspaceId, claim);
  }
  return { ok: true };
}
