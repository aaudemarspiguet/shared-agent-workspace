// Boundary enforcement at the relay.
// Every inbound frame passes through here before any processing.
// A rejected payload is logged. Its body is never stored or echoed.
import {
  ClientFrameSchema,
  GitRefSchema,
  ThreadModeSetSchema,
  validateHandoffPropose,
  validateLogEntry,
  validatePost,
  validateThreadOpen,
  type ClientFrame,
  type GitRef,
  type LogRedaction,
  type MessagePost,
  type RejectionReason,
  type RunLogEntryInput,
  type ThreadOpen
} from "@saw/shared";

const CLIENT_FRAME_KINDS = [
  "hello",
  "post",
  "sync",
  "log_append",
  "log_query",
  "pause_set",
  "ping",
  "thread_open",
  "thread_state_set",
  "thread_mode_set",
  "thread_ref_bind",
  "handoff_propose",
  "handoff_resolve"
] as const;

/**
 * FR-040 (T143): a branch ref binds to a thread only under its author's own
 * member prefix. Branch-per-agent is how git-only sync stays true when two
 * members edit on one thread, so a member may not bind the other's branch
 * namespace. A commit SHA has no owner and always binds.
 *
 * This lives here, at the boundary, because there are two ways to bind a
 * ref — riding along on a post, and the `thread_ref_bind` frame — and the
 * rule held on only one of them while it was written inline in the post
 * path. One function, both callers, no drift.
 *
 * Returns the refusal summary, or null when the ref may bind.
 */
export function branchPrefixRefusal(ref: GitRef, member: string): string | null {
  if (ref.kind !== "branch") return null;
  if (ref.value.startsWith(`${member}/`)) return null;
  return (
    `branch "${ref.value}" is not under your own prefix ` +
    `"${member}/", so it did not bind to the thread. ` +
    `Rename the branch under your prefix and bind it again.`
  );
}

export type FrameParse =
  | {
      ok: true;
      frame: ClientFrame;
      post?: MessagePost;
      /** The scrubbed `log_append` entry. Use this, never `frame.entry`. */
      entry?: RunLogEntryInput;
      /** Fields the boundary removed from a `log_append` entry. */
      redactions?: LogRedaction[];
      /** The validated `thread_open` payload. Use this, never `frame.open`. */
      open?: ThreadOpen;
      /** The validated `thread_ref_bind` ref. Use this, never `frame.ref`. */
      ref?: GitRef;
      /** The validated `handoff_propose` payload. Never `frame.propose`. */
      propose?: import("@saw/shared").HandoffPropose;
      /** The validated `thread_mode_set` payload. Never `frame.set`. */
      modeSet?: import("@saw/shared").ThreadModeSet;
    }
  | { ok: false; reason: RejectionReason; summary: string };

/** Parse and validate one raw WebSocket text frame. */
export function parseClientFrame(raw: string): FrameParse {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not_json", summary: "frame is not valid JSON" };
  }
  const parsed = ClientFrameSchema.safeParse(json);
  if (!parsed.success) {
    // Reaching here means the frame has no usable content at all: an unknown
    // kind, or a `log_append` with no valid start/end time. Everything that a
    // rule could merely trim is handled below, not refused here (T073).
    // The kind is only named when it is one we know. An unknown kind is
    // sender-controlled text, and a summary never echoes the payload.
    const kind = (json as { kind?: unknown } | null)?.kind;
    const known = CLIENT_FRAME_KINDS.find((k) => k === kind);
    return {
      ok: false,
      reason: "not_json",
      summary: known
        ? `frame shape is not valid for kind '${known}'`
        : "frame kind is unknown or the frame shape is not valid"
    };
  }
  const frame = parsed.data;
  if (frame.kind === "post") {
    const check = validatePost(frame.post);
    if (!check.ok) {
      return { ok: false, reason: check.reason, summary: check.summary };
    }
    return { ok: true, frame, post: check.post };
  }
  if (frame.kind === "thread_open") {
    const check = validateThreadOpen(frame.open);
    if (!check.ok) {
      return { ok: false, reason: check.reason, summary: check.summary };
    }
    return { ok: true, frame, open: check.open };
  }
  if (frame.kind === "handoff_propose") {
    const check = validateHandoffPropose(frame.propose);
    if (!check.ok) {
      return { ok: false, reason: check.reason, summary: check.summary };
    }
    return { ok: true, frame, propose: check.propose };
  }
  if (frame.kind === "thread_mode_set") {
    const check = ThreadModeSetSchema.safeParse(frame.set);
    if (!check.success) {
      return { ok: false, reason: "not_json", summary: "mode payload shape is not valid" };
    }
    return { ok: true, frame, modeSet: check.data };
  }
  if (frame.kind === "thread_ref_bind") {
    const check = GitRefSchema.safeParse(frame.ref);
    if (!check.success) {
      return { ok: false, reason: "invalid_ref", summary: "the ref is not valid" };
    }
    return { ok: true, frame, ref: check.data };
  }
  if (frame.kind === "log_append") {
    // A log entry crosses to the peer through `peer_activity`, so every free
    // text field on it gets the same content check as a post body. It is
    // scrubbed rather than refused — including for a length rule, which
    // trims the field instead of costing the run (FR-015, T073).
    const checked = validateLogEntry(frame.entry);
    return {
      ok: true,
      frame: { ...frame, entry: checked.entry },
      entry: checked.entry,
      redactions: checked.redactions
    };
  }
  return { ok: true, frame };
}
