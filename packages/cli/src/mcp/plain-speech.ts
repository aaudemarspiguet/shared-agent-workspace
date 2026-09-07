// Two registers in one post (the plain-speech plan, decided by both founders
// on 2026-09-06). The `summary` is for the humans; the `details` are for the
// other agent. They are stored as ONE message - summary first, a blank line,
// then the details - so nothing in the shared format or the relay changes,
// and every surface that folds a post to its first paragraph shows the
// humans exactly the part written for them.
//
// Deliberately no pattern-matching here: no word cap, no code scanning, no
// refusals over style. The founders judged that kind of check dumb and
// invasive - it would reject useful references and burn agent turns on
// rewrites. The model writes the human part on purpose, as its own field;
// the only guardrail is a one-line note when a summary runs long, and the
// post goes through regardless.

/** About how many sentences a person reads before they stop. */
export const MAX_SUMMARY_SENTENCES = 6;

/** The relay's cap on one message body (packages/shared MAX_BODY_LENGTH). */
const MAX_BODY = 4000;

export type Composed =
  | { ok: true; body: string; note?: string }
  | { ok: false; message: string };

/** Count sentences the way a reader does: ends at . ! or ? followed by space or end. */
export function sentenceCount(text: string): number {
  return text
    .split(/[.!?]+(?:\s+|$)/)
    .filter((piece) => piece.trim().length > 0).length;
}

/**
 * Compose the stored body from what the tool was given.
 *
 * `summary` + `details` is the shape agents are asked for. A bare `body`
 * (older callers, or a companion answering in one breath) passes through
 * unchanged, so nothing that worked yesterday breaks today.
 */
export function composePost(args: {
  summary?: unknown;
  details?: unknown;
  body?: unknown;
}): Composed {
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  const body = typeof args.body === "string" ? args.body.trim() : "";
  let details = typeof args.details === "string" ? args.details.trim() : "";

  if (!summary) {
    const text = body || details;
    if (!text) {
      return {
        ok: false,
        message:
          "a post needs a summary for the humans - what happened or what you need, in plain words - " +
          "and details for the other agent if there is more to say"
      };
    }
    return { ok: true, body: text };
  }

  // A caller that sends both `summary` and `body` meant `body` as the details.
  if (!details && body) details = body;

  const text = details ? `${summary}\n\n${details}` : summary;
  if (text.length > MAX_BODY) {
    return {
      ok: false,
      message:
        `summary and details together are ${text.length} characters; the room takes ${MAX_BODY}. ` +
        "Move some of the details to the pull request and point to it."
    };
  }

  const sentences = sentenceCount(summary);
  const note =
    sentences > MAX_SUMMARY_SENTENCES
      ? `posted. The summary is ${sentences} sentences; people read about ${MAX_SUMMARY_SENTENCES}. ` +
        "Next time, keep the summary to the point and put the rest in details."
      : undefined;
  return note ? { ok: true, body: text, note } : { ok: true, body: text };
}
