// Message flow: accept a post, resolve its thread, assign order, persist,
// broadcast. Spec 002 T104: messages route by thread; a null thread_id is a
// project broadcast; a v0-era work_item tag resolves to its thread, so an
// old client keeps working through the migration window.
import type { MessagePost, StoredThread, UnboundRef } from "@saw/shared";
import { branchPrefixRefusal } from "./boundary.js";
import { applyClaimTransition } from "./claims.js";
import { routeWakes } from "./sessions.js";
import type { ConnectionRegistry } from "./presence.js";
import type { MemberRow, RelayStore } from "./store.js";

export type PostOutcome =
  | { ok: true }
  | { ok: false; code: "unknown_thread" | "no_authority"; message: string };

/**
 * Handle one boundary-validated post from an authenticated member.
 * The sender identity always comes from the connection, never from the frame.
 */
export function handlePost(
  store: RelayStore,
  registry: ConnectionRegistry,
  sender: MemberRow,
  post: MessagePost,
  senderKind: "agent" | "human" | "companion"
): PostOutcome {
  const workspaceId = sender.workspace_id;

  // A companion answers; it never wields capability (FR-053, SC-028,
  // issue #206 third instance): no binding force whatever its member's
  // role, no claim effects, no ref bindings. Enforced here so SC-028
  // promises no more than the code does - the prompt is guidance, this
  // is the rule.
  if (senderKind === "companion" && post.force === "binding") {
    store.appendRejectionLog(
      workspaceId,
      sender.id,
      "no_authority",
      "binding force from a companion"
    );
    return {
      ok: false,
      code: "no_authority",
      message: "a companion never posts with binding force. It answers; its member decides."
    };
  }

  // Authority gates a binding message before anything is stored (T125,
  // FR-043). The v1 authority source is the owner role. The refusal is
  // plain, recorded, and never a silent downgrade to advisory (SC-020).
  if (post.force === "binding" && sender.role !== "creator") {
    store.appendRejectionLog(
      workspaceId,
      sender.id,
      "no_authority",
      "binding message from a member without authority"
    );
    return {
      ok: false,
      code: "no_authority",
      message:
        "a binding message needs authority (the owner role in v1). Post it as advisory, or ask the owner to settle it."
    };
  }

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

  // FR-010 (CHK005, T138). Archived is read-only: a post into an archived
  // thread is refused rather than silently accepted into a closed record.
  if (thread && thread.state === "archived") {
    const summary =
      `thread "${thread.title}" is archived and takes no new messages. ` +
      `Ask the owner to unarchive it first.`;
    store.appendRejectionLog(workspaceId, sender.id, "no_authority", summary);
    return { ok: false, code: "no_authority", message: summary };
  }

  const message = store.insertMessage(workspaceId, sender, senderKind, post, thread?.id ?? null);

  // A post into a done thread reopens it (FR-010, CHK005). This is the
  // reopen path the answer names: any member of the scope, by saying
  // something, with no separate control and no permission to ask for.
  if (thread && thread.state === "done") {
    store.setThreadState(thread.id, "open");
    const reopened = store.threadById(thread.id);
    if (reopened) {
      thread = reopened;
      registry.broadcast(store, workspaceId, { kind: "thread", thread: reopened });
    }
  }

  // Refs the post carried that did not bind. Reported to the sender below so
  // the refusal is not silent; the rejection log records it either way.
  const unbound: UnboundRef[] = [];

  if (thread) {
    // Posting into a thread makes the sender a participant (FR-012), and
    // the refs a post carries bind to the thread (FR-014, T115). A branch
    // binds only under its author's own member prefix (FR-040, T143):
    // branch-per-agent is how git-only sync stays true when two members
    // edit on one thread. A commit SHA has no owner and always binds. The
    // message itself still carries the ref; only the binding is refused,
    // and the refusal is recorded.
    store.addParticipant(thread.id, sender.github_username);
    for (const ref of post.refs) {
      if (senderKind === "companion") {
        store.appendRejectionLog(
          workspaceId,
          sender.id,
          "invalid_ref",
          "a companion never binds refs; the ref stays on the message only"
        );
        continue;
      }
      const refusal = branchPrefixRefusal(ref, sender.github_username);
      if (refusal) {
        // The post path adds one fact the frame path cannot: the message
        // itself still went through and still carries the ref.
        const summary = `${refusal} The message posted and still carries the ref.`;
        store.appendRejectionLog(workspaceId, sender.id, "invalid_ref", summary);
        unbound.push({ ref, reason: "invalid_ref", summary });
        continue;
      }
      const binding = store.bindThreadRef(thread.id, workspaceId, ref, sender.github_username);
      registry.broadcast(store, workspaceId, { kind: "thread_ref", binding });
    }
  }

  registry.sendTo(sender.id, {
    kind: "post_ok",
    seq: message.seq,
    sent_at: message.sent_at,
    ...(unbound.length > 0 ? { unbound_refs: unbound } : {})
  });

  // Deliver to the other members. Paused members catch up through sync.
  registry.broadcast(
    store,
    workspaceId,
    { kind: "message", message },
    { excludeMemberId: sender.id }
  );

  // Claims resolve in the same order the messages were recorded. A
  // companion's messages never move claim state (FR-053).
  if (thread && senderKind !== "companion") {
    const claim = applyClaimTransition(store, workspaceId, sender, post.type, thread, senderKind);
    if (claim) registry.broadcast(store, workspaceId, claim);
  }

  // The wake rule runs last, over the stored message (T150). Delivery of
  // the message itself never depends on it.
  routeWakes(store, registry, workspaceId, message);
  return { ok: true };
}
