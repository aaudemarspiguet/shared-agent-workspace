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
// post goes through regardless. The two refusals that remain are about
// shape, not style: an empty post, and details with no summary at all.

import { MAX_BODY_LENGTH } from "@saw/shared";

/** About how many sentences a person reads before they stop. */
export const MAX_SUMMARY_SENTENCES = 6;

/** The relay's cap on one message body, imported so the two can never disagree. */
const MAX_BODY = MAX_BODY_LENGTH;

export type Composed =
  | { ok: true; body: string; note?: string }
  | { ok: false; message: string };

/** Count sentences the way a reader does: ends at . ! or ? followed by space or end. */
export function sentenceCount(text: string): number {
  return text
    .split(/[.!?]+(?:\s+|$)/)
    .filter((piece) => piece.trim().length > 0).length;
}

const NEEDS_SUMMARY =
  "a post needs a summary for the humans - what happened or what you need, in plain words - " +
  "and details for the other agent if there is more to say";

/**
 * Compose the stored body from what the tool was given.
 *
 * `summary` + `details` is the shape agents are asked for. A bare `body`
 * (older callers, or a companion answering in one breath) passes through
 * unchanged, so nothing that worked yesterday breaks today. Details with no
 * summary is refused: that is a technical wall with no part for the humans,
 * and the page would fold it as if it were one.
 */
export function composePost(args: {
  summary?: unknown;
  details?: unknown;
  body?: unknown;
}): Composed {
  const rawSummary = typeof args.summary === "string" ? args.summary.trim() : "";
  const body = typeof args.body === "string" ? args.body.trim() : "";
  let details = typeof args.details === "string" ? args.details.trim() : "";

  if (!rawSummary) {
    if (body) return { ok: true, body };
    return { ok: false, message: NEEDS_SUMMARY };
  }

  // The summary is exactly one paragraph: a blank line inside it would put
  // its second half below the fold. Collapse any to a single line break.
  const summary = rawSummary.replace(/\n\s*\n+/g, "\n");

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
      ? `Posted. The summary ran to ${sentences} sentences; people read about ${MAX_SUMMARY_SENTENCES}. ` +
        "Next time keep it shorter and move the rest to details."
      : undefined;
  return note ? { ok: true, body: text, note } : { ok: true, body: text };
}
