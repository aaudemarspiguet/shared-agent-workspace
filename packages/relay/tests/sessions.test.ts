// T149/T150/T155 over the wire: the readiness handshake, the wake rule
// with budgets, ending and convergence, and done-ness by author.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerFrame } from "@saw/shared";
import { startRelay, type RelayServer } from "../src/index.js";

let relay: RelayServer;
let base: string;
let workspaceId: string;
let aliceToken: string;
let bobToken: string;

interface TestClient {
  frames: ServerFrame[];
  waitFor<T extends ServerFrame>(pred: (f: ServerFrame) => f is T, ms?: number): Promise<T>;
  send(frame: object): void;
  close(): void;
}

async function http(path: string, body: object, token?: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

function connect(token: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const frames: ServerFrame[] = [];
    const listeners: Array<(f: ServerFrame) => void> = [];
    const client: TestClient = {
      frames,
      send: (frame) => ws.send(JSON.stringify(frame)),
      close: () => ws.close(),
      waitFor: <T extends ServerFrame>(pred: (f: ServerFrame) => f is T, ms = 3000) =>
        new Promise<T>((res, rej) => {
          const hit = frames.find(pred);
          if (hit) return res(hit);
          const timer = setTimeout(() => rej(new Error("waitFor timed out")), ms);
          listeners.push((f: ServerFrame) => {
            if (pred(f)) {
              clearTimeout(timer);
              res(f as T);
            }
          });
        })
    };
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame;
      frames.push(frame);
      for (const l of [...listeners]) l(frame);
    });
    ws.on("open", () => {
      client.send({ kind: "hello", workspace_id: workspaceId, token, client: "test", protocol: 1 });
    });
    ws.on("error", reject);
    const isHelloOk = (f: ServerFrame): f is Extract<ServerFrame, { kind: "hello_ok" }> =>
      f.kind === "hello_ok";
    void client.waitFor(isHelloOk).then(() => resolve(client));
  });
}

async function untilStore(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const is =
  <K extends ServerFrame["kind"]>(
    kind: K,
    extra?: (f: Extract<ServerFrame, { kind: K }>) => boolean
  ) =>
  (f: ServerFrame): f is Extract<ServerFrame, { kind: K }> =>
    f.kind === kind && (!extra || extra(f as Extract<ServerFrame, { kind: K }>));

async function openThread(client: TestClient, title: string): Promise<string> {
  client.send({
    kind: "thread_open",
    open: { type: "work_item", title, workspace_id: workspaceId }
  });
  const frame = await client.waitFor(is("thread", (f) => f.thread.title === title));
  return frame.thread.id;
}

beforeAll(async () => {
  relay = await startRelay(":memory:", 0);
  base = `http://127.0.0.1:${relay.port}`;
  const reg = (await http("/workspaces", {
    name: "sessions-test",
    repo_remote: "git@example.com:acme/app.git",
    creator: "alice"
  })) as { workspace_id: string; token: string };
  workspaceId = reg.workspace_id;
  aliceToken = reg.token;
  const inv = (await http(
    `/workspaces/${workspaceId}/invites`,
    { invitee: "bob" },
    aliceToken
  )) as { invite: string };
  const joined = (await http("/join", { invite: inv.invite, github: "bob" })) as {
    token: string;
  };
  bobToken = joined.token;
});
afterAll(async () => {
  await relay.close();
});

describe("the readiness handshake and wakes (T149, T150)", () => {
  it("first ready forms with the task, second makes it live, agents wake each other within budgets", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);
    await bob.waitFor(is("thread_snapshot"));
    const threadId = await openThread(alice, "auto session");
    await bob.waitFor(is("thread", (f) => f.thread.id === threadId));

    // First readiness without a task is refused plainly.
    alice.send({ kind: "session_ready", ready: { thread_id: threadId } });
    await alice.waitFor(
      is("error", (f) => f.message.includes("names the task"))
    );

    // Alice: ready with the task and a tight budget of 2.
    alice.send({
      kind: "session_ready",
      ready: { thread_id: threadId, task: "wire the auth flow together", max_turns: 2 }
    });
    const forming = await alice.waitFor(is("session", (f) => f.session.state === "forming"));
    expect(forming.session.task).toBe("wire the auth flow together");

    // Bob: ready. The session goes live for both.
    bob.send({ kind: "session_ready", ready: { thread_id: threadId, max_turns: 2 } });
    await alice.waitFor(is("session", (f) => f.session.state === "live"));
    await bob.waitFor(is("session", (f) => f.session.state === "live"));

    // Outside-session rule still holds elsewhere: bob's HUMAN message wakes
    // only bob himself.
    bob.send({
      kind: "post",
      post: { type: "status", body: "typing from my web page", thread_id: threadId },
      sender_kind: "human"
    });
    const bobWake = await bob.waitFor(is("wake", (f) => f.reason === "own_message"));
    expect(bobWake.thread_id).toBe(threadId);
    expect(alice.frames.some((f) => f.kind === "wake")).toBe(false);

    // A session turn: bob's AGENT message wakes alice, spending her budget.
    bob.send({
      kind: "post",
      post: { type: "status", body: "took the backend half", thread_id: threadId },
      sender_kind: "agent"
    });
    const aliceWake = await alice.waitFor(is("wake", (f) => f.reason === "session_turn"));
    expect(aliceWake.session_id).not.toBeNull();

    // Second agent message spends alice's last turn and suspends the session.
    bob.send({
      kind: "post",
      post: { type: "status", body: "backend done, your turn", thread_id: threadId },
      sender_kind: "agent"
    });
    await alice.waitFor(is("wake", (f) => f.message_seq !== aliceWake.message_seq));
    const suspended = await alice.waitFor(is("session", (f) => f.session.state === "suspended"));
    expect(suspended.session.ended_by).toBe("budget");

    // Suspended: a further agent message wakes nobody.
    const wakesBefore = alice.frames.filter((f) => f.kind === "wake").length;
    bob.send({
      kind: "post",
      post: { type: "status", body: "one more thought", thread_id: threadId },
      sender_kind: "agent"
    });
    await bob.waitFor(is("post_ok", () => true));
    await new Promise((r) => setTimeout(r, 150));
    expect(alice.frames.filter((f) => f.kind === "wake").length).toBe(wakesBefore);

    alice.close();
    bob.close();
  });

  it("turning auto mode off ends a live session, recorded by who did it", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);
    await bob.waitFor(is("thread_snapshot"));
    const threadId = await openThread(alice, "revocation");
    await bob.waitFor(is("thread", (f) => f.thread.id === threadId));

    alice.send({
      kind: "session_ready",
      ready: { thread_id: threadId, task: "shortlived" }
    });
    bob.send({ kind: "session_ready", ready: { thread_id: threadId } });
    await bob.waitFor(is("session", (f) => f.session.state === "live"));

    bob.send({ kind: "auto_mode_set", set: { thread_id: threadId, enabled: false } });
    const ended = await alice.waitFor(
      is("session", (f) => f.session.state === "ended" && f.session.thread_id === threadId)
    );
    expect(ended.session.ended_by).toBe("bob");

    alice.close();
    bob.close();
  });
});

describe("convergence and done-ness by author (T149, T155)", () => {
  it("an agent proposes, only its own member approves, and the session concludes", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);
    await bob.waitFor(is("thread_snapshot"));
    const threadId = await openThread(alice, "converge here");
    await bob.waitFor(is("thread", (f) => f.thread.id === threadId));

    alice.send({
      kind: "session_ready",
      ready: { thread_id: threadId, task: "finish and converge" }
    });
    bob.send({ kind: "session_ready", ready: { thread_id: threadId } });
    const live = await alice.waitFor(is("session", (f) => f.session.state === "live"));

    // Bob's agent proposes done.
    bob.send({
      kind: "converge_propose",
      propose: {
        session_id: live.session.id,
        summary: "both halves reviewed and pushed",
        refs: [{ kind: "branch", value: "bob/backend" }]
      }
    });
    const converged = await alice.waitFor(is("session", (f) => f.session.state === "converged"));
    expect(converged.session.convergence?.proposed_by).toBe("bob");

    // Alice cannot approve bob's proposal: approving is self-directed.
    alice.send({ kind: "converge_approve", session_id: live.session.id });
    await alice.waitFor(is("error", (f) => f.message.includes("self-directed")));

    // Bob (the proposing agent's member) approves; the session concludes.
    bob.send({ kind: "converge_approve", session_id: live.session.id });
    const concluded = await bob.waitFor(is("session", (f) => f.session.state === "concluded"));
    expect(concluded.session.convergence?.approved_by).toBe("bob");

    alice.close();
    bob.close();
  });

  it("a human's decision concludes; an agent's decision proposes and waits (SC-029)", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);
    await bob.waitFor(is("thread_snapshot"));

    // Agent path: claim, then an agent decision -> done_proposed, not done.
    const t1 = await openThread(alice, "agent closes");
    alice.send({
      kind: "post",
      post: { type: "intent", body: "claiming", thread_id: t1 },
      sender_kind: "agent"
    });
    await alice.waitFor(is("claim_result", (f) => f.thread_id === t1 && f.granted));
    alice.send({
      kind: "post",
      post: { type: "decision", body: "i believe this is done", thread_id: t1 },
      sender_kind: "agent"
    });
    await untilStore(
      () => relay.store.threadClaim(t1)?.state === "done_proposed",
      "the agent decision to propose done"
    );

    // Bob cannot approve alice's proposal.
    bob.send({ kind: "claim_approve", thread_id: t1 });
    await bob.waitFor(is("error", (f) => f.message.includes("self-directed")));
    expect(relay.store.threadClaim(t1)?.state).toBe("done_proposed");

    // Alice approves her own agent's proposal: done.
    alice.send({ kind: "claim_approve", thread_id: t1 });
    await untilStore(() => relay.store.threadClaim(t1)?.state === "done", "the approval to land");

    // Human path: the decision concludes in the same post, no second act.
    const t2 = await openThread(bob, "human closes");
    bob.send({
      kind: "post",
      post: { type: "intent", body: "claiming", thread_id: t2 },
      sender_kind: "agent"
    });
    await bob.waitFor(is("claim_result", (f) => f.thread_id === t2 && f.granted));
    bob.send({
      kind: "post",
      post: { type: "decision", body: "shipped, closing it", thread_id: t2 },
      sender_kind: "human"
    });
    await untilStore(
      () => relay.store.threadClaim(t2)?.state === "done",
      "the human decision to conclude in one post"
    );

    alice.close();
    bob.close();
  });
});
