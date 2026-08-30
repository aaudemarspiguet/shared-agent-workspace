// WebSocket frame schemas for the relay protocol.
// Every frame is JSON. The relay rejects every frame that does not match.
import { z } from "zod";
import type { RejectionReason, StoredMessage } from "./messages.js";
import {
  LogQuerySchema,
  RunLogEntryWireSchema,
  type LogRedaction,
  type StoredLogEntry
} from "./log.js";
import { UlidSchema } from "./messages.js";
import type { StoredHandoff, StoredThread } from "./threads.js";
import { HANDOFF_STATES } from "./threads.js";
import type { StoredThreadMode } from "./modes.js";

/**
 * The protocol version this build speaks (spec 002 FR-035, T093).
 *
 * The version rides the first frame of a connection (`hello`). A first
 * frame without one is the pre-versioning v0 protocol. On mismatch the
 * NEWER party produces the plain instruction: a new relay refuses an old
 * client with `needs_upgrade`, and a new client that reaches a
 * pre-versioning relay tells its member the relay host must upgrade first.
 * No store is corrupted either way.
 */
export const PROTOCOL_VERSION = 1;

/** The error code a newer relay answers an older client with. */
export const NEEDS_UPGRADE_CODE = "needs_upgrade";

/** The plain instruction, for whichever side is older. */
export function needsUpgradeMessage(olderSide: "client" | "relay"): string {
  return olderSide === "client"
    ? "your saw version speaks an older protocol than this relay. Update saw, then run saw up again."
    : "the relay speaks an older protocol than this saw version. The relay host must update and restart the relay first.";
}

/**
 * Cap on one WebSocket frame, in bytes.
 *
 * Comfortably above the largest legitimate frame — a 4000-char post body with
 * ten refs, or a log entry with a hundred tool names — and far below the `ws`
 * default of 100 MiB. A frame that size is not a message (Principle II).
 */
export const MAX_FRAME_BYTES = 256 * 1024;

// ---- Client to relay ----

export const HelloFrameSchema = z.object({
  kind: z.literal("hello"),
  workspace_id: z.string().min(1),
  token: z.string().min(1),
  client: z.string().max(100).default("unknown"),
  /** Absent means the pre-versioning v0 protocol (FR-035). */
  protocol: z.number().int().positive().optional()
});

export const PostFrameSchema = z.object({
  kind: z.literal("post"),
  // The post payload stays opaque here. validatePost judges it at the
  // boundary, so a bad post gets its true rejection reason.
  post: z.unknown(),
  sender_kind: z.enum(["agent", "human"]).default("agent")
});

export const SyncFrameSchema = z.object({
  kind: z.literal("sync"),
  since_seq: z.number().int().nonnegative()
});

export const LogAppendFrameSchema = z.object({
  kind: z.literal("log_append"),
  // The entry parses leniently here. validateLogEntry applies the field rules
  // at the boundary, so an over-limit field is trimmed rather than costing
  // the whole run (FR-015, T073).
  entry: RunLogEntryWireSchema
});

export const LogQueryFrameSchema = z.object({
  kind: z.literal("log_query"),
  query: LogQuerySchema,
  /** When true, also return the peer's messages in the window. */
  peer_activity: z.boolean().default(false)
});

export const PauseSetFrameSchema = z.object({
  kind: z.literal("pause_set"),
  paused: z.boolean()
});

export const PingFrameSchema = z.object({ kind: z.literal("ping") });

// ---- Spec 002 client frames (threads, modes, handoffs) ----

export const ThreadOpenFrameSchema = z.object({
  kind: z.literal("thread_open"),
  // Opaque here; validateThreadOpen judges it at the boundary, so a bad
  // open gets its true rejection reason (the PostFrame pattern).
  open: z.unknown()
});

export const ThreadStateSetFrameSchema = z.object({
  kind: z.literal("thread_state_set"),
  thread_id: UlidSchema,
  state: z.enum(["open", "done", "archived"])
});

export const ThreadModeSetFrameSchema = z.object({
  kind: z.literal("thread_mode_set"),
  // Opaque; ThreadModeSetSchema judges it. The frame carries NO member
  // field: the relay applies the write to the authenticated sender and
  // nobody else (SC-016) — the authorization is structural.
  set: z.unknown()
});

export const ThreadRefBindFrameSchema = z.object({
  kind: z.literal("thread_ref_bind"),
  thread_id: UlidSchema,
  workspace_id: z.string().min(1),
  // Opaque; GitRefSchema judges it at the boundary.
  ref: z.unknown()
});

export const HandoffProposeFrameSchema = z.object({
  kind: z.literal("handoff_propose"),
  // Opaque; validateHandoffPropose judges it.
  propose: z.unknown()
});

export const HandoffResolveFrameSchema = z.object({
  kind: z.literal("handoff_resolve"),
  handoff_id: UlidSchema,
  to_state: z.enum(HANDOFF_STATES).exclude(["proposed"])
});

export const ClientFrameSchema = z.discriminatedUnion("kind", [
  HelloFrameSchema,
  PostFrameSchema,
  SyncFrameSchema,
  LogAppendFrameSchema,
  LogQueryFrameSchema,
  PauseSetFrameSchema,
  PingFrameSchema,
  ThreadOpenFrameSchema,
  ThreadStateSetFrameSchema,
  ThreadModeSetFrameSchema,
  ThreadRefBindFrameSchema,
  HandoffProposeFrameSchema,
  HandoffResolveFrameSchema
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// ---- Relay to client ----

export interface HelloOkFrame {
  kind: "hello_ok";
  member: string;
  latest_seq: number;
  paused: boolean;
  /** Absent from a pre-versioning relay (FR-035). */
  protocol?: number;
}
export interface MessageFrame {
  kind: "message";
  message: StoredMessage;
}
export interface PostOkFrame {
  kind: "post_ok";
  seq: number;
  sent_at: string;
}
export interface PostRejectedFrame {
  kind: "post_rejected";
  reason: RejectionReason;
  summary: string;
}
export interface ClaimResultFrame {
  kind: "claim_result";
  /**
   * Claims are thread-scoped in 002 (FR-013). `work_item` stays for rows
   * and clients from before the upgrade; new verdicts carry `thread_id`.
   */
  work_item: string;
  thread_id?: string;
  granted: boolean;
  claimed_by: string;
}
export interface LogOkFrame {
  kind: "log_ok";
  id: string;
  /** Present when the boundary removed something before storing the entry. */
  redacted?: LogRedaction[];
}
export interface LogResultFrame {
  kind: "log_result";
  entries: StoredLogEntry[];
  peer?: string;
  peer_online?: boolean;
  messages?: StoredMessage[];
}
export interface PresenceFrame {
  kind: "presence";
  member: string;
  online: boolean;
  last_seen_at: string;
}
export interface PauseStateFrame {
  kind: "pause_state";
  member: string;
  paused: boolean;
}
export interface PongFrame {
  kind: "pong";
}
/**
 * Snapshot of thread state, sent after hello_ok and on sync. The client
 * rebuilds its mirror from this plus the message replay.
 */
export interface ThreadSnapshotFrame {
  kind: "thread_snapshot";
  threads: StoredThread[];
  modes: StoredThreadMode[];
  handoffs: StoredHandoff[];
}
export interface ThreadFrame {
  kind: "thread";
  thread: StoredThread;
}
export interface ThreadModeFrame {
  kind: "thread_mode";
  mode: StoredThreadMode;
}
export interface HandoffFrame {
  kind: "handoff";
  handoff: StoredHandoff;
}
export interface ErrorFrame {
  kind: "error";
  /** `needs_upgrade` is NEEDS_UPGRADE_CODE (FR-035). */
  code: string;
  message: string;
}

export type ServerFrame =
  | HelloOkFrame
  | MessageFrame
  | PostOkFrame
  | PostRejectedFrame
  | ClaimResultFrame
  | LogOkFrame
  | LogResultFrame
  | PresenceFrame
  | PauseStateFrame
  | ThreadSnapshotFrame
  | ThreadFrame
  | ThreadModeFrame
  | HandoffFrame
  | PongFrame
  | ErrorFrame;
