// WebSocket frame schemas for the relay protocol.
// Every frame is JSON. The relay rejects every frame that does not match.
import { z } from "zod";
import { MessagePostSchema, type RejectionReason, type StoredMessage } from "./messages.js";
import { LogQuerySchema, RunLogEntryInputSchema, type StoredLogEntry } from "./log.js";

// ---- Client to relay ----

export const HelloFrameSchema = z.object({
  kind: z.literal("hello"),
  workspace_id: z.string().min(1),
  token: z.string().min(1),
  client: z.string().max(100).default("unknown")
});

export const PostFrameSchema = z.object({
  kind: z.literal("post"),
  // The post payload is validated again by validatePost for boundary reasons.
  post: MessagePostSchema.passthrough(),
  sender_kind: z.enum(["agent", "human"]).default("agent")
});

export const SyncFrameSchema = z.object({
  kind: z.literal("sync"),
  since_seq: z.number().int().nonnegative()
});

export const LogAppendFrameSchema = z.object({
  kind: z.literal("log_append"),
  entry: RunLogEntryInputSchema
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

export const ClientFrameSchema = z.discriminatedUnion("kind", [
  HelloFrameSchema,
  PostFrameSchema,
  SyncFrameSchema,
  LogAppendFrameSchema,
  LogQueryFrameSchema,
  PauseSetFrameSchema,
  PingFrameSchema
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// ---- Relay to client ----

export interface HelloOkFrame {
  kind: "hello_ok";
  member: string;
  latest_seq: number;
  paused: boolean;
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
  work_item: string;
  granted: boolean;
  claimed_by: string;
}
export interface LogOkFrame {
  kind: "log_ok";
  id: string;
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
export interface ErrorFrame {
  kind: "error";
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
  | PongFrame
  | ErrorFrame;
