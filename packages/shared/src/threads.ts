// Thread and handoff schemas (T087, T091 — spec 002 US7/US8).
// A thread is the unit of collaboration. It replaces the flat room as the
// container: messages post into a thread, claims and handoffs are
// thread-scoped, and refs bind to threads. See data-model.md and
// contracts/threads-and-modes.md.
import { z } from "zod";
import {
  findSmuggledContent,
  GitRefSchema,
  isValidUlid,
  MAX_LABEL_LENGTH,
  UlidSchema,
  type GitRef,
  type RejectionReason
} from "./messages.js";

export const THREAD_TYPES = ["work_item", "brainstorm", "general"] as const;
export type ThreadType = (typeof THREAD_TYPES)[number];

/**
 * v1 permits one scope. The column exists so phase 3 widens it to
 * team/group/private as data, not schema (data-model.md).
 */
export const THREAD_SCOPES = ["project"] as const;
export type ThreadScope = (typeof THREAD_SCOPES)[number];

export const THREAD_STATES = ["open", "done", "archived"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export const MAX_THREAD_TITLE_LENGTH = 200;

/** A thread id is a ULID the relay assigned. Nothing else may claim to be one. */
export function isValidThreadId(value: string): boolean {
  return isValidUlid(value);
}

export const ThreadIdSchema = UlidSchema;

/** The fields a member sends to open a thread (contracts §1.2). */
export const ThreadOpenSchema = z.object({
  type: z.enum(THREAD_TYPES),
  title: z.string().min(1).max(MAX_THREAD_TITLE_LENGTH),
  workspace_id: z.string().min(1)
});
export type ThreadOpen = z.infer<typeof ThreadOpenSchema>;

export type ThreadOpenValidation =
  | { ok: true; open: ThreadOpen }
  | { ok: false; reason: RejectionReason; summary: string };

/**
 * Validate a thread-open against the boundary rules (FR-025, T090).
 * A title is free text that crosses between members, so it gets the same
 * treatment a message body gets.
 */
export function validateThreadOpen(input: unknown): ThreadOpenValidation {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "not_json", summary: "payload is not an object" };
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.title === "string" && raw.title.length > MAX_THREAD_TITLE_LENGTH) {
    return {
      ok: false,
      reason: "payload_too_large",
      summary: `title over ${MAX_THREAD_TITLE_LENGTH} chars`
    };
  }
  const parsed = ThreadOpenSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "not_json", summary: "payload shape is not valid" };
  }
  const smuggled = findSmuggledContent(parsed.data.title);
  if (smuggled) {
    return { ok: false, reason: "content_smuggling", summary: `title: ${smuggled}` };
  }
  return { ok: true, open: parsed.data };
}

/** A thread after the relay accepts it and assigns identity. */
export interface StoredThread {
  id: string;
  workspace_id: string;
  type: ThreadType;
  title: string;
  scope: ThreadScope;
  state: ThreadState;
  created_by: string;
  created_at: string;
  /** The v0 work-item tag this thread came from. Null after the upgrade. */
  migrated_from_tag: string | null;
}

/** A ref bound to a thread. Many-to-many; every ref names its workspace (FR-014). */
export interface ThreadRefBinding {
  thread_id: string;
  workspace_id: string;
  ref: GitRef;
}

// ---- Handoff (T091, FR-044) ----

export const HANDOFF_STATES = ["proposed", "accepted", "declined", "withdrawn"] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

/** Who may perform a handoff transition. */
export type HandoffActor = "from_member" | "to_member" | "system";

/**
 * The allowed transitions (data-model.md). `proposed` is the only live
 * state; the other three are terminal. `system` stands for the relay
 * withdrawing a handoff when the recipient is removed or leaves scope,
 * recorded as such.
 */
const HANDOFF_TRANSITIONS: Record<HandoffState, Partial<Record<HandoffState, HandoffActor[]>>> = {
  proposed: {
    accepted: ["to_member"],
    declined: ["to_member"],
    withdrawn: ["from_member", "system"]
  },
  accepted: {},
  declined: {},
  withdrawn: {}
};

/** True when `actor` may move a handoff from one state to another. */
export function canTransitionHandoff(
  from: HandoffState,
  to: HandoffState,
  actor: HandoffActor
): boolean {
  return (HANDOFF_TRANSITIONS[from][to] ?? []).includes(actor);
}

/** The fields a member sends to propose a handoff (contracts §1.4). */
export const HandoffProposeSchema = z.object({
  thread_id: ThreadIdSchema,
  to: z.string().min(1).max(MAX_LABEL_LENGTH),
  tip_ref: GitRefSchema
});
export type HandoffPropose = z.infer<typeof HandoffProposeSchema>;

export type HandoffProposeValidation =
  | { ok: true; propose: HandoffPropose }
  | { ok: false; reason: RejectionReason; summary: string };

/** Validate a handoff proposal against the boundary rules (FR-025, T090). */
export function validateHandoffPropose(input: unknown): HandoffProposeValidation {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "not_json", summary: "payload is not an object" };
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.to === "string" && raw.to.length > MAX_LABEL_LENGTH) {
    return {
      ok: false,
      reason: "payload_too_large",
      summary: `to over ${MAX_LABEL_LENGTH} chars`
    };
  }
  const parsed = HandoffProposeSchema.safeParse(input);
  if (!parsed.success) {
    const refIssue = parsed.error.issues.find((i) => i.path[0] === "tip_ref");
    if (refIssue) {
      return { ok: false, reason: "invalid_ref", summary: "tip ref is not valid" };
    }
    return { ok: false, reason: "not_json", summary: "payload shape is not valid" };
  }
  // `to` is a member name: short free text that crosses. Same rules as a label.
  const smuggled = findSmuggledContent(parsed.data.to);
  if (smuggled) {
    return { ok: false, reason: "content_smuggling", summary: `to: ${smuggled}` };
  }
  return { ok: true, propose: parsed.data };
}

/** A handoff after the relay accepts it (FR-044). */
export interface StoredHandoff {
  id: string;
  thread_id: string;
  from_member: string;
  to_member: string;
  state: HandoffState;
  tip_ref: GitRef;
  /** True when an owner directed it with binding force (FR-044). */
  directed: boolean;
  created_at: string;
  resolved_at: string | null;
}
