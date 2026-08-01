// Boundary enforcement at the relay.
// Every inbound frame passes through here before any processing.
// A rejected payload is logged. Its body is never stored or echoed.
import {
  ClientFrameSchema,
  validatePost,
  type ClientFrame,
  type MessagePost,
  type RejectionReason
} from "@saw/shared";

export type FrameParse =
  | { ok: true; frame: ClientFrame; post?: MessagePost }
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
  return { ok: true, frame };
}
