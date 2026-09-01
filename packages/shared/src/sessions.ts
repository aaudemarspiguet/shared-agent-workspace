// Auto mode and sessions (spec 002 US9, T148 — FR-049..FR-052).
// A session is two members' standing consent made concrete: an agreed task,
// a readiness declaration from each, per-member turn budgets, and a
// convergence that only a human concludes. The wake rule lives here as a
// pure function so the relay, the daemon, and the tests share one law.
import { z } from "zod";
import {
  findSmuggledContent,
  MAX_REFS,
  UlidSchema,
  type GitRef,
  type RejectionReason
} from "./messages.js";
import { GitRefSchema } from "./messages.js";
import { ThreadIdSchema } from "./threads.js";

/** Turn budget bounds. The default is the founders' number (session 2026-08-31). */
export const DEFAULT_MAX_TURNS = 50;
export const MIN_MAX_TURNS = 1;
export const MAX_MAX_TURNS = 500;

/** Caps on the session free text. Both fields get full boundary treatment. */
export const MAX_SESSION_TASK_LENGTH = 600;
export const MAX_CONVERGENCE_SUMMARY_LENGTH = 2000;

/**
 * A session's life. `forming` holds from the first readiness until the
 * second. `live` is both-ready. `suspended` is a budget stop waiting for a
 * human's word (FR-051). `converged` is a proposal waiting for approval.
 * `concluded` is a human-approved end. `ended` is a stop without approval —
 * by a human, or by budget with nobody resuming — recorded as unconcluded.
 */
export const SESSION_STATES = [
  "forming",
  "live",
  "suspended",
  "converged",
  "concluded",
  "ended"
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** One member's part in a session. */
export interface SessionMember {
  member: string;
  ready_at: string | null;
  max_turns: number;
  turns_used: number;
}

/** An agent's convergence proposal (FR-052). Concluding needs its member. */
export interface ConvergenceProposal {
  proposed_by: string;
  summary: string;
  refs: GitRef[];
  proposed_at: string;
  approved_by: string | null;
  approved_at: string | null;
}

/** A session after the relay accepts it. */
export interface StoredSession {
  id: string;
  thread_id: string;
  /** The agreed task, from the first readiness declaration. */
  task: string;
  state: SessionState;
  members: SessionMember[];
  convergence: ConvergenceProposal | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  /** Who ended or suspended it: a member name, or "budget". */
  ended_by: string | null;
}

// ---- Client payloads. Every write is self-directed: no payload carries ----
// ---- another member's name as a target of the write (the SC-016 rule). ----

/** Turn auto mode on or off for YOUR OWN agent on a thread. */
export const AutoModeSetSchema = z.object({
  thread_id: ThreadIdSchema,
  enabled: z.boolean()
});
export type AutoModeSet = z.infer<typeof AutoModeSetSchema>;

/**
 * Declare readiness. The first declaration on a thread names the task and
 * creates the session (forming); the second makes it live. `max_turns` is
 * the declarer's own budget; absent means the default.
 *
 * `task` is optional in the PAYLOAD because only the first declaration
 * carries it — but a session always has one: the relay MUST refuse a
 * first readiness with no task (FR-050), so `StoredSession.task` is never
 * empty. Stated here so the guarantee lives in the law, not in a
 * handler's memory.
 */
export const SessionReadySchema = z.object({
  thread_id: ThreadIdSchema,
  task: z.string().min(1).max(MAX_SESSION_TASK_LENGTH).optional(),
  max_turns: z.number().int().min(MIN_MAX_TURNS).max(MAX_MAX_TURNS).optional()
});
export type SessionReady = z.infer<typeof SessionReadySchema>;

/** End (or, from forming, leave) a session. Either human may, any time. */
export const SessionEndSchema = z.object({
  session_id: UlidSchema
});
export type SessionEnd = z.infer<typeof SessionEndSchema>;

/** An agent proposes the session's work is done (FR-052). */
export const ConvergeProposeSchema = z.object({
  session_id: UlidSchema,
  summary: z.string().min(1).max(MAX_CONVERGENCE_SUMMARY_LENGTH),
  refs: z.array(GitRefSchema).max(MAX_REFS).default([])
});
export type ConvergePropose = z.infer<typeof ConvergeProposeSchema>;

/** The proposing agent's own member approves; the session concludes. */
export const ConvergeApproveSchema = z.object({
  session_id: UlidSchema
});
export type ConvergeApprove = z.infer<typeof ConvergeApproveSchema>;

/** A member approves their own agent's proposed-done on a solo claim (T155). */
export const ClaimApproveSchema = z.object({
  thread_id: ThreadIdSchema
});
export type ClaimApprove = z.infer<typeof ClaimApproveSchema>;

export type SessionInputValidation<T> =
  | { ok: true; value: T }
  | { ok: false; reason: RejectionReason; summary: string };

/** Boundary treatment for the session task text (FR-025). */
export function validateSessionReady(input: unknown): SessionInputValidation<SessionReady> {
  // Size is judged before the schema so an over-long task reports its true
  // reason rather than the shape-is-not-valid one the schema would give
  // (the validatePost rule, applied here).
  const rawTask = (input as { task?: unknown } | null)?.task;
  if (typeof rawTask === "string" && rawTask.length > MAX_SESSION_TASK_LENGTH) {
    return {
      ok: false,
      reason: "payload_too_large",
      summary: `task over ${MAX_SESSION_TASK_LENGTH} chars`
    };
  }
  const parsed = SessionReadySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "not_json", summary: "readiness payload shape is not valid" };
  }
  if (parsed.data.task !== undefined) {
    const smuggled = findSmuggledContent(parsed.data.task);
    if (smuggled) {
      return { ok: false, reason: "content_smuggling", summary: `task: ${smuggled}` };
    }
  }
  return { ok: true, value: parsed.data };
}

/** Boundary treatment for the convergence summary (FR-025). */
export function validateConvergePropose(
  input: unknown
): SessionInputValidation<ConvergePropose> {
  const rawSummary = (input as { summary?: unknown } | null)?.summary;
  if (typeof rawSummary === "string" && rawSummary.length > MAX_CONVERGENCE_SUMMARY_LENGTH) {
    return {
      ok: false,
      reason: "payload_too_large",
      summary: `summary over ${MAX_CONVERGENCE_SUMMARY_LENGTH} chars`
    };
  }
  const parsed = ConvergeProposeSchema.safeParse(input);
  if (!parsed.success) {
    const refIssue = parsed.error.issues.find((i) => i.path[0] === "refs");
    if (refIssue) {
      return { ok: false, reason: "invalid_ref", summary: "a proposal ref is not valid" };
    }
    return { ok: false, reason: "not_json", summary: "proposal payload shape is not valid" };
  }
  const smuggled = findSmuggledContent(parsed.data.summary);
  if (smuggled) {
    return { ok: false, reason: "content_smuggling", summary: `summary: ${smuggled}` };
  }
  return { ok: true, value: parsed.data };
}

// ---- The wake rule (FR-049, FR-050) ----

/** Everything the wake decision may consider. Nothing else exists for it. */
export interface WakeQuestion {
  /** Who the arriving message is from, and which kind of author. */
  sender: string;
  sender_kind: "agent" | "human";
  /** The member whose agent might wake. */
  recipient: string;
  /** Does the recipient have auto mode on for this thread? */
  recipient_auto_on: boolean;
  /**
   * Is the recipient paused? Pause wins over every wake, own messages
   * included (FR-051, and the pause definition: it freezes the agent
   * instantly). A paused member's own typing does NOT wake their agent —
   * typing is not the resume control, and guessing otherwise would make
   * three callers guess differently. The surface tells a paused member
   * their agent will not wake until they resume.
   */
  recipient_paused: boolean;
  /**
   * The thread's session, when one exists and the message belongs to it.
   * `live_participants` are the members who are ready with auto mode on.
   */
  session: { state: SessionState; live_participants: string[] } | null;
}

export type WakeVerdict =
  | { wake: true; reason: "own_message" | "session_turn" }
  | { wake: false };

/**
 * The one law of waking (session 2026-08-31; consent framing of PR #182):
 *
 * 1. A member's own HUMAN message wakes their own agent. Their words are
 *    their prompt, whatever surface carried them.
 * 2. Inside a LIVE session, a participating agent's message wakes the other
 *    participating member's agent — that member consented at the readiness
 *    handshake, and budgets bound it (enforced by the caller, FR-051).
 * 3. Nothing else wakes anybody. Not the other member's messages, not any
 *    agent's message outside a session, not a member's own agent's message.
 * 0. Above all of it: a paused member's agent never wakes, whatever the
 *    message and whoever sent it. Pause ends only by the resume control.
 *
 * Pure on purpose: relay, daemon, and tests all call this same function.
 */
export function wakeEligible(q: WakeQuestion): WakeVerdict {
  if (q.recipient_paused) return { wake: false };
  if (q.sender_kind === "human" && q.sender === q.recipient) {
    return { wake: true, reason: "own_message" };
  }
  if (
    q.session !== null &&
    q.session.state === "live" &&
    q.sender_kind === "agent" &&
    q.sender !== q.recipient &&
    q.recipient_auto_on &&
    q.session.live_participants.includes(q.sender) &&
    q.session.live_participants.includes(q.recipient)
  ) {
    return { wake: true, reason: "session_turn" };
  }
  return { wake: false };
}
