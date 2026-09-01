// T108: a message posted into one thread never appears in another, and the
// snapshot carries the whole thread state (SC-014 groundwork). T109: a claim
// on one thread leaves another thread's claim untouched, and a contested
// claim still resolves first-claim-wins. Raw protocol, like relay.test.ts.
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

const is =
  <K extends ServerFrame["kind"]>(
    kind: K,
    extra?: (f: Extract<ServerFrame, { kind: K }>) => boolean
  ) =>
  (f: ServerFrame): f is Extract<ServerFrame, { kind: K }> =>
    f.kind === kind && (!extra || extra(f as Extract<ServerFrame, { kind: K }>));

beforeAll(async () => {
  relay = await startRelay(":memory:", 0);
  base = `http://127.0.0.1:${relay.port}`;
  const reg = (await http("/workspaces", {
    name: "threads-test",
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

describe("threads over the wire (T108)", () => {
  it("routes each message to its thread, snapshots state, and keeps threads apart", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);

    // The hello snapshot arrives before anything exists: empty is fine,
    // but the frame itself must come (contracts 2.2).
    await alice.waitFor(is("thread_snapshot"));

    alice.send({
      kind: "thread_open",
      open: { type: "work_item", title: "auth refactor", workspace_id: workspaceId }
    });
    const t1 = (await alice.waitFor(is("thread"))).thread;
    alice.send({
      kind: "thread_open",
      open: { type: "brainstorm", title: "improve image gen", workspace_id: workspaceId }
    });
    const t2 = (await alice.waitFor(is("thread", (f) => f.thread.id !== t1.id))).thread;
    // Bob learns of both threads without asking.
    await bob.waitFor(is("thread", (f) => f.thread.id === t2.id));

    alice.send({
      kind: "post",
      post: { type: "status", body: "into auth", thread_id: t1.id },
      sender_kind: "agent"
    });
    alice.send({
      kind: "post",
      post: { type: "status", body: "into imagegen", thread_id: t2.id },
      sender_kind: "agent"
    });
    const inT1 = await bob.waitFor(is("message", (f) => f.message.body === "into auth"));
    const inT2 = await bob.waitFor(is("message", (f) => f.message.body === "into imagegen"));
    expect(inT1.message.thread_id).toBe(t1.id);
    expect(inT2.message.thread_id).toBe(t2.id);
    expect(inT1.message.thread_seq).toBe(1);
    expect(inT2.message.thread_seq).toBe(1);

    // A ref on a post binds to its thread and is announced.
    alice.send({
      kind: "post",
      post: {
        type: "status",
        body: "pushed",
        thread_id: t1.id,
        refs: [{ kind: "branch", value: "alice/auth" }]
      },
      sender_kind: "agent"
    });
    const bound = await bob.waitFor(is("thread_ref"));
    expect(bound.binding.thread_id).toBe(t1.id);
    expect(bound.binding.ref.value).toBe("alice/auth");

    // A fresh sync replays the state: both threads and the binding.
    bob.send({ kind: "sync", since_seq: 0 });
    const snapshot = await bob.waitFor(
      is("thread_snapshot", (f) => f.threads.length >= 2 && f.refs.length >= 1)
    );
    expect(snapshot.threads.map((t) => t.id)).toContain(t1.id);
    expect(snapshot.threads.map((t) => t.id)).toContain(t2.id);

    // A post into a thread that does not exist is refused plainly.
    alice.send({
      kind: "post",
      post: { type: "status", body: "into nowhere", thread_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      sender_kind: "agent"
    });
    const refused = await alice.waitFor(is("error", (f) => f.code === "unknown_thread"));
    expect(refused.message).toContain("thread not found");

    alice.close();
    bob.close();
  });
});

describe("claims are thread-scoped (T109)", () => {
  it("keeps claims apart per thread and preserves first-claim-wins", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);
    await bob.waitFor(is("thread_snapshot"));

    alice.send({
      kind: "thread_open",
      open: { type: "work_item", title: "claim target", workspace_id: workspaceId }
    });
    const target = (await alice.waitFor(is("thread", (f) => f.thread.title === "claim target")))
      .thread;
    alice.send({
      kind: "thread_open",
      open: { type: "work_item", title: "bystander", workspace_id: workspaceId }
    });
    const bystander = (await alice.waitFor(is("thread", (f) => f.thread.title === "bystander")))
      .thread;
    await bob.waitFor(is("thread", (f) => f.thread.id === bystander.id));

    // Both members claim the same thread. The relay resolves in message
    // order: exactly one grant, one visible rejection.
    alice.send({
      kind: "post",
      post: { type: "intent", body: "claiming", thread_id: target.id },
      sender_kind: "agent"
    });
    bob.send({
      kind: "post",
      post: { type: "intent", body: "claiming too", thread_id: target.id },
      sender_kind: "agent"
    });
    const results = [
      await alice.waitFor(is("claim_result", (f) => f.thread_id === target.id)),
      await alice.waitFor(
        is("claim_result", (f) => f.thread_id === target.id && f.granted === false),
        4000
      )
    ];
    const granted = results.filter((r) => r.granted);
    expect(granted.length).toBe(1);

    // The bystander thread's claim state never moved.
    expect(relay.store.threadClaim(bystander.id)).toBeUndefined();
    // And the contested thread has exactly one holder.
    const claim = relay.store.threadClaim(target.id);
    expect(claim?.state).toBe("claimed");
    expect(["alice", "bob"]).toContain(claim?.claimed_by);

    alice.close();
    bob.close();
  });
});
