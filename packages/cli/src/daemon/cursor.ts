// ReadCursor (T028, reworked by T106).
// Tracks the highest message seq already injected into the agent context.
// T106: one cursor per coding-tool session, not one per repo clone. Two
// sessions in one repo used to consume each other's unread messages (#68,
// #130). Now each session advances its own cursor. The legacy repo-level
// value stays as the floor: it is the highest seq any session has acked,
// a brand-new session starts there instead of replaying history, and an
// old hook that sends no session id keeps the old behavior through it.
// The cursor survives daemon restarts through .saw/state.json.
import { readState, writeState } from "../config.js";
import type { SessionCursor } from "../config.js";
import type { StoredMessage } from "@saw/shared";

/** Sessions kept in the state file. The oldest fall off past this. */
const MAX_SESSIONS = 50;

export class ReadCursor {
  private root: string;
  private floor: number;
  private sessions: Record<string, SessionCursor>;

  constructor(root: string) {
    this.root = root;
    const state = readState(root);
    this.floor = state.last_injected_seq;
    this.sessions = state.sessions ?? {};
  }

  /** The repo-level floor: the highest seq any session has acked. */
  get value(): number {
    return this.floor;
  }

  /** The cursor for one session. A session never seen starts at the floor. */
  valueFor(sessionId?: string): number {
    if (!sessionId) return this.floor;
    return this.sessions[sessionId]?.last_injected_seq ?? this.floor;
  }

  /** Messages after the session's cursor, in seq order. */
  unread(messages: StoredMessage[], sessionId?: string): StoredMessage[] {
    const cursor = this.valueFor(sessionId);
    return messages.filter((m) => m.seq > cursor);
  }

  /** Advance after an injection. Persist at once. */
  advance(toSeq: number, sessionId?: string): void {
    const current = this.valueFor(sessionId);
    if (toSeq <= current && toSeq <= this.floor) return;
    if (sessionId && toSeq > current) {
      this.sessions[sessionId] = {
        last_injected_seq: toSeq,
        updated_at: new Date().toISOString()
      };
      this.prune();
    }
    if (toSeq > this.floor) this.floor = toSeq;
    writeState(this.root, {
      last_injected_seq: this.floor,
      sessions: this.sessions
    });
  }

  /** Keep the newest MAX_SESSIONS entries. The rest restart at the floor. */
  private prune(): void {
    const ids = Object.keys(this.sessions);
    if (ids.length <= MAX_SESSIONS) return;
    const stamp = (id: string): string => this.sessions[id]?.updated_at ?? "";
    ids
      .sort((a, b) => stamp(a).localeCompare(stamp(b)))
      .slice(0, ids.length - MAX_SESSIONS)
      .forEach((id) => delete this.sessions[id]);
  }
}
