// SQLite store for the relay.
// One file holds all durable state. Writes are ordered. Message seq is gapless.
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { ulid } from "ulid";
import {
  MIGRATED_THREAD_MODE,
  type HandoffState,
  type StoredHandoff,
  type GitRef,
  type LogSource,
  type MessagePost,
  type Mode,
  type RejectionReason,
  type RunLogEntryInput,
  type StoredLogEntry,
  type StoredMessage,
  type StoredThread,
  type StoredThreadMode,
  type ThreadOpen,
  type ThreadRefBinding,
  type ThreadState
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

export interface ThreadClaimRow {
  thread_id: string;
  state: "open" | "claimed" | "handed_off" | "done";
  claimed_by: string | null;
  updated_at: string;
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
  thread_id TEXT,
  force TEXT,
  thread_seq INTEGER,
  sent_at TEXT NOT NULL,
  UNIQUE(workspace_id, seq)
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  migrated_from_tag TEXT
);
CREATE TABLE IF NOT EXISTS thread_participants (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  member_username TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, member_username)
);
CREATE TABLE IF NOT EXISTS thread_refs (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  ref_kind TEXT NOT NULL,
  ref_value TEXT NOT NULL,
  bound_by TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, workspace_id, ref_kind, ref_value)
);
CREATE TABLE IF NOT EXISTS thread_claims (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id),
  state TEXT NOT NULL,
  claimed_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_modes (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  member_username TEXT NOT NULL,
  mode TEXT NOT NULL,
  set_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, member_username)
);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  from_member TEXT NOT NULL,
  to_member TEXT NOT NULL,
  state TEXT NOT NULL,
  tip_ref_kind TEXT NOT NULL,
  tip_ref_value TEXT NOT NULL,
  directed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS thread_tag_merges (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  thread_id TEXT NOT NULL REFERENCES threads(id),
  variant_tag TEXT NOT NULL,
  canonical_tag TEXT NOT NULL,
  merged_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, variant_tag)
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
  thread_id TEXT,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pause_state (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  paused INTEGER NOT NULL,
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_ws_seq ON messages(workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_threads_ws ON threads(workspace_id);
CREATE INDEX IF NOT EXISTS idx_log_ws ON run_log(workspace_id, ended_at);
`;

/**
 * The schema data version. Version 1 is spec 002 phase 3: threads exist,
 * every historic work-item tag is a thread, and untagged history lives in
 * a general thread. The migration runs exactly once (T099, T103): the
 * version stamp is read and written inside the same transaction as the
 * data changes.
 */
const DATA_VERSION = 1;

/** Tags that differ only by case or surrounding space fold together (T100). */
function foldTag(tag: string): string {
  return tag.trim().toLowerCase();
}

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
    this.migrate();
  }

  /**
   * Bring a store from any earlier shape to the current one (FR-009a).
   *
   * Two halves. The column adds are idempotent: they run only when the
   * column is missing, so a fresh store (whose CREATE TABLE already has the
   * full shape) skips them. The data migration is exactly-once: the version
   * stamp turns inside the same transaction as the data changes, so a crash
   * either leaves the old store or the fully migrated one, and a second
   * invocation finds the stamp and does nothing (T103).
   */
  private migrate(): void {
    const messageCols = (
      this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!messageCols.includes("thread_id")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN thread_id TEXT");
      this.db.exec("ALTER TABLE messages ADD COLUMN force TEXT");
      this.db.exec("ALTER TABLE messages ADD COLUMN thread_seq INTEGER");
    }
    const logCols = (
      this.db.prepare("PRAGMA table_info(run_log)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!logCols.includes("thread_id")) {
      this.db.exec("ALTER TABLE run_log ADD COLUMN thread_id TEXT");
    }
    // The thread index waits for the columns above: on a v0 store they do
    // not exist when SCHEMA runs, so creating it there failed the open.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, thread_seq)"
    );

    const version = (this.db.pragma("user_version", { simple: true }) as number) ?? 0;
    if (version >= DATA_VERSION) return;
    const tx = this.db.transaction(() => {
      const workspaces = this.db.prepare("SELECT id FROM workspaces").all() as Array<{
        id: string;
      }>;
      for (const ws of workspaces) this.migrateWorkspace(ws.id);
      this.db.pragma(`user_version = ${DATA_VERSION}`);
    });
    tx();
  }

  /** One workspace's v0 history becomes threads (T099, T100, T101). */
  private migrateWorkspace(workspaceId: string): void {
    const memberRows = this.members(workspaceId);
    const creator = memberRows.find((m) => m.role === "creator") ?? memberRows[0];
    const createdBy = creator?.github_username ?? "system";

    // Every place a tag appears: messages, the claim registry, the run log.
    const tagRows = this.db
      .prepare(
        `SELECT work_item AS tag FROM messages WHERE workspace_id = ? AND work_item IS NOT NULL
         UNION SELECT feature_tag AS tag FROM work_items WHERE workspace_id = ?
         UNION SELECT work_item AS tag FROM run_log WHERE workspace_id = ? AND work_item != 'unassigned'`
      )
      .all(workspaceId, workspaceId, workspaceId) as Array<{ tag: string }>;

    // Fold variants; the first-seen spelling is the canonical title (T100).
    const canonicalByFold = new Map<string, string>();
    for (const { tag } of tagRows) {
      const fold = foldTag(tag);
      if (fold.length === 0) continue;
      if (!canonicalByFold.has(fold)) canonicalByFold.set(fold, tag.trim());
    }

    const threadByFold = new Map<string, string>();
    for (const [fold, canonical] of canonicalByFold) {
      const thread = this.createThread(
        workspaceId,
        { type: "work_item", title: canonical, workspace_id: workspaceId },
        createdBy,
        canonical
      );
      threadByFold.set(fold, thread.id);
      // Record every variant spelling that folded into this thread.
      for (const { tag } of tagRows) {
        if (foldTag(tag) === fold && tag.trim() !== canonical) {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO thread_tag_merges
               (workspace_id, thread_id, variant_tag, canonical_tag, merged_at)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(workspaceId, thread.id, tag.trim(), canonical, now());
        }
      }
    }

    // Untagged history lands in the general thread, so nothing is orphaned.
    const general = this.generalThread(workspaceId, createdBy);

    // Backfill thread ids and per-thread positions in seq order.
    const messages = this.db
      .prepare(
        "SELECT id, work_item FROM messages WHERE workspace_id = ? ORDER BY seq"
      )
      .all(workspaceId) as Array<{ id: string; work_item: string | null }>;
    const nextSeq = new Map<string, number>();
    const update = this.db.prepare(
      "UPDATE messages SET thread_id = ?, thread_seq = ?, force = 'advisory' WHERE id = ?"
    );
    for (const m of messages) {
      const threadId =
        (m.work_item ? threadByFold.get(foldTag(m.work_item)) : undefined) ?? general.id;
      const seq = (nextSeq.get(threadId) ?? 0) + 1;
      nextSeq.set(threadId, seq);
      update.run(threadId, seq, m.id);
    }

    // Claim state carries over onto the thread the tag became.
    const items = this.workItems(workspaceId);
    for (const item of items) {
      const threadId = threadByFold.get(foldTag(item.feature_tag));
      if (!threadId) continue;
      this.db
        .prepare(
          `INSERT INTO thread_claims (thread_id, state, claimed_by, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET state = excluded.state,
             claimed_by = excluded.claimed_by, updated_at = excluded.updated_at`
        )
        .run(threadId, item.state, item.claimed_by, item.updated_at);
    }

    // Run log entries follow their tag's thread.
    for (const [fold, threadId] of threadByFold) {
      const variants = [...canonicalByFold.entries()]
        .filter(([f]) => f === fold)
        .map(([, c]) => c);
      for (const { tag } of tagRows) {
        if (foldTag(tag) === fold && !variants.includes(tag.trim())) variants.push(tag.trim());
      }
      for (const v of variants) {
        this.db
          .prepare(
            "UPDATE run_log SET thread_id = ? WHERE workspace_id = ? AND work_item = ?"
          )
          .run(threadId, workspaceId, v);
      }
    }

    // Every member starts at edit on every migrated thread, and joins it:
    // v0 agents could already claim, so the comment default would silently
    // remove a capability from every existing member (research R3, T101).
    const allThreads = [...threadByFold.values(), general.id];
    for (const threadId of allThreads) {
      for (const member of memberRows) {
        this.setThreadMode(threadId, member.github_username, MIGRATED_THREAD_MODE);
        this.addParticipant(threadId, member.github_username);
      }
    }
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

  // ---- Threads (spec 002 US7) ----

  private rowToThread(r: {
    id: string;
    workspace_id: string;
    type: string;
    title: string;
    scope: string;
    state: string;
    created_by: string;
    created_at: string;
    migrated_from_tag: string | null;
  }): StoredThread {
    return {
      id: r.id,
      workspace_id: r.workspace_id,
      type: r.type as StoredThread["type"],
      title: r.title,
      scope: r.scope as StoredThread["scope"],
      state: r.state as StoredThread["state"],
      created_by: r.created_by,
      created_at: r.created_at,
      migrated_from_tag: r.migrated_from_tag
    };
  }

  createThread(
    workspaceId: string,
    open: ThreadOpen,
    createdBy: string,
    migratedFromTag: string | null = null
  ): StoredThread {
    const thread: StoredThread = {
      id: ulid(),
      workspace_id: workspaceId,
      type: open.type,
      title: open.title,
      scope: "project",
      state: "open",
      created_by: createdBy,
      created_at: now(),
      migrated_from_tag: migratedFromTag
    };
    this.db
      .prepare(
        `INSERT INTO threads
         (id, workspace_id, type, title, scope, state, created_by, created_at, migrated_from_tag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        thread.id,
        workspaceId,
        thread.type,
        thread.title,
        thread.scope,
        thread.state,
        createdBy,
        thread.created_at,
        migratedFromTag
      );
    this.addParticipant(thread.id, createdBy);
    return thread;
  }

  threadById(id: string): StoredThread | undefined {
    const r = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as
      | Parameters<RelayStore["rowToThread"]>[0]
      | undefined;
    return r ? this.rowToThread(r) : undefined;
  }

  threads(workspaceId: string): StoredThread[] {
    const rows = this.db
      .prepare("SELECT * FROM threads WHERE workspace_id = ? ORDER BY created_at")
      .all(workspaceId) as Array<Parameters<RelayStore["rowToThread"]>[0]>;
    return rows.map((r) => this.rowToThread(r));
  }

  setThreadState(threadId: string, state: ThreadState): void {
    this.db.prepare("UPDATE threads SET state = ? WHERE id = ?").run(state, threadId);
  }

  /** The workspace's general thread. Created on first need (T099). */
  generalThread(workspaceId: string, createdBy: string): StoredThread {
    const existing = this.db
      .prepare(
        "SELECT * FROM threads WHERE workspace_id = ? AND type = 'general' AND title = 'general'"
      )
      .get(workspaceId) as Parameters<RelayStore["rowToThread"]>[0] | undefined;
    if (existing) return this.rowToThread(existing);
    return this.createThread(
      workspaceId,
      { type: "general", title: "general", workspace_id: workspaceId },
      createdBy
    );
  }

  /**
   * The thread a v0-style work-item tag names, creating it when it is new.
   * Folding keeps case and whitespace variants on one thread (T100), during
   * migration and for every tag a v0-era client still sends afterwards.
   */
  resolveThreadForTag(workspaceId: string, tag: string, createdBy: string): StoredThread {
    const fold = foldTag(tag);
    const merged = this.db
      .prepare(
        "SELECT thread_id FROM thread_tag_merges WHERE workspace_id = ? AND variant_tag = ?"
      )
      .get(workspaceId, tag.trim()) as { thread_id: string } | undefined;
    if (merged) {
      const t = this.threadById(merged.thread_id);
      if (t) return t;
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM threads WHERE workspace_id = ? AND migrated_from_tag IS NOT NULL"
      )
      .all(workspaceId) as Array<Parameters<RelayStore["rowToThread"]>[0]>;
    const hit = rows.find((r) => foldTag(r.migrated_from_tag ?? "") === fold);
    if (hit) {
      if (hit.migrated_from_tag !== tag.trim()) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO thread_tag_merges
             (workspace_id, thread_id, variant_tag, canonical_tag, merged_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(workspaceId, hit.id, tag.trim(), hit.migrated_from_tag, now());
      }
      return this.rowToThread(hit);
    }
    return this.createThread(
      workspaceId,
      { type: "work_item", title: tag.trim(), workspace_id: workspaceId },
      createdBy,
      tag.trim()
    );
  }

  addParticipant(threadId: string, username: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO thread_participants (thread_id, member_username, joined_at, muted)
         VALUES (?, ?, ?, 0)`
      )
      .run(threadId, username, now());
  }

  bindThreadRef(
    threadId: string,
    workspaceId: string,
    ref: GitRef,
    boundBy: string
  ): ThreadRefBinding {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO thread_refs
         (thread_id, workspace_id, ref_kind, ref_value, bound_by, bound_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(threadId, workspaceId, ref.kind, ref.value, boundBy, now());
    return { thread_id: threadId, workspace_id: workspaceId, ref };
  }

  threadRefs(workspaceId: string): ThreadRefBinding[] {
    const rows = this.db
      .prepare("SELECT * FROM thread_refs WHERE workspace_id = ? ORDER BY bound_at")
      .all(workspaceId) as Array<{
      thread_id: string;
      workspace_id: string;
      ref_kind: GitRef["kind"];
      ref_value: string;
    }>;
    return rows.map((r) => ({
      thread_id: r.thread_id,
      workspace_id: r.workspace_id,
      ref: { kind: r.ref_kind, value: r.ref_value }
    }));
  }

  threadClaim(threadId: string): ThreadClaimRow | undefined {
    return this.db.prepare("SELECT * FROM thread_claims WHERE thread_id = ?").get(threadId) as
      | ThreadClaimRow
      | undefined;
  }

  setThreadClaim(
    threadId: string,
    state: ThreadClaimRow["state"],
    claimedBy: string | null
  ): void {
    this.db
      .prepare(
        `INSERT INTO thread_claims (thread_id, state, claimed_by, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET state = excluded.state,
           claimed_by = excluded.claimed_by, updated_at = excluded.updated_at`
      )
      .run(threadId, state, claimedBy, now());
  }

  setThreadMode(threadId: string, username: string, mode: Mode): void {
    this.db
      .prepare(
        `INSERT INTO thread_modes (thread_id, member_username, mode, set_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id, member_username) DO UPDATE SET mode = excluded.mode,
           set_at = excluded.set_at`
      )
      .run(threadId, username, mode, now());
  }

  threadModes(workspaceId: string): StoredThreadMode[] {
    const rows = this.db
      .prepare(
        `SELECT tm.thread_id, tm.member_username, tm.mode, tm.set_at
         FROM thread_modes tm JOIN threads t ON t.id = tm.thread_id
         WHERE t.workspace_id = ?`
      )
      .all(workspaceId) as Array<{
      thread_id: string;
      member_username: string;
      mode: Mode;
      set_at: string;
    }>;
    return rows.map((r) => ({
      thread_id: r.thread_id,
      member: r.member_username,
      mode: r.mode,
      set_at: r.set_at
    }));
  }

  // ---- Handoffs (spec 002 US8, T132) ----

  private rowToHandoff(r: {
    id: string;
    thread_id: string;
    from_member: string;
    to_member: string;
    state: string;
    tip_ref_kind: GitRef["kind"];
    tip_ref_value: string;
    directed: number;
    created_at: string;
    resolved_at: string | null;
  }): StoredHandoff {
    return {
      id: r.id,
      thread_id: r.thread_id,
      from_member: r.from_member,
      to_member: r.to_member,
      state: r.state as HandoffState,
      tip_ref: { kind: r.tip_ref_kind, value: r.tip_ref_value },
      directed: r.directed === 1,
      created_at: r.created_at,
      resolved_at: r.resolved_at
    };
  }

  createHandoff(
    threadId: string,
    fromMember: string,
    toMember: string,
    tipRef: GitRef,
    directed: boolean
  ): StoredHandoff {
    const handoff: StoredHandoff = {
      id: ulid(),
      thread_id: threadId,
      from_member: fromMember,
      to_member: toMember,
      state: directed ? "accepted" : "proposed",
      tip_ref: tipRef,
      directed,
      created_at: now(),
      resolved_at: directed ? now() : null
    };
    this.db
      .prepare(
        `INSERT INTO handoffs
         (id, thread_id, from_member, to_member, state, tip_ref_kind, tip_ref_value, directed, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        handoff.id,
        threadId,
        fromMember,
        toMember,
        handoff.state,
        tipRef.kind,
        tipRef.value,
        directed ? 1 : 0,
        handoff.created_at,
        handoff.resolved_at
      );
    return handoff;
  }

  handoffById(id: string): StoredHandoff | undefined {
    const r = this.db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as
      | Parameters<RelayStore["rowToHandoff"]>[0]
      | undefined;
    return r ? this.rowToHandoff(r) : undefined;
  }

  handoffs(workspaceId: string): StoredHandoff[] {
    const rows = this.db
      .prepare(
        `SELECT h.* FROM handoffs h JOIN threads t ON t.id = h.thread_id
         WHERE t.workspace_id = ? ORDER BY h.created_at`
      )
      .all(workspaceId) as Array<Parameters<RelayStore["rowToHandoff"]>[0]>;
    return rows.map((r) => this.rowToHandoff(r));
  }

  setHandoffState(id: string, state: HandoffState): StoredHandoff | undefined {
    this.db
      .prepare("UPDATE handoffs SET state = ?, resolved_at = ? WHERE id = ?")
      .run(state, now(), id);
    return this.handoffById(id);
  }

  // ---- Messages ----

  latestSeq(workspaceId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE workspace_id = ?")
      .get(workspaceId) as { s: number };
    return row.s;
  }

  /**
   * Insert one message. The transaction makes the per-workspace seq gapless
   * and the per-thread position dense (spec 002, contracts 2.2). A null
   * `threadId` is a project broadcast.
   */
  insertMessage(
    workspaceId: string,
    sender: MemberRow,
    senderKind: "agent" | "human",
    post: MessagePost,
    threadId: string | null = null
  ): StoredMessage {
    let stored: StoredMessage | undefined;
    const tx = this.db.transaction(() => {
      const seq = this.latestSeq(workspaceId) + 1;
      let threadSeq: number | undefined;
      if (threadId) {
        const row = this.db
          .prepare(
            "SELECT COALESCE(MAX(thread_seq), 0) AS s FROM messages WHERE thread_id = ?"
          )
          .get(threadId) as { s: number };
        threadSeq = row.s + 1;
      }
      const msg: StoredMessage = {
        id: ulid(),
        seq,
        thread_seq: threadSeq,
        sender: sender.github_username,
        sender_kind: senderKind,
        type: post.type,
        body: post.body,
        refs: post.refs,
        target: post.target,
        thread_id: threadId,
        force: post.force ?? "advisory",
        work_item: post.work_item,
        sent_at: now()
      };
      this.db
        .prepare(
          `INSERT INTO messages
           (id, workspace_id, seq, sender_member_id, sender_kind, type, body, refs, target, work_item, thread_id, force, thread_seq, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          threadId,
          msg.force ?? "advisory",
          threadSeq ?? null,
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
      thread_id: string | null;
      force: string | null;
      thread_seq: number | null;
      sent_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      thread_seq: r.thread_seq ?? undefined,
      sender: this.memberById(r.sender_member_id)?.github_username ?? "unknown",
      sender_kind: r.sender_kind,
      type: r.type,
      body: r.body,
      refs: JSON.parse(r.refs) as GitRef[],
      target: r.target ?? undefined,
      thread_id: r.thread_id,
      force: (r.force ?? "advisory") as StoredMessage["force"],
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
         (id, workspace_id, member_id, started_at, ended_at, what, why_trigger, work_item, thread_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        entry.thread_id ?? null,
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
    filter: {
      memberId?: string;
      workItem?: string;
      threadId?: string;
      since?: string;
      limit: number;
    }
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
    if (filter.threadId) {
      inner += " AND thread_id = ?";
      args.push(filter.threadId);
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
      thread_id: string | null;
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
      thread_id: r.thread_id,
      source: r.source
    }));
  }
}
