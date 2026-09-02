// Message and git ref rules. This file defines the SAW boundary.
// Only messages that pass these checks may cross between members.
import { z } from "zod";

/** The five message types. The relay rejects all other types. */
export const MESSAGE_TYPES = [
  "intent",
  "question",
  "decision",
  "handoff",
  "status"
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/**
 * The force a message carries (spec 002 FR-043). Authority binds the work
 * record, never another member's agent. `binding` requires authority; the
 * relay checks it and never silently downgrades (SC-020).
 */
export const MESSAGE_FORCES = ["advisory", "binding"] as const;
export type MessageForce = (typeof MESSAGE_FORCES)[number];
export const DEFAULT_FORCE: MessageForce = "advisory";

export const MAX_BODY_LENGTH = 4000;
export const MAX_REFS = 10;
/** Cap on the short free-text labels: `work_item`, `target`. */
export const MAX_LABEL_LENGTH = 100;

/** Why the boundary rejected a payload. */
export const REJECTION_REASONS = [
  "unknown_type",
  "invalid_ref",
  "payload_too_large",
  "content_smuggling",
  "not_json",
  "no_authority"
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/**
 * A relay-assigned id (thread ids, message ids) is a Crockford-base32 ULID.
 * The shape check is strict, so an id field can never carry free text.
 */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidUlid(value: string): boolean {
  return ULID_RE.test(value);
}

export const UlidSchema = z.string().regex(ULID_RE, "not a ulid");

/** A git ref is a branch name or a commit SHA. It is the only pointer to code. */
export interface GitRef {
  kind: "branch" | "commit";
  value: string;
}

const COMMIT_RE = /^[0-9a-f]{7,40}$/;

/** Check a commit SHA. Short SHAs down to 7 chars are accepted, as git does. */
export function isValidCommitSha(value: string): boolean {
  return COMMIT_RE.test(value);
}

/** Check a branch name against the core git check-ref-format rules. */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 250) return false;
  // Control chars are forbidden in git ref names, so the regex must name them.
  // eslint-disable-next-line no-control-regex
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".") || name.endsWith(".lock")) return false;
  return true;
}

export const GitRefSchema = z
  .object({
    kind: z.enum(["branch", "commit"]),
    value: z.string().min(1)
  })
  .superRefine((ref, ctx) => {
    if (ref.kind === "commit" && !COMMIT_RE.test(ref.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid commit sha" });
    }
    if (ref.kind === "branch" && !isValidBranchName(ref.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid branch name" });
    }
  });

/** A code fence may carry this many lines before it is a file, not a snippet. */
const MAX_FENCE_LINES = 20;

/**
 * A flattened fence may carry this many characters before it is a file.
 *
 * The backstop for a payload whose language ends no line with punctuation, so
 * `estimateFlatLines` cannot read the shape. It is a proxy for the line rule
 * and cannot be as exact, so it is set low: the field it protects most,
 * `why_trigger`, is capped at 600 characters, and a threshold near that cap
 * would never fire.
 */
const MAX_FLAT_FENCE_CHARS = 400;

/**
 * Markers that identify a diff wherever they sit in the text.
 *
 * None of these is anchored to the start of a line. They were, and a caller
 * that collapses whitespace before sending — the CLI does, to fit a prompt
 * into `why_trigger` — left no line for them to anchor to, so every one of
 * them missed and the pasted code crossed the boundary unredacted (T080).
 *
 * The hunk header is matched by its real shape, `@@ -l[,s] +l[,s] @@`, rather
 * than by `@@ ... @@`. Unanchored, the loose form would match any two `@@` in
 * one message, and a rejected post is a message the member does not get to
 * send. The exact form is both anchor-free and harder to trip by accident.
 */
const DIFF_MARKERS: RegExp[] = [
  /--- a\//,
  /\+\+\+ b\//,
  /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/,
  /(?:^|\s)diff --git /
];

/**
 * Estimate how many lines a payload had before its whitespace was collapsed.
 *
 * Flattening destroys the newlines but leaves the punctuation that ended each
 * line. Counting those recovers the shape well enough to apply the SAME rule
 * as the unflattened case, rather than inventing a second one: thirty
 * statements of `const x = 1;` read as thirty-one lines whether or not the
 * newlines survived.
 */
function estimateFlatLines(flat: string): number {
  return (flat.match(/[;{}]/g)?.length ?? 0) + 1;
}

/**
 * Judge one code fence payload, or return null when it is a fair snippet.
 * `inner` is the text between the fence markers, info string included.
 */
function measureFencePayload(inner: string): string | null {
  const firstBreak = inner.indexOf("\n");
  if (firstBreak !== -1) {
    // The first line is the info string (the language tag), not payload.
    const lines = inner.slice(firstBreak + 1).split("\n").length;
    return lines > MAX_FENCE_LINES ? `code fence with ${lines} lines` : null;
  }
  // No newline left to count. Read the shape instead, and fall back to size.
  const flat = inner.trim();
  const estimated = estimateFlatLines(flat);
  if (estimated > MAX_FENCE_LINES) {
    return `flattened code fence, about ${estimated} lines`;
  }
  if (flat.length > MAX_FLAT_FENCE_CHARS) {
    return `flattened code fence with ${flat.length} chars`;
  }
  return null;
}

/**
 * Judge the tail after an opening fence marker that never closed.
 *
 * Length alone cannot decide this one. Prose mentions a fence marker too —
 * "wrap it in ```" is a normal thing to write to a teammate — and everything
 * after that marker is then the rest of an ordinary message. Measuring it by
 * line count or by size rejected a plain end-of-day handoff that held no code
 * at all, and a rejected post is a message the member never gets to send.
 *
 * So the tail must read as code before it is measured. `estimateFlatLines`
 * counts the punctuation that ends a statement, which prose does not carry in
 * that density. The size backstop does not apply here: it exists for a payload
 * whose shape cannot be read, and an unreadable shape is exactly what an
 * ordinary sentence looks like.
 */
function measureUnterminatedTail(tail: string): string | null {
  const flat = tail.trim();
  const estimated = estimateFlatLines(flat.replace(/\s+/g, " "));
  if (estimated <= MAX_FENCE_LINES) return null;
  return measureFencePayload(tail);
}

/**
 * Find smuggled code in a message body.
 * Returns a short summary of the match, or null when the body is clean.
 * The summary must not echo the body itself.
 */
export function findSmuggledContent(body: string): string | null {
  // The opening marker no longer requires a newline after it. Requiring one
  // meant a flattened fence was not a fence at all and was never measured.
  const fence = /```([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(body)) !== null) {
    const verdict = measureFencePayload(m[1] ?? "");
    if (verdict) return verdict;
  }
  // A fence with no closing marker. The pair above never sees one, and this
  // is the common shape rather than the rare one: a caller that cuts a paste
  // to fit a length cap drops the end of it, and `why_trigger` is capped at
  // 600 characters, which a real paste passes easily. The markers pair from
  // the left, so an odd count leaves the last one unmatched and everything
  // after it is payload.
  const markers = body.match(/```/g)?.length ?? 0;
  if (markers % 2 === 1) {
    const verdict = measureUnterminatedTail(body.slice(body.lastIndexOf("```") + 3));
    if (verdict) return verdict;
  }
  if (DIFF_MARKERS.some((re) => re.test(body))) {
    return "unified diff markers";
  }
  if (/[A-Za-z0-9+/=]{512,}/.test(body)) {
    return "base64 run over 512 chars";
  }
  return null;
}

/**
 * The fields an agent or human sends when they post a message.
 *
 * Spec 002 (T089): `thread_id` and `force` join the envelope. A null or
 * absent `thread_id` means a project broadcast (FR-011). `force` defaults
 * to `advisory`; the relay checks authority before accepting `binding`
 * (FR-043). The five message types are unchanged.
 */
export const MessagePostSchema = z.object({
  type: z.enum(MESSAGE_TYPES),
  body: z.string().min(1).max(MAX_BODY_LENGTH),
  refs: z.array(GitRefSchema).max(MAX_REFS).default([]),
  work_item: z.string().min(1).max(MAX_LABEL_LENGTH).optional(),
  target: z.string().min(1).max(MAX_LABEL_LENGTH).optional(),
  thread_id: UlidSchema.nullable().optional(),
  force: z.enum(MESSAGE_FORCES).default(DEFAULT_FORCE)
});
export type MessagePost = z.infer<typeof MessagePostSchema>;

/** The free-text fields of a post. `body` is checked separately. */
const LABEL_FIELDS = ["work_item", "target"] as const;

export type PostValidation =
  | { ok: true; post: MessagePost }
  | { ok: false; reason: RejectionReason; summary: string };

/** Validate one outbound or inbound post against every boundary rule. */
export function validatePost(input: unknown): PostValidation {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "not_json", summary: "payload is not an object" };
  }
  const raw = input as Record<string, unknown>;
  if (
    typeof raw.type !== "string" ||
    !MESSAGE_TYPES.includes(raw.type as MessageType)
  ) {
    return { ok: false, reason: "unknown_type", summary: "message type is not valid" };
  }
  if (typeof raw.body === "string" && raw.body.length > MAX_BODY_LENGTH) {
    return {
      ok: false,
      reason: "payload_too_large",
      summary: `body over ${MAX_BODY_LENGTH} chars`
    };
  }
  // Size is judged before the schema so an over-long label reports its true
  // reason rather than the shape-is-not-valid one the schema would give.
  for (const field of LABEL_FIELDS) {
    const value = raw[field];
    if (typeof value === "string" && value.length > MAX_LABEL_LENGTH) {
      return {
        ok: false,
        reason: "payload_too_large",
        summary: `${field} over ${MAX_LABEL_LENGTH} chars`
      };
    }
  }
  // The two 002 fields carry no free text by construction. A wrong value
  // still gets its true reason rather than the generic shape error.
  if (raw.thread_id !== undefined && raw.thread_id !== null) {
    if (typeof raw.thread_id !== "string" || !isValidUlid(raw.thread_id)) {
      return { ok: false, reason: "not_json", summary: "thread id is not valid" };
    }
  }
  if (raw.force !== undefined) {
    if (
      typeof raw.force !== "string" ||
      !MESSAGE_FORCES.includes(raw.force as MessageForce)
    ) {
      return { ok: false, reason: "not_json", summary: "force is not valid" };
    }
  }
  const parsed = MessagePostSchema.safeParse(input);
  if (!parsed.success) {
    const refIssue = parsed.error.issues.find((i) => i.path[0] === "refs");
    if (refIssue) {
      return { ok: false, reason: "invalid_ref", summary: "a git ref is not valid" };
    }
    return { ok: false, reason: "not_json", summary: "payload shape is not valid" };
  }
  const smuggled = findSmuggledContent(parsed.data.body);
  if (smuggled) {
    return { ok: false, reason: "content_smuggling", summary: smuggled };
  }
  // `body` is not the only free text on a post: `work_item` and `target`
  // cross to the peer the same way and were unchecked until T070.
  for (const field of LABEL_FIELDS) {
    const value = parsed.data[field];
    if (value === undefined) continue;
    const found = findSmuggledContent(value);
    if (found) {
      return { ok: false, reason: "content_smuggling", summary: `${field}: ${found}` };
    }
  }
  return { ok: true, post: parsed.data };
}

/** A message after the relay accepts it and assigns order. */
export interface StoredMessage {
  id: string;
  seq: number;
  /**
   * The message's position inside its thread (spec 002, contracts §2.2).
   * Assigned by the relay. Absent on rows stored before the upgrade and on
   * project broadcasts.
   */
  thread_seq?: number;
  sender: string;
  sender_kind: "agent" | "human" | "companion";
  type: MessageType;
  body: string;
  refs: GitRef[];
  target?: string;
  /** Null means a project broadcast. Absent on rows from before the upgrade. */
  thread_id?: string | null;
  force?: MessageForce;
  /** The v0 tag. Kept on historic rows; new posts carry `thread_id`. */
  work_item?: string;
  sent_at: string;
}
