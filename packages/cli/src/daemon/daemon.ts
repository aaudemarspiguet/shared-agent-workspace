// The member daemon.
// It owns the relay connection, the room state, the read cursor, the pause
// mirror, and the run context. Hooks, MCP tools, and the web page all talk
// to this daemon. The daemon never touches the peer's machine.
import type {
  ClaimResultFrame,
  ErrorFrame,
  LogQuery,
  MessagePost,
  PresenceFrame,
  PauseStateFrame,
  RunWhat,
  StoredLogEntry,
  StoredMessage
} from "@saw/shared";
import { readConfig, readCredential, type SawConfig,
  readState,
  writeState
} from "../config.js";
import { relayUrls } from "../relay-http.js";
import { RelayClient, type PostOutcome } from "./client.js";
import { ReadCursor } from "./cursor.js";
import { generateLocalToken } from "./local-auth.js";
import { LogSpool } from "./log-spool.js";
import { PauseMirror } from "./pause.js";
import { RunContext } from "./run-context.js";
import { RoomState, type ClaimNotice, type WorkItemView } from "./state.js";

export interface DaemonEvent {
  kind:
    | "message"
    | "presence"
    | "pause_state"
    | "claim_result"
    | "connection"
    | "threads"
    | "handoff";
  message?: StoredMessage;
  presence?: PresenceFrame;
  pause?: PauseStateFrame;
  claim?: ClaimResultFrame;
  connected?: boolean;
  handoff?: import("@saw/shared").StoredHandoff;
}

/** A binding decision waiting for this member's answer (T129). */
export interface PendingBinding {
  seq: number;
  thread_id: string;
  sender: string;
  body: string;
  at: string;
}

export interface InjectResult {
  /** Titles of the threads the unread messages live in (T114). */
  thread_titles: Record<string, string>;
  /** Unanswered binding decisions. Shown every turn until answered (T129). */
  binding_decisions: PendingBinding[];
  messages: StoredMessage[];
  notices: ClaimNotice[];
  paused: boolean;
  work_items: WorkItemView[];
  me: string;
  latest_seq: number;
  /** Pass back to `ackInjection` after delivery. The cursor stops here. */
  ack_seq: number;
  /** Number of notices delivered. Pass back to `ackInjection`. */
  ack_notices: number;
}

export interface WorkspaceStatus {
  workspace: string;
  repo_remote: string;
  members: { github_username: string; online: boolean; paused: boolean }[];
  me: string;
  paused: boolean;
  unread_count: number;
  work_items: WorkItemView[];
  /** Threads with claim state and this member's own mode (spec 002 T112). */
  threads: import("./state.js").ThreadView[];
  relay_connected: boolean;
}

export interface PeerActivity {
  peer: string | null;
  peer_online: boolean;
  runs: StoredLogEntry[];
  messages: StoredMessage[];
  note: string;
}

/**
 * The result of one Stop hook run.
 *
 * `ok` reports what the relay did. `spooled` reports that the run is held
 * locally and goes to the work log at the next reconnect. A caller that sees
 * `ok: false, spooled: true` must not retry: a retry would log the run twice.
 */
export type RunStopOutcome =
  | { ok: true; id: string; spooled: false }
  | { ok: false; message: string; spooled: boolean };

export interface DaemonOptions {
  /**
   * Reach the relay at this WebSocket URL instead of the one in the config.
   * `saw up` sets it when the config holds a tunnel address: the tunnel
   * serves the relay on a local port, and the daemon dials that port.
   */
  relayWsUrl?: string;
  root: string;
  clientName?: string;
  /** Cap on unsent runs held in .saw/log-spool.jsonl. Tests set it small. */
  logSpoolCapacity?: number;
}

export class Daemon {
  readonly root: string;
  readonly config: SawConfig;
  readonly state: RoomState;
  readonly cursor: ReadCursor;
  readonly pauseMirror: PauseMirror;
  readonly runContext: RunContext;
  /**
   * The run token for the local surfaces (T057). It is new for each daemon.
   * `saw up` writes it into .saw/daemon.json for hooks and MCP tools, and the
   * web server hands it to the room page in the served HTML.
   */
  readonly localToken = generateLocalToken();
  readonly logSpool: LogSpool;
  private client: RelayClient;
  private subscribers = new Set<(event: DaemonEvent) => void>();
  private pendingNotices: ClaimNotice[] = [];
  private pendingBindings: PendingBinding[] = [];
  /** The last error frame from the relay. It names a refused connection. */
  private lastRelayError: ErrorFrame | undefined;
  /** Set by `start` while it waits. A refused credential ends the wait. */
  private onRelayRefused: (() => void) | undefined;

  constructor(options: DaemonOptions) {
    this.root = options.root;
    const config = readConfig(options.root);
    const token = readCredential(options.root);
    if (!config || !token) {
      throw new Error("this repository has no SAW workspace. Run saw init or saw join first.");
    }
    this.config = config;
    this.state = new RoomState(config.github_username, config.members ?? []);
    this.cursor = new ReadCursor(options.root);
    this.pauseMirror = new PauseMirror(config.github_username);
    this.runContext = new RunContext(config.github_username);
    this.logSpool = new LogSpool(options.root, options.logSpoolCapacity);
    this.pendingBindings = readState(options.root).pending_bindings ?? [];

    this.client = new RelayClient(
      {
        wsUrl: options.relayWsUrl ?? relayUrls(config.relay_url).ws,
        workspaceId: config.workspace_id,
        token,
        clientName: options.clientName ?? "saw-daemon/0.1",
        // Start from zero so the room cache and the work item mirror rebuild
        // from full history. The cursor keeps injection idempotent.
        sinceSeq: 0
      },
      {
        onHello: (frame) => {
          this.pauseMirror.seedOwn(frame.paused);
        },
        onMessage: (message) => {
          if (this.state.addMessage(message)) {
            // A binding decision addressed at this workspace settles the
            // record and must reach this member's agent until answered
            // (T128, T129): it survives cursor advance and daemon restarts,
            // and clears when this member posts into its thread.
            if (
              message.force === "binding" &&
              message.sender !== this.config.github_username &&
              message.thread_id
            ) {
              this.pendingBindings.push({
                seq: message.seq,
                thread_id: message.thread_id,
                sender: message.sender,
                body: message.body,
                at: message.sent_at
              });
              this.persistBindings();
            }
            this.emit({ kind: "message", message });
          }
        },
        onThreadSnapshot: (frame) => {
          this.state.applyThreadSnapshot(frame);
          this.emit({ kind: "threads" });
        },
        onThread: (thread) => {
          this.state.addThread(thread);
          this.emit({ kind: "threads" });
        },
        onThreadRef: (binding) => {
          this.state.addThreadRef(binding);
          this.emit({ kind: "threads" });
        },
        onHandoff: (handoff) => {
          this.state.addHandoff(handoff);
          this.emit({ kind: "handoff", handoff });
        },
        onThreadMode: (mode) => {
          if (mode.member === this.config.github_username) {
            this.state.setMyThreadMode(mode.thread_id, mode.mode);
          }
          this.emit({ kind: "threads" });
        },
        onClaimResult: (frame) => {
          // The relay is the authority on who holds a work item. Apply the
          // verdict before the notice, so a lost claim corrects the mirror
          // instead of leaving this member believing it still holds the item.
          this.state.applyClaimResult(frame);
          this.state.addClaimNotice(frame);
          this.pendingNotices.push({
            work_item: frame.work_item,
            granted: frame.granted,
            claimed_by: frame.claimed_by,
            at: new Date().toISOString()
          });
          this.emit({ kind: "claim_result", claim: frame });
        },
        onPresence: (frame) => {
          this.state.applyPresence(frame);
          this.emit({ kind: "presence", presence: frame });
        },
        onPauseState: (frame) => {
          this.pauseMirror.apply(frame);
          this.emit({ kind: "pause_state", pause: frame });
        },
        onConnectionChange: (connected) => {
          // Every reconnect drains the log spool. A run that ended while the
          // relay was away reaches the work log here, with its own
          // timestamps (T055, FR-015).
          if (connected) {
            this.lastRelayError = undefined;
            void this.drainLogSpool();
          }
          this.emit({ kind: "connection", connected });
        },
        onServerError: (frame) => {
          this.lastRelayError = frame;
          // The relay refuses a bad credential once and then stops. There is
          // nothing to wait for, so end the wait now with the reason.
          if (frame.code === "auth_failed") this.onRelayRefused?.();
        }
      }
    );

    // On resume, ask the relay to replay everything held while paused.
    // The replay arrives in seq order (FR-014).
    this.pauseMirror.onOwnResume = () => this.client.sync(this.client.lastSeenSeq);
  }

  /** Connect to the relay. Resolve once connected, or after a short wait. */
  start(waitMs = 4000): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: boolean): void => {
        if (settled) return;
        settled = true;
        // Clear the timer here, not with unref. A live timer holds the event
        // loop open for the whole wait, so a relay that refuses the socket at
        // once cannot let node exit before the caller prints anything. The
        // clear then leaves no handle behind after the wait.
        clearTimeout(timer);
        unsubscribe();
        this.onRelayRefused = undefined;
        resolve(value);
      };
      // Nothing below can call `done` in the same tick: a connection change
      // and a relay frame both need the network first.
      const unsubscribe = this.subscribe((event) => {
        if (event.kind === "connection" && event.connected) done(true);
      });
      this.onRelayRefused = () => done(false);
      this.client.connect();
      const timer = setTimeout(() => done(this.client.connected), waitMs);
    });
  }

  stop(): void {
    this.onRelayRefused = undefined;
    this.client.close();
  }

  get connected(): boolean {
    return this.client.connected;
  }

  /**
   * A plain reason the relay connection is down, or undefined.
   *
   * Only a relay that answers gets a reason. A relay that is off gives no
   * frame at all, so the daemon keeps retrying and says nothing here.
   */
  get relayProblem(): string | undefined {
    const error = this.lastRelayError;
    if (!error || this.connected) return undefined;
    if (error.code === "auth_failed") {
      return (
        `the relay refused the credential in .saw/credential (${error.message}). ` +
        "Ask your teammate for a new invite link and run saw join again."
      );
    }
    return `${error.code}: ${error.message}`;
  }

  subscribe(fn: (event: DaemonEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(event: DaemonEvent): void {
    for (const fn of this.subscribers) fn(event);
  }

  // ---- Operations ----

  /** Post one message. Agent posts are blocked while this member is paused. */
  private persistBindings(): void {
    const state = readState(this.root);
    writeState(this.root, { ...state, pending_bindings: this.pendingBindings });
  }

  /** This member's own answer into a thread clears its pending bindings. */
  private clearBindingsFor(threadId: string): void {
    const before = this.pendingBindings.length;
    this.pendingBindings = this.pendingBindings.filter((b) => b.thread_id !== threadId);
    if (this.pendingBindings.length !== before) this.persistBindings();
  }

  /** Set this member's own mode on a thread (spec 002 T118/T121). */
  setThreadMode(threadId: string, mode: "view" | "comment" | "edit"): void {
    this.client.threadModeSet(threadId, mode);
    // Optimistic: the broadcast confirms it, but local reads answer now.
    this.state.setMyThreadMode(threadId, mode);
  }

  /** Propose, direct, accept, decline, or withdraw a handoff (T133). */
  handoffPropose(propose: {
    thread_id: string;
    to: string;
    tip_ref: { kind: "branch" | "commit"; value: string };
    directed?: boolean;
  }): void {
    this.client.handoffPropose(propose);
  }

  handoffResolve(handoffId: string, toState: "accepted" | "declined" | "withdrawn"): void {
    this.client.handoffResolve(handoffId, toState);
  }

  handoffs(): import("@saw/shared").StoredHandoff[] {
    return this.state.handoffs();
  }

  /** Open a thread on the relay (spec 002 T110). */
  async threadOpen(open: {
    type: "work_item" | "brainstorm" | "general";
    title: string;
  }): Promise<
    { ok: true; thread: import("./state.js").ThreadView } | { ok: false; message: string }
  > {
    const outcome = await this.client.threadOpen({
      type: open.type,
      title: open.title,
      workspace_id: this.config.workspace_id
    });
    if (!outcome.ok) return outcome;
    this.state.addThread(outcome.thread);
    const view = this.state.threadById(outcome.thread.id);
    if (!view) return { ok: false, message: "thread was not mirrored" };
    return { ok: true, thread: view };
  }

  /** The thread list with claim state and this member's mode (T112). */
  threads(): import("./state.js").ThreadView[] {
    return this.state.threads();
  }

  async post(post: MessagePost, senderKind: "agent" | "human"): Promise<PostOutcome> {
    const targetThread = post.thread_id ?? null;
    if (senderKind === "agent" && this.pauseMirror.ownPaused) {
      return {
        ok: false,
        code: "rejected",
        message: "paused"
      } as PostOutcome;
    }
    const outcome = await this.client.post(post, senderKind);
    if (outcome.ok) {
      // The relay sends post_ok, not a message frame, for an own post.
      // Mirror the accepted message into the local cache so the room view
      // and room_read show both sides of the conversation.
      const message: StoredMessage = {
        id: `local-${outcome.seq}`,
        seq: outcome.seq,
        sender: this.config.github_username,
        sender_kind: senderKind,
        type: post.type,
        body: post.body,
        refs: post.refs ?? [],
        target: post.target,
        thread_id: targetThread,
        force: post.force ?? "advisory",
        work_item: post.work_item,
        sent_at: outcome.sent_at
      };
      this.client.noteSeq(outcome.seq);
      if (this.state.addMessage(message)) {
        this.emit({ kind: "message", message });
      }
      // Answering into a thread settles its pending binding decisions for
      // this member (T129): they stop appearing every turn.
      if (targetThread) this.clearBindingsFor(targetThread);
    }
    return outcome;
  }

  /**
   * Read messages from the local cache.
   *
   * This is the bounded read that the web room, `/api/messages`, and
   * `room_read` all use, so it answers with the NEWEST messages after
   * `sinceSeq`. `inject()` reads the oldest unread instead, because only
   * that window is safe to move the read cursor over (T078).
   */
  messages(
    sinceSeq = 0,
    limit = 200,
    workItem?: string,
    threadId?: string
  ): { messages: StoredMessage[]; latest_seq: number } {
    if (threadId) {
      return {
        messages: this.state.threadMessages(threadId, limit).filter((m) => m.seq > sinceSeq),
        latest_seq: this.state.latestSeq()
      };
    }
    return {
      messages: this.state.recentMessages(sinceSeq, limit, workItem),
      // Always the true latest seq of the room. A filter is a view: it must
      // never change the caller's sense of position.
      latest_seq: this.state.latestSeq()
    };
  }

  /**
   * Deliver unread messages for injection (T028/T029).
   * Also records the run trigger (T040).
   *
   * This does NOT advance the read cursor. The caller must acknowledge with
   * `ackInjection` after it has delivered the messages. A hook that dies
   * before it writes its output therefore sees the same messages again,
   * instead of losing them. Delivery is at least once, never at most once.
   */
  inject(
    source: "session-start" | "prompt-submit",
    prompt?: string,
    sessionId?: string
  ): InjectResult {
    const raw = this.state.messages(this.cursor.valueFor(sessionId), 500);
    // An agent already knows its own posts. Its human's messages still count.
    const unread = raw.filter(
      (m) => !(m.sender === this.config.github_username && m.sender_kind === "agent")
    );
    const notices = [...this.pendingNotices];
    // Titles for the threads the unread messages live in, so the hook can
    // group by thread without a second call (T114).
    const threadTitles: Record<string, string> = {};
    const wantTitle = (threadId: string | null | undefined): void => {
      if (!threadId || threadId in threadTitles) return;
      const view = this.state.threadById(threadId);
      if (view) threadTitles[threadId] = view.title;
    };
    for (const m of unread) wantTitle(m.thread_id);
    for (const b of this.pendingBindings) wantTitle(b.thread_id);
    this.runContext.recordInjection(source, { prompt, injected: unread });
    const last = raw[raw.length - 1];
    return {
      messages: unread,
      notices,
      paused: this.pauseMirror.ownPaused,
      work_items: this.state.workItems(),
      me: this.config.github_username,
      latest_seq: this.state.latestSeq(),
      thread_titles: threadTitles,
      binding_decisions: [...this.pendingBindings],
      ack_seq: last ? last.seq : this.cursor.valueFor(sessionId),
      ack_notices: notices.length
    };
  }

  /**
   * Mark an injection as delivered.
   *
   * The cursor moves only here, after the caller has the messages in hand.
   * `notices` is the count the caller received; those are dropped from the
   * pending list. Both values come from the matching `inject` result.
   */
  ackInjection(seq: number, notices = 0, sessionId?: string): void {
    this.cursor.advance(seq, sessionId);
    if (notices > 0) this.pendingNotices.splice(0, notices);
  }

  status(): WorkspaceStatus {
    const unread = this.state
      .messages(this.cursor.value, 500)
      .filter(
        (m) => !(m.sender === this.config.github_username && m.sender_kind === "agent")
      );
    return {
      workspace: this.config.workspace_name,
      repo_remote: this.config.repo_remote,
      members: this.state.members().map((m) => ({
        github_username: m.github_username,
        online: m.github_username === this.config.github_username
          ? this.connected
          : m.online,
        paused: this.pauseMirror.isPaused(m.github_username)
      })),
      me: this.config.github_username,
      paused: this.pauseMirror.ownPaused,
      unread_count: unread.length,
      threads: this.state.threads(),
      work_items: this.state.workItems(),
      relay_connected: this.connected
    };
  }

  /** Set own pause state. Resolves when the relay echo lands in the mirror. */
  setPause(paused: boolean, waitMs = 2000): Promise<boolean> {
    if (this.pauseMirror.ownPaused === paused) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const unsubscribe = this.subscribe((event) => {
        if (
          event.kind === "pause_state" &&
          event.pause?.member === this.config.github_username &&
          event.pause.paused === paused &&
          !settled
        ) {
          settled = true;
          unsubscribe();
          resolve(true);
        }
      });
      this.client.setPause(paused);
      setTimeout(() => {
        if (!settled) {
          settled = true;
          unsubscribe();
          resolve(this.pauseMirror.ownPaused === paused);
        }
      }, waitMs).unref?.();
    });
  }

  /**
   * Compose and append the automatic run summary (T039/T040).
   *
   * A relay that is down, slow, or angry must not cost the run its log entry
   * (FR-015). The entry goes to the local spool instead, and the next
   * reconnect sends it with the timestamps it has now (T055).
   */
  /** Append one system-source entry (mode denials, T120). Spools like runs. */
  async runStopSystem(entry: import("@saw/shared").RunLogEntryInput): Promise<void> {
    const outcome = await this.client.logAppend(entry);
    if (!outcome.ok) {
      try {
        this.logSpool.add(entry);
      } catch {
        // Best effort, like runStop.
      }
    }
  }

  async runStop(what: RunWhat): Promise<RunStopOutcome> {
    const entry = this.runContext.compose(what, this.state.myActiveWorkItem());
    const outcome = await this.client.logAppend(entry);
    if (outcome.ok) return { ok: true, id: outcome.id, spooled: false };
    let spooled = false;
    try {
      this.logSpool.add(entry);
      spooled = true;
    } catch {
      // The spool is best effort and already swallows file errors. This
      // guard only makes sure no path out of the Stop hook can throw.
    }
    return { ok: false, message: outcome.message, spooled };
  }

  /**
   * Send every spooled run to the relay, oldest first.
   * Never rejects: the caller is an event handler, not a request.
   */
  async drainLogSpool(): Promise<number> {
    try {
      const result = await this.logSpool.drain((entry) => this.client.logAppend(entry));
      return result.sent;
    } catch {
      return 0;
    }
  }

  /** Query the work log. */
  async log(query: Partial<LogQuery>): Promise<{ ok: boolean; entries: StoredLogEntry[]; error?: string }> {
    const outcome = await this.client.logQuery(withLogDefaults(query), false);
    if (!outcome.ok) return { ok: false, entries: [], error: outcome.message };
    return { ok: true, entries: outcome.result.entries };
  }

  /** Answer "what did my teammate do since X" from relay storage (T046). */
  async peerActivity(since: string, limit = 50): Promise<{ ok: boolean; activity?: PeerActivity; error?: string }> {
    const outcome = await this.client.logQuery(
      withLogDefaults({ member: "peer", since, limit }),
      true
    );
    if (!outcome.ok) return { ok: false, error: outcome.message };
    const result = outcome.result;
    return {
      ok: true,
      activity: {
        peer: result.peer ?? this.state.peer()?.github_username ?? null,
        peer_online: result.peer_online ?? false,
        runs: result.entries,
        messages: result.messages ?? [],
        note: "Answer built from stored workspace history only."
      }
    };
  }
}

/** Fill the LogQuery defaults the shared schema expects. */
function withLogDefaults(query: Partial<LogQuery>): LogQuery {
  return {
    member: query.member ?? "any",
    work_item: query.work_item,
    since: query.since,
    limit: query.limit ?? 50
  };
}
