// T102: the FR-009(a) migration loses zero messages and zero log entries,
// and every historic tag is queryable as a thread (SC-008). T103: it runs
// exactly once when re-invoked. T100: tags differing only by case or
// surrounding space fold into one thread, recorded. T101: migrated threads
// sit at mode edit for every member.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATED_THREAD_MODE } from "@saw/shared";
import { RelayStore } from "../src/store.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Build a v0-shaped store by hand: the schema before spec 002. */
function buildV0Store(): { path: string; workspaceId: string } {
  dir = mkdtempSync(join(tmpdir(), "saw-migrate-"));
  const path = join(dir, "relay.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      repo_remote TEXT NOT NULL, invite_secret BLOB NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE members (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      github_username TEXT NOT NULL, token_hash TEXT NOT NULL, role TEXT NOT NULL,
      joined_at TEXT NOT NULL, UNIQUE(workspace_id, github_username));
    CREATE TABLE invites (nonce TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      invitee TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      seq INTEGER NOT NULL, sender_member_id TEXT NOT NULL, sender_kind TEXT NOT NULL,
      type TEXT NOT NULL, body TEXT NOT NULL, refs TEXT NOT NULL, target TEXT,
      work_item TEXT, sent_at TEXT NOT NULL, UNIQUE(workspace_id, seq));
    CREATE TABLE work_items (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      feature_tag TEXT NOT NULL, state TEXT NOT NULL, claimed_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, feature_tag));
    CREATE TABLE run_log (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      member_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
      what TEXT NOT NULL, why_trigger TEXT NOT NULL, work_item TEXT NOT NULL,
      source TEXT NOT NULL);
    CREATE TABLE pause_state (member_id TEXT PRIMARY KEY, paused INTEGER NOT NULL,
      changed_at TEXT NOT NULL);
  `);
  const t = "2026-08-01T00:00:00.000Z";
  db.prepare(
    "INSERT INTO workspaces VALUES ('ws1', 'itest', 'git@example.com:acme/app.git', x'00', ?)"
  ).run(t);
  db.prepare("INSERT INTO members VALUES ('m1', 'ws1', 'alice', 'h1', 'creator', ?)").run(t);
  db.prepare("INSERT INTO members VALUES ('m2', 'ws1', 'bob', 'h2', 'joined', ?)").run(t);
  const msg = db.prepare(
    "INSERT INTO messages (id, workspace_id, seq, sender_member_id, sender_kind, type, body, refs, target, work_item, sent_at) VALUES (?, 'ws1', ?, ?, 'agent', ?, ?, '[]', NULL, ?, ?)"
  );
  msg.run("msg1", 1, "m1", "intent", "claiming auth", "Auth-Refactor", t);
  msg.run("msg2", 2, "m2", "status", "no tag here", null, t);
  msg.run("msg3", 3, "m2", "status", "same tag, different case", "auth-refactor ", t);
  msg.run("msg4", 4, "m1", "status", "other work", "pipeline", t);
  db.prepare(
    "INSERT INTO work_items VALUES ('wi1', 'ws1', 'Auth-Refactor', 'claimed', 'alice', ?, ?)"
  ).run(t, t);
  db.prepare(
    "INSERT INTO run_log VALUES ('run1', 'ws1', 'm1', ?, ?, '{\"tools_used\":{}}', 'work on auth', 'Auth-Refactor', 'hook_stop')"
  ).run(t, t);
  db.prepare(
    "INSERT INTO run_log VALUES ('run2', 'ws1', 'm2', ?, ?, '{\"tools_used\":{}}', 'a question', 'unassigned', 'hook_stop')"
  ).run(t, t);
  db.close();
  return { path, workspaceId: "ws1" };
}

describe("the v0-to-threads migration (FR-009a)", () => {
  it("loses zero messages and zero log entries, and every tag is a thread (T102)", () => {
    const { path, workspaceId } = buildV0Store();
    const store = new RelayStore(path);

    const messages = store.messagesSince(workspaceId, 0);
    expect(messages.length).toBe(4);
    const threads = store.threads(workspaceId);
    // Two tags fold to one thread, plus pipeline, plus general = 3 threads.
    expect(threads.length).toBe(3);
    const titles = threads.map((t) => t.title).sort();
    expect(titles).toEqual(["Auth-Refactor", "general", "pipeline"]);

    // The folded tag's messages share one thread; the untagged one landed
    // in general; every message has a thread and a dense position.
    const auth = threads.find((t) => t.title === "Auth-Refactor");
    const general = threads.find((t) => t.type === "general");
    const byId = new Map(messages.map((m) => [m.id, m]));
    expect(byId.get("msg1")?.thread_id).toBe(auth?.id);
    expect(byId.get("msg3")?.thread_id).toBe(auth?.id);
    expect(byId.get("msg2")?.thread_id).toBe(general?.id);
    expect(byId.get("msg1")?.thread_seq).toBe(1);
    expect(byId.get("msg3")?.thread_seq).toBe(2);

    // The claim carried over onto the thread the tag became.
    expect(store.threadClaim(auth?.id ?? "")).toMatchObject({
      state: "claimed",
      claimed_by: "alice"
    });

    // The run log kept both entries; the tagged one follows its thread.
    const log = store.queryLog(workspaceId, { limit: 50 });
    expect(log.length).toBe(2);
    expect(log.find((e) => e.id === "run1")?.thread_id).toBe(auth?.id);
    expect(log.find((e) => e.id === "run2")?.thread_id).toBeNull();

    store.close();
  });

  it("starts every member at edit on every migrated thread (T101)", () => {
    const { path, workspaceId } = buildV0Store();
    const store = new RelayStore(path);
    const threads = store.threads(workspaceId);
    const modes = store.threadModes(workspaceId);
    for (const thread of threads) {
      for (const member of ["alice", "bob"]) {
        const row = modes.find((m) => m.thread_id === thread.id && m.member === member);
        expect(row?.mode, `${member} on ${thread.title}`).toBe(MIGRATED_THREAD_MODE);
      }
    }
    store.close();
  });

  it("runs exactly once when re-invoked (T103)", () => {
    const { path, workspaceId } = buildV0Store();
    const first = new RelayStore(path);
    const threadCount = first.threads(workspaceId).length;
    const messageCount = first.messagesSince(workspaceId, 0).length;
    first.close();

    // A second open finds the version stamp and changes nothing.
    const second = new RelayStore(path);
    expect(second.threads(workspaceId).length).toBe(threadCount);
    expect(second.messagesSince(workspaceId, 0).length).toBe(messageCount);
    const merges = second.threads(workspaceId).filter((t) => t.migrated_from_tag !== null);
    expect(merges.length).toBe(2);
    second.close();
  });
});
