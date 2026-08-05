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
  "not_json"
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

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

/**
 * Find smuggled code in a message body.
 * Returns a short summary of the match, or null when the body is clean.
 * The summary must not echo the body itself.
 */
export function findSmuggledContent(body: string): string | null {
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(body)) !== null) {
    const lines = (m[1] ?? "").split("\n").length;
    if (lines > 20) return `code fence with ${lines} lines`;
  }
  if (/^--- a\//m.test(body) || /^\+\+\+ b\//m.test(body) || /^@@ [^\n]*@@/m.test(body)) {
    return "unified diff markers";
  }
  if (/[A-Za-z0-9+/=]{512,}/.test(body)) {
    return "base64 run over 512 chars";
  }
  return null;
}

/** The fields an agent or human sends when they post a message. */
export const MessagePostSchema = z.object({
  type: z.enum(MESSAGE_TYPES),
  body: z.string().min(1).max(MAX_BODY_LENGTH),
  refs: z.array(GitRefSchema).max(MAX_REFS).default([]),
  work_item: z.string().min(1).max(MAX_LABEL_LENGTH).optional(),
  target: z.string().min(1).max(MAX_LABEL_LENGTH).optional()
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
  sender: string;
  sender_kind: "agent" | "human";
  type: MessageType;
  body: string;
  refs: GitRef[];
  target?: string;
  work_item?: string;
  sent_at: string;
}
