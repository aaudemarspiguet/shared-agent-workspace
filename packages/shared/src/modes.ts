// Collaboration modes (T088 — spec 002 US8, FR-037..FR-042).
// A mode is set per thread by a member for their OWN agent. It says what
// that agent may do there. It is self-granted: the party it restrains and
// the party who could bypass it are the same member, so the relay does not
// enforce the ladder — it enforces exactly one cross-member rule, that
// nobody may write another member's mode (contracts §2.3, research R1).
import { z } from "zod";
import { ThreadIdSchema } from "./threads.js";

/** The ladder, weakest first. */
export const MODES = ["view", "comment", "edit"] as const;
export type Mode = (typeof MODES)[number];

export const ModeSchema = z.enum(MODES);

/** Absent row means this. The default is not stored (data-model.md). */
export const DEFAULT_MODE: Mode = "comment";

/**
 * Threads created by the FR-009(a) migration start here for every member.
 * v0 agents could already claim, and `comment` forbids claiming, so the
 * default would have silently removed a capability (research R3, T101).
 */
export const MIGRATED_THREAD_MODE: Mode = "edit";

/** True when `mode` sits at or above `required` on the ladder. */
export function modeAtLeast(mode: Mode, required: Mode): boolean {
  return MODES.indexOf(mode) >= MODES.indexOf(required);
}

/** The mode each kind of action needs (contracts §1.1, §3). */
export const ACTION_MODES = {
  read: "view",
  post: "comment",
  claim: "edit",
  bind_ref: "edit",
  accept_handoff: "edit"
} as const satisfies Record<string, Mode>;
export type ModeGatedAction = keyof typeof ACTION_MODES;

/** True when a member in `mode` may perform `action`. */
export function modeAllows(mode: Mode, action: ModeGatedAction): boolean {
  return modeAtLeast(mode, ACTION_MODES[action]);
}

/**
 * The fields a member sends to read or set their own mode (contracts §1.3).
 *
 * There is deliberately NO field for another member's id. The relay applies
 * a mode write to the authenticated sender and nobody else, so the
 * authorization is structural — not a parameter to be checked (SC-016).
 */
export const ThreadModeSetSchema = z.object({
  thread_id: ThreadIdSchema,
  /** Omitted means read the current value. */
  mode: ModeSchema.optional()
});
export type ThreadModeSet = z.infer<typeof ThreadModeSetSchema>;

/** One member's mode on one thread, as the relay returns it. */
export interface StoredThreadMode {
  thread_id: string;
  member: string;
  mode: Mode;
  set_at: string;
}
