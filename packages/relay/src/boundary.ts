// Boundary enforcement at the relay.
// Every inbound frame passes through here before any processing.
// A rejected payload is logged. Its body is never stored or echoed.
import {
  ClientFrameSchema,
  validateLogEntry,
  validatePost,
  type ClientFrame,
  type LogRedaction,
  type MessagePost,
  type RejectionReason,
  type RunLogEntryInput
} from "@saw/shared";

const CLIENT_FRAME_KINDS = [
  "hello",
  "post",
  "sync",
  "log_append",
  "log_query",
  "pause_set",
  "ping"
] as const;

export type FrameParse =
  | {
      ok: true;
      frame: ClientFrame;
      post?: MessagePost;
      /** The scrubbed `log_append` entry. Use this, never `frame.entry`. */
      entry?: RunLogEntryInput;
      /** Fields the boundary removed from a `log_append` entry. */
      redactions?: LogRedaction[];
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
