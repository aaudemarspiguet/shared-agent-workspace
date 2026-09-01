// Auto mode and session lifecycle at the relay (spec 002 US9, T149/T150).
// The relay is the session's ledger: readiness, state, turn budgets, and
// the convergence record. The wake decision itself is the shared pure
// function; the relay only feeds it facts and delivers the verdict.
import {
  DEFAULT_MAX_TURNS,
  wakeEligible,
  type ConvergePropose,
  type SessionReady,
  type StoredMessage,
  type StoredSession
} from "@saw/shared";
import type { ConnectionRegistry } from "./presence.js";
import type { MemberRow, RelayStore } from "./store.js";

function broadcastSession(
  store: RelayStore,
  registry: ConnectionRegistry,
  workspaceId: string,
  session: StoredSession
): void {
  registry.broadcast(store, workspaceId, { kind: "session", session });
}

/**
 * Turn auto mode on or off for the sender, on one thread. Turning it OFF
 * while a live session runs is a revocation of the consent the session is
 * made of, so the session ends, recorded as ended by that member.
 */
export function handleAutoModeSet(
  store: RelayStore,
  registry: ConnectionRegistry,
  member: MemberRow,
  threadId: string,
  enabled: boolean
): { ok: true } | { ok: false; message: string } {
  const thread = store.threadById(threadId);
  if (!thread || thread.workspace_id !== member.workspace_id) {
    return { ok: false, message: "thread not found" };
  }
  store.setAutoMode(threadId, member.github_username, enabled);
  registry.broadcast(store, member.workspace_id, {
    kind: "auto_mode",
    thread_id: threadId,
    member: member.github_username,
    enabled
  });
  if (!enabled) {
    const session = store.activeSessionForThread(threadId);
    const participating = session?.members.some(
      (m) => m.member === member.github_username && m.ready_at !== null
    );
    if (session && participating && session.state !== "forming") {
      store.setSessionState(session.id, "ended", member.github_username);
      const after = store.sessionById(session.id);
      if (after) broadcastSession(store, registry, member.workspace_id, after);
    }
  }
  return { ok: true };
}

/**
 * A readiness declaration (FR-050). The first names the task and creates
 * the session; the second makes it live. Declaring ready also turns the
 * declarer's auto mode on for the thread — readiness IS that consent, and
 * a separate toggle step would only invite a half-configured state.
 */
export function handleSessionReady(
  store: RelayStore,
  registry: ConnectionRegistry,
  member: MemberRow,
  ready: SessionReady
): { ok: true; session: StoredSession } | { ok: false; message: string } {
  const thread = store.threadById(ready.thread_id);
  if (!thread || thread.workspace_id !== member.workspace_id) {
    return { ok: false, message: "thread not found" };
  }

  // Validate BEFORE any consent is recorded: a refused readiness must
  // leave no trace. Auto mode is a consent flag, and an operation that
  // failed set it anyway - found by review of #199, proved with a probe.
  let session = store.activeSessionForThread(ready.thread_id);
  const task = ready.task?.trim() ?? "";
  if (!session && task.length === 0) {
    return {
      ok: false,
      message: "the first readiness names the task the session is for"
    };
  }

  store.setAutoMode(ready.thread_id, member.github_username, true);
  registry.broadcast(store, member.workspace_id, {
    kind: "auto_mode",
    thread_id: ready.thread_id,
    member: member.github_username,
    enabled: true
  });

  if (!session) {
    session = store.createSession(
      ready.thread_id,
      task,
      member.github_username,
      ready.max_turns ?? DEFAULT_MAX_TURNS
    );
    broadcastSession(store, registry, member.workspace_id, session);
    return { ok: true, session };
  }

  store.setSessionReady(
    session.id,
    member.github_username,
    ready.max_turns ?? DEFAULT_MAX_TURNS
  );
  let after = store.sessionById(session.id);
  const readyCount = after?.members.filter((m) => m.ready_at !== null).length ?? 0;
  if (after && after.state === "forming" && readyCount >= 2) {
    store.setSessionState(session.id, "live");
    after = store.sessionById(session.id);
  }
  if (!after) return { ok: false, message: "session not found after update" };
  broadcastSession(store, registry, member.workspace_id, after);
  return { ok: true, session: after };
}

/** Either human ends a session at any time (FR-051). */
export function handleSessionEnd(
  store: RelayStore,
  registry: ConnectionRegistry,
  member: MemberRow,
  sessionId: string
): { ok: true } | { ok: false; message: string } {
  const session = store.sessionById(sessionId);
  const thread = session ? store.threadById(session.thread_id) : undefined;
  if (!session || thread?.workspace_id !== member.workspace_id) {
    return { ok: false, message: "session not found" };
  }
  if (session.state === "concluded" || session.state === "ended") {
    return { ok: false, message: `the session is already ${session.state}` };
  }
  store.setSessionState(sessionId, "ended", member.github_username);
  const after = store.sessionById(sessionId);
  if (after) broadcastSession(store, registry, member.workspace_id, after);
  return { ok: true };
}

/** An agent proposes the session's work is done (FR-052). */
export function handleConvergePropose(
  store: RelayStore,
  registry: ConnectionRegistry,
  member: MemberRow,
  propose: ConvergePropose
): { ok: true } | { ok: false; message: string } {
  const session = store.sessionById(propose.session_id);
  const thread = session ? store.threadById(session.thread_id) : undefined;
  if (!session || thread?.workspace_id !== member.workspace_id) {
    return { ok: false, message: "session not found" };
  }
  if (session.state !== "live" && session.state !== "suspended") {
    return { ok: false, message: `a ${session.state} session takes no proposal` };
  }
  store.setConvergence(propose.session_id, member.github_username, propose.summary, propose.refs);
  store.setSessionState(propose.session_id, "converged");
  const after = store.sessionById(propose.session_id);
  if (after) broadcastSession(store, registry, member.workspace_id, after);
  return { ok: true };
}

/**
 * The proposing agent's own member approves; the session concludes
 * (FR-052). Approving is self-directed: no member approves another
 * member's proposal.
 */
export function handleConvergeApprove(
  store: RelayStore,
  registry: ConnectionRegistry,
  member: MemberRow,
  sessionId: string
): { ok: true } | { ok: false; message: string } {
  const session = store.sessionById(sessionId);
  const thread = session ? store.threadById(session.thread_id) : undefined;
  if (!session || thread?.workspace_id !== member.workspace_id) {
    return { ok: false, message: "session not found" };
  }
  if (session.state !== "converged" || !session.convergence) {
    return { ok: false, message: "nothing is proposed on this session" };
  }
  if (session.convergence.proposed_by !== member.github_username) {
    return {
      ok: false,
      message:
        "approving is self-directed: the proposal belongs to the other member's agent, so their member approves it"
    };
  }
  store.approveConvergence(sessionId, member.github_username);
  store.setSessionState(sessionId, "concluded", member.github_username);
  const after = store.sessionById(sessionId);
  if (after) broadcastSession(store, registry, member.workspace_id, after);
  return { ok: true };
}

/**
 * Evaluate the wake rule for one accepted message (T150). Feeds the shared
 * pure function per member and delivers a wake frame ONLY to a member it
 * fires for. A session turn spends the woken member's budget here, on the
 * ledger; exhaustion suspends the session for a human's word (FR-051).
 */
export function routeWakes(
  store: RelayStore,
  registry: ConnectionRegistry,
  workspaceId: string,
  message: StoredMessage
): void {
  if (!message.thread_id) {
    // Broadcasts wake only their own author (a human posting from the web).
    if (message.sender_kind === "human") {
      const sender = store
        .members(workspaceId)
        .find((m) => m.github_username === message.sender);
      if (sender && !store.isPaused(sender.id)) {
        registry.sendTo(sender.id, {
          kind: "wake",
          thread_id: "",
          session_id: null,
          reason: "own_message",
          message_seq: message.seq
        });
      }
    }
    return;
  }
  const session = store.activeSessionForThread(message.thread_id);
  const liveParticipants =
    session?.members
      .filter(
        (m) =>
          m.ready_at !== null &&
          store.autoModeEnabled(message.thread_id ?? "", m.member)
      )
      .map((m) => m.member) ?? [];

  for (const member of store.members(workspaceId)) {
    const verdict = wakeEligible({
      sender: message.sender,
      sender_kind: message.sender_kind,
      recipient: member.github_username,
      recipient_auto_on: store.autoModeEnabled(message.thread_id, member.github_username),
      recipient_paused: store.isPaused(member.id),
      session: session ? { state: session.state, live_participants: liveParticipants } : null
    });
    if (!verdict.wake) continue;

    if (verdict.reason === "session_turn" && session) {
      const me = session.members.find((m) => m.member === member.github_username);
      if (!me) continue;
      if (me.turns_used >= me.max_turns) {
        store.setSessionState(session.id, "suspended", "budget");
        const after = store.sessionById(session.id);
        if (after) broadcastSession(store, registry, workspaceId, after);
        continue;
      }
      const used = store.bumpSessionTurns(session.id, member.github_username);
      if (used >= me.max_turns) {
        // This wake spends the last turn: deliver it, then suspend.
        registry.sendTo(member.id, {
          kind: "wake",
          thread_id: message.thread_id,
          session_id: session.id,
          reason: "session_turn",
          message_seq: message.seq
        });
        store.setSessionState(session.id, "suspended", "budget");
        const after = store.sessionById(session.id);
        if (after) broadcastSession(store, registry, workspaceId, after);
        continue;
      }
      registry.sendTo(member.id, {
        kind: "wake",
        thread_id: message.thread_id,
        session_id: session.id,
        reason: "session_turn",
        message_seq: message.seq
      });
      continue;
    }

    registry.sendTo(member.id, {
      kind: "wake",
      thread_id: message.thread_id,
      session_id: session?.id ?? null,
      reason: verdict.reason,
      message_seq: message.seq
    });
  }
}
