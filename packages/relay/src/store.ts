// SQLite store for the relay.
// One file holds all durable state. Writes are ordered. Message seq is gapless.
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { ulid } from "ulid";
import {
  type GitRef,
  type LogSource,
  type MessagePost,
  type RejectionReason,
  type RunLogEntryInput,
  type StoredLogEntry,
  type StoredMessage
} from "@saw/shared";

export interface WorkspaceRow {
  id: string;
  name: string;
  repo_remote: string;
  invite_secret: Buffer;
  created_at: string;
}

export interface MemberRow {
  id: string;
  workspace_id: string;
  github_username: string;
  role: "creator" | "joined";
  joined_at: string;
}

export interface WorkItemRow {
  id: string;
  workspace_id: string;
  feature_tag: string;
  state: "open" | "claimed" | "handed_off" | "done";
  claimed_by: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_remote TEXT NOT NULL,
  invite_secret BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  github_username TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  UNIQUE(workspace_id, github_username)
);
CREATE TABLE IF NOT EXISTS invites (
  nonce TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  invitee TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  seq INTEGER NOT NULL,
  sender_member_id TEXT NOT NULL REFERENCES members(id),
  sender_kind TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  refs TEXT NOT NULL,
  target TEXT,
  work_item TEXT,
  sent_at TEXT NOT NULL,
  UNIQUE(workspace_id, seq)
);
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  feature_tag TEXT NOT NULL,
  state TEXT NOT NULL,
  claimed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, feature_tag)
);
CREATE TABLE IF NOT EXISTS run_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  what TEXT NOT NULL,
  why_trigger TEXT NOT NULL,
  work_item TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pause_state (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  paused INTEGER NOT NULL,
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_ws_seq ON messages(workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_log_ws ON run_log(workspace_id, ended_at);
`;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function now(): string {
  return new Date().toISOString();
}

export class RelayStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- Workspace and members ----

  createWorkspace(
    name: string,
    repoRemote: string,
    creatorGithub: string
  ): { workspace: WorkspaceRow; member: MemberRow; token: string } {
    const ws: WorkspaceRow = {
      id: ulid(),
      name,
      repo_remote: repoRemote,
      invite_secret: randomBytes(32),
      created_at: now()
    };
    const token = randomBytes(32).toString("hex");
    const member: MemberRow = {
      id: ulid(),
      workspace_id: ws.id,
      github_username: creatorGithub,
      role: "creator",
      joined_at: now()
    };
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO workspaces (id, name, repo_remote, invite_secret, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(ws.id, ws.name, ws.repo_remote, ws.invite_secret, ws.created_at);
      this.db
        .prepare(
          "INSERT INTO members (id, workspace_id, github_username, token_hash, role, joined_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(member.id, ws.id, member.github_username, sha256(token), member.role, member.joined_at);
    });
    tx();
    return { workspace: ws, member, token };
  }

  getWorkspace(id: string): WorkspaceRow | undefined {
    return this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | WorkspaceRow
      | undefined;
  }

  members(workspaceId: string): MemberRow[] {
    return this.db
      .prepare(
        "SELECT id, workspace_id, github_username, role, joined_at FROM members WHERE workspace_id = ? ORDER BY joined_at"
      )
      .all(workspaceId) as MemberRow[];
  }

  memberById(id: string): MemberRow | undefined {
    return this.db
      .prepare(
        "SELECT id, workspace_id, github_username, role, joined_at FROM members WHERE id = ?"
      )
      .get(id) as MemberRow | undefined;
  }

  /** Authenticate a member by bearer token. Identity comes from this, never from frames. */
  authMember(workspaceId: string, token: string): MemberRow | undefined {
    return this.db
      .prepare(
        "SELECT id, workspace_id, github_username, role, joined_at FROM members WHERE workspace_id = ? AND token_hash = ?"
      )
      .get(workspaceId, sha256(token)) as MemberRow | undefined;
  }

  // ---- Invites ----

  recordInvite(nonce: string, workspaceId: string, invitee: string, expiresAt: string): void {
    this.db
      .prepare(
        "INSERT INTO invites (nonce, workspace_id, invitee, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)"
      )
      .run(nonce, workspaceId, invitee, expiresAt);
  }

  /** Redeem an already-verified invite. Enforces single use and the 2-member cap. */
  redeemInvite(
    nonce: string,
    workspaceId: string,
    github: string
  ): { ok: true; member: MemberRow; token: string } | { ok: false; error: string } {
    const invite = this.db.prepare("SELECT * FROM invites WHERE nonce = ?").get(nonce) as
      | { workspace_id: string; invitee: string; used_at: string | null }
      | undefined;
    if (!invite || invite.workspace_id !== workspaceId) {
      return { ok: false, error: "invite not found" };
    }
    if (invite.used_at) return { ok: false, error: "invite already used" };
    if (invite.invitee !== github) {
      return { ok: false, error: "invite is for a different github user" };
    }
    if (this.members(workspaceId).length >= 2) {
      return { ok: false, error: "workspace already has two members" };
    }
    const token = randomBytes(32).toString("hex");
    const member: MemberRow = {
      id: ulid(),
      workspace_id: workspaceId,
      github_username: github,
      role: "joined",
      joined_at: now()
    };
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO members (id, workspace_id, github_username, token_hash, role, joined_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(member.id, workspaceId, github, sha256(token), member.role, member.joined_at);
      this.db.prepare("UPDATE invites SET used_at = ? WHERE nonce = ?").run(now(), nonce);
    });
    tx();
    return { ok: true, member, token };
  }

  // ---- Messages ----

  latestSeq(workspaceId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE workspace_id = ?")
      .get(workspaceId) as { s: number };
    return row.s;
  }

  /** Insert one message. The transaction makes the per-workspace seq gapless. */
  insertMessage(
    workspaceId: string,
    sender: MemberRow,
    senderKind: "agent" | "human",
    post: MessagePost
  ): StoredMessage {
    let stored: StoredMessage | undefined;
    const tx = this.db.transaction(() => {
      const seq = this.latestSeq(workspaceId) + 1;
      const msg: StoredMessage = {
        id: ulid(),
        seq,
        sender: sender.github_username,
        sender_kind: senderKind,
        type: post.type,
        body: post.body,
        refs: post.refs,
        target: post.target,
        work_item: post.work_item,
        sent_at: now()
      };
      this.db
        .prepare(
          `INSERT INTO messages
           (id, workspace_id, seq, sender_member_id, sender_kind, type, body, refs, target, work_item, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          msg.id,
          workspaceId,
          seq,
          sender.id,
          senderKind,
          msg.type,
          msg.body,
          JSON.stringify(msg.refs),
          msg.target ?? null,
          msg.work_item ?? null,
          msg.sent_at
        );
      stored = msg;
    });
    tx();
    if (!stored) throw new Error("insert failed");
    return stored;
  }

  messagesSince(workspaceId: string, sinceSeq: number, limit = 500): StoredMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?"
      )
      .all(workspaceId, sinceSeq, limit) as Array<{
      id: string;
      seq: number;
      sender_member_id: string;
      sender_kind: "agent" | "human";
      type: StoredMessage["type"];
      body: string;
      refs: string;
      target: string | null;
      work_item: string | null;
      sent_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      sender: this.memberById(r.sender_member_id)?.github_username ?? "unknown",
      sender_kind: r.sender_kind,
      type: r.type,
      body: r.body,
      refs: JSON.parse(r.refs) as GitRef[],
      target: r.target ?? undefined,
      work_item: r.work_item ?? undefined,
      sent_at: r.sent_at
    }));
  }

  // ---- Work items and claims ----

  workItems(workspaceId: string): WorkItemRow[] {
    return this.db
      .prepare("SELECT * FROM work_items WHERE workspace_id = ? ORDER BY created_at")
      .all(workspaceId) as WorkItemRow[];
  }

  getWorkItem(workspaceId: string, featureTag: string): WorkItemRow | undefined {
    return this.db
      .prepare("SELECT * FROM work_items WHERE workspace_id = ? AND feature_tag = ?")
      .get(workspaceId, featureTag) as WorkItemRow | undefined;
  }

  upsertWorkItem(workspaceId: string, featureTag: string): WorkItemRow {
    const existing = this.getWorkItem(workspaceId, featureTag);
    if (existing) return existing;
    const item: WorkItemRow = {
      id: ulid(),
      workspace_id: workspaceId,
      feature_tag: featureTag,
      state: "open",
      claimed_by: null,
      created_at: now(),
      updated_at: now()
    };
    this.db
      .prepare(
        "INSERT INTO work_items (id, workspace_id, feature_tag, state, claimed_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(item.id, workspaceId, featureTag, item.state, null, item.created_at, item.updated_at);
    return item;
  }

  setWorkItemState(id: string, state: WorkItemRow["state"], claimedBy: string | null): void {
    this.db
      .prepare("UPDATE work_items SET state = ?, claimed_by = ?, updated_at = ? WHERE id = ?")
      .run(state, claimedBy, now(), id);
  }

  /** Run a claim-related transition atomically. Callers pass a pure decision function. */
  transact<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- Pause ----

  setPause(memberId: string, paused: boolean): void {
    this.db
      .prepare(
        `INSERT INTO pause_state (member_id, paused, changed_at) VALUES (?, ?, ?)
         ON CONFLICT(member_id) DO UPDATE SET paused = excluded.paused, changed_at = excluded.changed_at`
      )
      .run(memberId, paused ? 1 : 0, now());
  }

  isPaused(memberId: string): boolean {
    const row = this.db
      .prepare("SELECT paused FROM pause_state WHERE member_id = ?")
      .get(memberId) as { paused: number } | undefined;
    return row ? row.paused === 1 : false;
  }

  // ---- Work log ----

  appendLog(
    workspaceId: string,
    memberId: string,
    entry: RunLogEntryInput,
    source: LogSource
  ): string {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO run_log
         (id, workspace_id, member_id, started_at, ended_at, what, why_trigger, work_item, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        workspaceId,
        memberId,
        entry.started_at,
        entry.ended_at,
        JSON.stringify(entry.what),
        entry.why_trigger,
        entry.work_item ?? "unassigned",
        source
      );
    return id;
  }

  /** Record a boundary rejection. The rejected payload body is never stored. */
  appendRejectionLog(
    workspaceId: string,
    memberId: string,
    reason: RejectionReason,
    summary: string
  ): string {
    const t = now();
    return this.appendLog(
      workspaceId,
      memberId,
      {
        started_at: t,
        ended_at: t,
        what: { tools_used: {} },
        why_trigger: `boundary rejection: ${reason} (${summary})`
      },
      "boundary_rejection"
    );
  }

  /**
   * The NEWEST log entries that match, oldest first.
   *
   * A bounded query must answer with the end of the log, not its front. The
   * front is the first day of the workspace, which no reader asks for: the
   * web log browser asks for 100 entries and `work_log` defaults to 50, so
   * taking the front froze both on the first runs of the workspace and hid
   * every later one permanently. Boundary rejections are stored here too, so
   * the log passes those counts sooner than the run count suggests. The same
   * path answers `peer_activity`, which made "what did my teammate do" report
   * the oldest history rather than recent work (T079, FR-016, FR-019, SC-003).
   *
   * The inner query takes the newest window; the outer one puts it back into
   * ascending time order, so no caller changes. `rowid` breaks a tie: two
   * entries can share an `ended_at` to the millisecond, and it is the append
   * order that decides which of those is newer.
   */
  queryLog(
    workspaceId: string,
    filter: { memberId?: string; workItem?: string; since?: string; limit: number }
  ): StoredLogEntry[] {
    // `rowid` is not a column of a subquery result, so name it in the inner
    // select for the outer ORDER BY to reach. The extra field is ignored below.
    let inner = "SELECT *, rowid AS row_order FROM run_log WHERE workspace_id = ?";
    const args: unknown[] = [workspaceId];
    if (filter.memberId) {
      inner += " AND member_id = ?";
      args.push(filter.memberId);
    }
    if (filter.workItem) {
      inner += " AND work_item = ?";
      args.push(filter.workItem);
    }
    if (filter.since) {
      inner += " AND ended_at >= ?";
      args.push(filter.since);
    }
    inner += " ORDER BY ended_at DESC, rowid DESC LIMIT ?";
    args.push(filter.limit);
    const sql = `SELECT * FROM (${inner}) ORDER BY ended_at ASC, row_order ASC`;
    const rows = this.db.prepare(sql).all(...args) as Array<{
      id: string;
      member_id: string;
      started_at: string;
      ended_at: string;
      what: string;
      why_trigger: string;
      work_item: string;
      source: LogSource;
    }>;
    return rows.map((r) => ({
      id: r.id,
      member: this.memberById(r.member_id)?.github_username ?? "unknown",
      started_at: r.started_at,
      ended_at: r.ended_at,
      what: JSON.parse(r.what) as StoredLogEntry["what"],
      why_trigger: r.why_trigger,
      work_item: r.work_item,
      source: r.source
    }));
  }
}
