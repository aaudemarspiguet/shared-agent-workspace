// The session surface's data contract (T154, T155) over two real daemons.
//
// wakes-cli.test.ts already proves the session and claim MACHINERY works
// through the daemon API. What had no coverage is the path the surfaces
// actually use: auto mode readable per thread, the readiness handshake over
// HTTP, and /api/claim/approve — which existed with zero callers until the
// controls in this change, so nothing had ever driven it from outside.
import { afterEach, describe, expect, it } from "vitest";
import {
  apiGet,
  apiPost,
  startWeb,
  twoMemberWorkspace,
  waitFor,
  type TestWeb,
  type TestWorkspace
} from "./helpers.js";

let workspace: TestWorkspace | null = null;

afterEach(async () => {
  await workspace?.close();
  workspace = null;
});

interface ThreadRow {
  id: string;
  title: string;
  my_auto_mode: boolean;
  claim_state: string;
  claimed_by?: string;
}

interface SessionRow {
  id: string;
  thread_id: string;
  task: string;
  state: string;
  members: { member: string; ready_at: string | null; max_turns: number; turns_used: number }[];
  ended_by: string | null;
}

async function threadsOf(web: TestWeb): Promise<ThreadRow[]> {
  const res = await apiGet(web, "/api/status");
  return (res.json as { threads: ThreadRow[] }).threads;
}

async function sessionsOf(web: TestWeb): Promise<SessionRow[]> {
  const res = await apiGet(web, "/api/sessions");
  return (res.json as { sessions: SessionRow[] }).sessions;
}

async function openThread(web: TestWeb, title: string): Promise<string> {
  const res = await apiPost(web, "/api/thread/open", { type: "work_item", title });
  expect(res.status).toBe(200);
  return (res.json as { thread: { id: string } }).thread.id;
}

describe("the session surface (T154)", () => {
  it("reports the member's OWN auto mode per thread, and nobody else's", async () => {
    workspace = await twoMemberWorkspace();
    const web = await startWeb(workspace.alice);
    try {
      const threadId = await openThread(web, "auto mode reads back");

      // Consent is off until it is given. A surface defaulting to true would
      // show consent nobody granted.
      const before = (await threadsOf(web)).find((t) => t.id === threadId);
      expect(before?.my_auto_mode).toBe(false);

      const set = await apiPost(web, "/api/auto-mode", { thread_id: threadId, enabled: true });
      expect(set.status).toBe(200);
      const after = (await threadsOf(web)).find((t) => t.id === threadId);
      expect(after?.my_auto_mode).toBe(true);

      // The row carries this member's own consent and has no field for the
      // other member's, so no surface can imply a control over it.
      expect(Object.keys(after ?? {})).not.toContain("their_auto_mode");
    } finally {
      await web.close();
    }
  });

  it("starts a session on the SECOND readiness, not the first", async () => {
    workspace = await twoMemberWorkspace();
    const aliceWeb = await startWeb(workspace.alice);
    const bobWeb = await startWeb(workspace.bob);
    try {
      const threadId = await openThread(aliceWeb, "two yeses");
      await waitFor(
        async () => (await threadsOf(bobWeb)).some((t) => t.id === threadId),
        "the thread to mirror to bob"
      );

      await apiPost(aliceWeb, "/api/session/ready", {
        thread_id: threadId,
        task: "build the thing together",
        max_turns: 7
      });
      await waitFor(
        async () => (await sessionsOf(aliceWeb)).some((s) => s.thread_id === threadId),
        "the session to form"
      );

      // One readiness forms a session. It must not make it live.
      const forming = (await sessionsOf(aliceWeb)).find((s) => s.thread_id === threadId);
      expect(forming?.state).toBe("forming");
      expect(forming?.task).toBe("build the thing together");

      await apiPost(bobWeb, "/api/session/ready", { thread_id: threadId });
      await waitFor(async () => {
        const s = (await sessionsOf(aliceWeb)).find((x) => x.thread_id === threadId);
        return s?.state === "live";
      }, "the second readiness to start the session");

      const live = (await sessionsOf(aliceWeb)).find((s) => s.thread_id === threadId);
      // The budget box reads these two numbers per member.
      const alice = live?.members.find((m) => m.member === "alice");
      expect(alice?.max_turns).toBe(7);
      expect(alice?.turns_used).toBe(0);
      expect(alice?.ready_at).not.toBeNull();
    } finally {
      await aliceWeb.close();
      await bobWeb.close();
    }
  });

  it("ends a session from either side, and records who ended it", async () => {
    workspace = await twoMemberWorkspace();
    const aliceWeb = await startWeb(workspace.alice);
    const bobWeb = await startWeb(workspace.bob);
    try {
      const threadId = await openThread(aliceWeb, "either may end it");
      await waitFor(
        async () => (await threadsOf(bobWeb)).some((t) => t.id === threadId),
        "the thread to mirror"
      );
      await apiPost(aliceWeb, "/api/session/ready", { thread_id: threadId, task: "a task" });
      await apiPost(bobWeb, "/api/session/ready", { thread_id: threadId });
      await waitFor(async () => {
        const s = (await sessionsOf(aliceWeb)).find((x) => x.thread_id === threadId);
        return s?.state === "live";
      }, "the session to go live");

      const live = (await sessionsOf(aliceWeb)).find((s) => s.thread_id === threadId);

      // Bob did not start it. He may still end it (FR-051).
      const ending = await apiPost(bobWeb, "/api/session/end", { session_id: live?.id });
      expect(ending.status).toBe(200);
      await waitFor(async () => {
        const s = (await sessionsOf(aliceWeb)).find((x) => x.id === live?.id);
        return s?.state === "ended" || s?.state === "concluded";
      }, "the end to reach alice");

      const ended = (await sessionsOf(aliceWeb)).find((s) => s.id === live?.id);
      expect(ended?.ended_by).toBe("bob");
    } finally {
      await aliceWeb.close();
      await bobWeb.close();
    }
  });

  // The T155 control's endpoint. It has existed since #199 with no caller on
  // any surface, so this is the first time anything drives it over HTTP.
  it("concludes an agent's done proposal only on its own member's approval", async () => {
    workspace = await twoMemberWorkspace();
    const aliceWeb = await startWeb(workspace.alice);
    const bobWeb = await startWeb(workspace.bob);
    try {
      const threadId = await openThread(aliceWeb, "approve me properly");
      await apiPost(aliceWeb, "/api/post", {
        type: "intent",
        body: "claiming this",
        sender_kind: "agent",
        thread_id: threadId
      });
      await apiPost(aliceWeb, "/api/post", {
        type: "decision",
        body: "i believe this is finished",
        sender_kind: "agent",
        thread_id: threadId
      });

      // An agent's decision proposes. It does not conclude.
      await waitFor(async () => {
        const t = (await threadsOf(aliceWeb)).find((x) => x.id === threadId);
        return t?.claim_state === "done_proposed";
      }, "the proposal to land");

      const approving = await apiPost(aliceWeb, "/api/claim/approve", { thread_id: threadId });
      expect(approving.status).toBe(200);
      await waitFor(async () => {
        const t = (await threadsOf(aliceWeb)).find((x) => x.id === threadId);
        return t?.claim_state === "done";
      }, "the approval to conclude the claim");

      const mirrored = (await threadsOf(bobWeb)).find((x) => x.id === threadId);
      expect(mirrored?.claim_state).toBe("done");
    } finally {
      await aliceWeb.close();
      await bobWeb.close();
    }
  });
});

describe("a control refuses rather than lying when the relay is gone", () => {
  // The bug this pins: every one of these routes hands its work to a client
  // method beginning `if (!this.connected) return;`, then answered 200 on
  // top of the dropped write. On the surface that was an approve button
  // that looked dead and a readiness that never started a session — the
  // member is told it worked, and nothing happened. Proven live on
  // 2026-09-02: all three of the first routes returned {"ok":true} for a
  // thread id that does not even exist.
  it("answers 503 on every relay-bound write instead of a false success", async () => {
    workspace = await twoMemberWorkspace();
    const web = await startWeb(workspace.alice);
    const dead = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    try {
      const threadId = await openThread(web, "the relay is about to go away");

      await workspace.relay.close();
      await waitFor(async () => {
        const h = (await apiGet(web, "/api/health")).json as { relay_connected: boolean };
        return h.relay_connected === false;
      }, "the daemon to notice the relay is gone");

      const writes: { path: string; body: Record<string, unknown> }[] = [
        { path: "/api/claim/approve", body: { thread_id: threadId } },
        { path: "/api/auto-mode", body: { thread_id: threadId, enabled: true } },
        { path: "/api/session/ready", body: { thread_id: threadId, task: "anything" } },
        { path: "/api/session/end", body: { session_id: dead } },
        { path: "/api/session/approve", body: { session_id: dead } },
        { path: "/api/session/propose", body: { session_id: dead, summary: "anything" } },
        { path: "/api/thread/mode", body: { thread_id: threadId, mode: "edit" } },
        {
          path: "/api/handoff",
          body: {
            action: "propose",
            thread_id: threadId,
            to: "bob",
            tip_ref: { kind: "branch", value: "alice/x" }
          }
        },
        { path: "/api/handoff", body: { action: "accept", handoff_id: dead } }
      ];

      for (const write of writes) {
        const res = await apiPost(web, write.path, write.body);
        const answer = res.json as { error?: { code?: string } };
        expect(res.status, `${write.path} reported success it did not achieve`).toBe(503);
        expect(answer.error?.code, `${write.path} must name the real reason`).toBe("not_connected");
      }
    } finally {
      await web.close();
    }
  });
});
