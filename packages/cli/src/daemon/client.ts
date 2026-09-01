// The daemon's relay client (T019).
// One WebSocket to the relay. Reconnect with backoff. Sync replay on connect.
// Request frames resolve in FIFO order: the relay answers one frame at a time.
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@saw/shared";
import type {
  ClaimResultFrame,
  ErrorFrame,
  HelloOkFrame,
  LogQuery,
  LogResultFrame,
  MessagePost,
  PresenceFrame,
  PauseStateFrame,
  RunLogEntryInput,
  ServerFrame,
  AutoModeFrame,
  StoredHandoff,
  StoredMessage,
  StoredSession,
  StoredThread,
  WakeFrame,
  StoredThreadMode,
  ThreadOpen,
  ThreadRefBinding,
  ThreadSnapshotFrame,
  UnboundRef
} from "@saw/shared";

export interface RelayClientOptions {
  wsUrl: string;
  workspaceId: string;
  token: string;
  clientName?: string;
  /** Seq of the last message this member already has. Sync starts after it. */
  sinceSeq?: number;
}

export interface RelayClientHandlers {
  onHello?: (frame: HelloOkFrame) => void;
  onMessage?: (message: StoredMessage) => void;
  onClaimResult?: (frame: ClaimResultFrame) => void;
  onPresence?: (frame: PresenceFrame) => void;
  onPauseState?: (frame: PauseStateFrame) => void;
  onConnectionChange?: (connected: boolean) => void;
  onServerError?: (frame: ErrorFrame) => void;
  onThreadSnapshot?: (frame: ThreadSnapshotFrame) => void;
  onThread?: (thread: StoredThread) => void;
  onThreadMode?: (mode: StoredThreadMode) => void;
  onThreadRef?: (binding: ThreadRefBinding) => void;
  onHandoff?: (handoff: StoredHandoff) => void;
  onSession?: (session: StoredSession) => void;
  onAutoMode?: (frame: AutoModeFrame) => void;
  onWake?: (frame: WakeFrame) => void;
}

export type ThreadOpenOutcome =
  | { ok: true; thread: StoredThread }
  | { ok: false; message: string };

export type PostOutcome =
  | { ok: true; seq: number; sent_at: string; unbound_refs?: UnboundRef[] }
  | { ok: false; code: "rejected" | "not_connected"; message: string };

export type LogAppendOutcome =
  | { ok: true; id: string }
  | { ok: false; message: string };

export type LogQueryOutcome =
  | { ok: true; result: LogResultFrame }
  | { ok: false; message: string };

interface Pending<T> {
  resolve: (value: T) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

export class RelayClient {
  private options: RelayClientOptions;
  private handlers: RelayClientHandlers;
  private ws: WebSocket | undefined;
  private closed = false;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private helloed = false;
  /** Highest seq seen. The next sync request starts after this seq. */
  lastSeenSeq: number;

  private pendingPosts: Pending<PostOutcome>[] = [];
  private pendingAppends: Pending<LogAppendOutcome>[] = [];
  private pendingQueries: Pending<LogQueryOutcome>[] = [];
  private pendingThreadOpens: Pending<ThreadOpenOutcome>[] = [];
  /** This member's name, from hello_ok. Correlates thread_open answers. */
  private memberName?: string;

  constructor(options: RelayClientOptions, handlers: RelayClientHandlers) {
    this.options = options;
    this.handlers = handlers;
    this.lastSeenSeq = options.sinceSeq ?? 0;
  }

  get connected(): boolean {
    return this.helloed && this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.options.wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.send({
        kind: "hello",
        workspace_id: this.options.workspaceId,
        token: this.options.token,
        client: this.options.clientName ?? "saw-daemon/0.1",
        protocol: PROTOCOL_VERSION
      });
    });

    ws.on("message", (data) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(data)) as ServerFrame;
      } catch {
        return;
      }
      this.dispatch(frame);
    });

    ws.on("close", () => this.handleDown());
    ws.on("error", () => {
      // The close event follows and drives the reconnect.
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.failAllPending("the daemon closed the relay connection");
    this.ws?.close();
  }

  /** Post one message. Resolves with the relay verdict. */
  post(post: MessagePost, senderKind: "agent" | "human"): Promise<PostOutcome> {
    if (!this.connected) {
      return Promise.resolve({
        ok: false,
        code: "not_connected",
        message: "the relay is not connected"
      });
    }
    return new Promise<PostOutcome>((resolve) => {
      this.pendingPosts.push(
        this.pending<PostOutcome>(resolve, {
          ok: false,
          code: "not_connected",
          message: "the relay did not answer in time"
        })
      );
      this.send({ kind: "post", post, sender_kind: senderKind });
    });
  }

  /** Set (or read) this member's own mode on a thread (spec 002 US8). */
  threadModeSet(threadId: string, mode?: "view" | "comment" | "edit"): void {
    if (!this.connected) return;
    this.send({ kind: "thread_mode_set", set: { thread_id: threadId, mode } });
  }

  /** Propose (or direct) a handoff. The answer arrives as a handoff frame. */
  handoffPropose(propose: {
    thread_id: string;
    to: string;
    tip_ref: { kind: "branch" | "commit"; value: string };
    directed?: boolean;
  }): void {
    if (!this.connected) return;
    this.send({ kind: "handoff_propose", propose });
  }

  /** Accept, decline, or withdraw a handoff. */
  handoffResolve(handoffId: string, toState: "accepted" | "declined" | "withdrawn"): void {
    if (!this.connected) return;
    this.send({ kind: "handoff_resolve", handoff_id: handoffId, to_state: toState });
  }

  /** Auto mode and sessions (spec 002 US9). All writes are self-directed. */
  autoModeSet(threadId: string, enabled: boolean): void {
    if (!this.connected) return;
    this.send({ kind: "auto_mode_set", set: { thread_id: threadId, enabled } });
  }

  sessionReady(threadId: string, task?: string, maxTurns?: number): void {
    if (!this.connected) return;
    this.send({
      kind: "session_ready",
      ready: { thread_id: threadId, ...(task ? { task } : {}), ...(maxTurns ? { max_turns: maxTurns } : {}) }
    });
  }

  sessionEnd(sessionId: string): void {
    if (!this.connected) return;
    this.send({ kind: "session_end", session_id: sessionId });
  }

  convergePropose(sessionId: string, summary: string, refs: { kind: "branch" | "commit"; value: string }[]): void {
    if (!this.connected) return;
    this.send({ kind: "converge_propose", propose: { session_id: sessionId, summary, refs } });
  }

  convergeApprove(sessionId: string): void {
    if (!this.connected) return;
    this.send({ kind: "converge_approve", session_id: sessionId });
  }

  claimApprove(threadId: string): void {
    if (!this.connected) return;
    this.send({ kind: "claim_approve", thread_id: threadId });
  }

  /** Open a thread. Resolves with the thread the relay made (spec 002). */
  threadOpen(open: ThreadOpen): Promise<ThreadOpenOutcome> {
    if (!this.connected) {
      return Promise.resolve({
        ok: false,
        message: "the relay is not connected"
      });
    }
    return new Promise<ThreadOpenOutcome>((resolve) => {
      this.pendingThreadOpens.push(
        this.pending<ThreadOpenOutcome>(resolve, {
          ok: false,
          message: "the relay did not answer in time"
        })
      );
      this.send({ kind: "thread_open", open });
    });
  }

  /** Append one run to the work log. */
  logAppend(entry: RunLogEntryInput): Promise<LogAppendOutcome> {
    if (!this.connected) {
      return Promise.resolve({ ok: false, message: "the relay is not connected" });
    }
    return new Promise<LogAppendOutcome>((resolve) => {
      this.pendingAppends.push(
        this.pending<LogAppendOutcome>(resolve, {
          ok: false,
          message: "the relay did not answer in time"
        })
      );
      this.send({ kind: "log_append", entry });
    });
  }

  /** Query the work log, with or without peer activity. */
  logQuery(query: Partial<LogQuery>, peerActivity: boolean): Promise<LogQueryOutcome> {
    if (!this.connected) {
      return Promise.resolve({ ok: false, message: "the relay is not connected" });
    }
    return new Promise<LogQueryOutcome>((resolve) => {
      this.pendingQueries.push(
        this.pending<LogQueryOutcome>(resolve, {
          ok: false,
          message: "the relay did not answer in time"
        })
      );
      this.send({ kind: "log_query", query, peer_activity: peerActivity });
    });
  }

  /** Set the pause state of this member. The relay echoes pause_state. */
  setPause(paused: boolean): void {
    this.send({ kind: "pause_set", paused });
  }

  /** Ask the relay to replay messages after a seq. */
  sync(sinceSeq: number): void {
    this.send({ kind: "sync", since_seq: sinceSeq });
  }

  /**
   * Record a seq this member already has. The relay sends post_ok for an
   * own post, not a message frame, so the daemon reports the seq here.
   */
  noteSeq(seq: number): void {
    if (seq > this.lastSeenSeq) this.lastSeenSeq = seq;
  }

  private pending<T>(resolve: (value: T) => void, timeoutValue: T): Pending<T> {
    const entry: Pending<T> = {
      resolve,
      timer: setTimeout(() => {
        const lists = [
          this.pendingPosts,
          this.pendingAppends,
          this.pendingQueries,
          this.pendingThreadOpens
        ];
        for (const list of lists) {
          const index = list.indexOf(entry as never);
          if (index >= 0) list.splice(index, 1);
        }
        resolve(timeoutValue);
      }, REQUEST_TIMEOUT_MS)
    };
    return entry;
  }

  private take<T>(list: Pending<T>[]): Pending<T> | undefined {
    const entry = list.shift();
    if (entry) clearTimeout(entry.timer);
    return entry;
  }

  private dispatch(frame: ServerFrame): void {
    switch (frame.kind) {
      case "hello_ok":
        this.helloed = true;
        this.attempts = 0;
        this.memberName = frame.member;
        this.handlers.onHello?.(frame);
        this.handlers.onConnectionChange?.(true);
        this.sync(this.lastSeenSeq);
        return;
      case "message":
        if (frame.message.seq > this.lastSeenSeq) this.lastSeenSeq = frame.message.seq;
        this.handlers.onMessage?.(frame.message);
        return;
      case "post_ok":
        this.take(this.pendingPosts)?.resolve({
          ok: true,
          seq: frame.seq,
          sent_at: frame.sent_at,
          ...(frame.unbound_refs?.length ? { unbound_refs: frame.unbound_refs } : {})
        });
        return;
      case "post_rejected":
        this.take(this.pendingPosts)?.resolve({
          ok: false,
          code: "rejected",
          message: `${frame.reason}: ${frame.summary}`
        });
        return;
      case "claim_result":
        this.handlers.onClaimResult?.(frame);
        return;
      case "thread_snapshot":
        this.handlers.onThreadSnapshot?.(frame);
        return;
      case "thread":
        // The relay answers a thread_open with the thread it made, straight
        // to the opener. Threads other members opened arrive here too, so a
        // pending open takes only a thread this member created.
        if (frame.thread.created_by === this.memberName) {
          this.take(this.pendingThreadOpens)?.resolve({ ok: true, thread: frame.thread });
        }
        this.handlers.onThread?.(frame.thread);
        return;
      case "thread_mode":
        this.handlers.onThreadMode?.(frame.mode);
        return;
      case "handoff":
        this.handlers.onHandoff?.(frame.handoff);
        return;
      case "session":
        this.handlers.onSession?.(frame.session);
        return;
      case "auto_mode":
        this.handlers.onAutoMode?.(frame);
        return;
      case "wake":
        this.handlers.onWake?.(frame);
        return;
      case "thread_ref":
        this.handlers.onThreadRef?.(frame.binding);
        return;
      case "log_ok":
        this.take(this.pendingAppends)?.resolve({ ok: true, id: frame.id });
        return;
      case "log_result":
        this.take(this.pendingQueries)?.resolve({ ok: true, result: frame });
        return;
      case "presence":
        this.handlers.onPresence?.(frame);
        return;
      case "pause_state":
        this.handlers.onPauseState?.(frame);
        return;
      case "pong":
        return;
      case "error":
        if (frame.code === "unknown_thread" || frame.code === "no_authority") {
          this.take(this.pendingPosts)?.resolve({
            ok: false,
            code: "rejected",
            message: frame.message
          });
          return;
        }
        this.handlers.onServerError?.(frame);
        if (frame.code === "auth_failed") this.closed = true;
        return;
    }
  }

  private handleDown(): void {
    const wasConnected = this.helloed;
    this.helloed = false;
    this.ws = undefined;
    this.failAllPending("the relay connection dropped");
    if (wasConnected) this.handlers.onConnectionChange?.(false);
    if (this.closed) return;
    const backoff = Math.min(1000 * 2 ** this.attempts, MAX_BACKOFF_MS);
    const jitter = backoff * (0.8 + Math.random() * 0.4);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), jitter);
    this.reconnectTimer.unref?.();
  }

  private failAllPending(message: string): void {
    for (const entry of this.pendingPosts.splice(0)) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code: "not_connected", message });
    }
    for (const entry of this.pendingAppends.splice(0)) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, message });
    }
    for (const entry of this.pendingQueries.splice(0)) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, message });
    }
  }

  private send(frame: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }
}
