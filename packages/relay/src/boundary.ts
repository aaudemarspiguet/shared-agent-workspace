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
  type RejectionReason
} from "@saw/shared";

export type FrameParse =
  | {
      ok: true;
      frame: ClientFrame;
      post?: MessagePost;
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
    return {
      ok: false,
      reason: "not_json",
      summary: "frame kind is unknown or the frame shape is not valid"
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
    // A log entry crosses to the peer through `peer_activity`, so it gets the
    // same content check as a post. It is scrubbed rather than refused: every
    // run must still be logged (FR-015).
    const checked = validateLogEntry(frame.entry);
    return {
      ok: true,
      frame: { ...frame, entry: checked.entry },
      redactions: checked.redactions
    };
  }
  return { ok: true, frame };
}
