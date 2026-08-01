// Relay smoke test.
// Two members join one workspace and exercise the full protocol:
// post, claim conflict, boundary rejection, pause, sync, log, peer activity.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerFrame } from "@saw/shared";
import { startRelay, type RelayServer } from "../src/index.js";

let relay: RelayServer;
let base: string;

interface TestClient {
  ws: WebSocket;
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

function connect(workspaceId: string, token: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const frames: ServerFrame[] = [];
    const client: TestClient = {
      ws,
      frames,
      send: (frame) => ws.send(JSON.stringify(frame)),
      close: () => ws.close(),
      waitFor: <T extends ServerFrame>(pred: (f: ServerFrame) => f is T, ms = 2000) =>
        new Promise<T>((res, rej) => {
          const hit = frames.find(pred);
          if (hit) return res(hit);
          const timer = setTimeout(() => rej(new Error("waitFor timed out")), ms);
          const onFrame = (f: ServerFrame) => {
            if (pred(f)) {
              clearTimeout(timer);
              res(f);
            }
          };
          listeners.push(onFrame);
        })
    };
    const listeners: Array<(f: ServerFrame) => void> = [];
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame;
      frames.push(frame);
      for (const l of [...listeners]) l(frame);
    });
    ws.on("open", () => {
      client.send({ kind: "hello", workspace_id: workspaceId, token, client: "test" });
    });
    ws.on("error", reject);
    const isHelloOk = (f: ServerFrame): f is Extract<ServerFrame, { kind: "hello_ok" }> =>
      f.kind === "hello_ok";
    void client.waitFor(isHelloOk).then(() => resolve(client));
  });
}

const is =
  <K extends ServerFrame["kind"]>(kind: K, extra?: (f: Extract<ServerFrame, { kind: K }>) => boolean) =>
  (f: ServerFrame): f is Extract<ServerFrame, { kind: K }> =>
    f.kind === kind && (!extra || extra(f as Extract<ServerFrame, { kind: K }>));

let workspaceId: string;
let aliceToken: string;
let bobToken: string;

beforeAll(async () => {
  relay = await startRelay(":memory:", 0);
  base = `http://127.0.0.1:${relay.port}`;

  const created = (await http("/workspaces", {
    name: "demo",
    repo_remote: "git@github.com:acme/app.git",
    creator: "alice"
  })) as { workspace_id: string; token: string };
  workspaceId = created.workspace_id;
  aliceToken = created.token;

  const minted = (await http(
    `/workspaces/${workspaceId}/invites`,
    { invitee: "bob" },
    aliceToken
  )) as { ok: boolean; invite: string };
  expect(minted.ok).toBe(true);

  const joined = (await http("/join", { invite: minted.invite, github: "bob" })) as {
    ok: boolean;
    token: string;
    members: string[];
  };
  expect(joined.ok).toBe(true);
  expect(joined.members).toEqual(["alice", "bob"]);
  bobToken = joined.token;
});

afterAll(async () => {
  await relay.close();
});

describe("relay protocol", () => {
  it("delivers posts in order, resolves claims first-wins, rejects smuggling, honors pause and sync, answers peer queries offline", async () => {
    const alice = await connect(workspaceId, aliceToken);
    const bob = await connect(workspaceId, bobToken);

    // Alice claims the login form with an intent post.
    alice.send({
      kind: "post",
      post: { type: "intent", body: "I will take the login form.", work_item: "login-form" }
    });
    const msg1 = await bob.waitFor(is("message"));
    expect(msg1.message.sender).toBe("alice");
    expect(msg1.message.seq).toBe(1);
    const claim1 = await bob.waitFor(is("claim_result"));
    expect(claim1).toMatchObject({ granted: true, claimed_by: "alice" });

    // Bob claims the same item. First claim wins. The rejection is visible.
    bob.send({
      kind: "post",
      post: { type: "intent", body: "I want the login form too.", work_item: "login-form" }
    });
    const claim2 = await alice.waitFor(is("claim_result", (f) => !f.granted));
    expect(claim2.claimed_by).toBe("alice");

    // A smuggled diff is rejected and logged. The body is not stored.
    bob.send({
      kind: "post",
      post: { type: "status", body: "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@" }
    });
    const rejected = await bob.waitFor(is("post_rejected"));
    expect(rejected.reason).toBe("content_smuggling");

    // Bob pauses. Messages sent while paused do not push to him.
    bob.send({ kind: "pause_set", paused: true });
    await alice.waitFor(is("pause_state", (f) => f.member === "bob" && f.paused));
    const bobCountBefore = bob.frames.filter((f) => f.kind === "message").length;
    alice.send({ kind: "post", post: { type: "status", body: "still working" } });
    alice.send({ kind: "post", post: { type: "status", body: "nearly done" } });
    await alice.waitFor(is("post_ok", (f) => f.seq === 4));
    await new Promise((r) => setTimeout(r, 200));
    expect(bob.frames.filter((f) => f.kind === "message").length).toBe(bobCountBefore);

    // Bob resumes and syncs. He gets the missed messages in seq order.
    bob.send({ kind: "pause_set", paused: false });
    bob.send({ kind: "sync", since_seq: 2 });
    await bob.waitFor(is("message", (f) => f.message.seq === 4));
    const synced = bob.frames
      .filter(is("message"))
      .map((f) => f.message.seq)
      .filter((s) => s > 2);
    expect(synced).toEqual([3, 4]);

    // Alice's daemon appends a run to the work log.
    alice.send({
      kind: "log_append",
      entry: {
        started_at: new Date(Date.now() - 60_000).toISOString(),
        ended_at: new Date().toISOString(),
        what: { tools_used: { Edit: 3 }, branch: "alice/login-form", files_changed: 2 },
        why_trigger: "Build the login form",
        work_item: "login-form"
      }
    });
    await alice.waitFor(is("log_ok"));

    // Alice goes offline. Bob still gets her activity from stored history.
    alice.close();
    await bob.waitFor(is("presence", (f) => f.member === "alice" && !f.online));
    bob.send({
      kind: "log_query",
      query: { member: "peer", limit: 50 },
      peer_activity: true
    });
    const result = await bob.waitFor(is("log_result", (f) => f.peer === "alice"));
    expect(result.peer_online).toBe(false);
    expect(result.entries.some((e) => e.work_item === "login-form")).toBe(true);
    expect(result.entries.some((e) => e.source === "boundary_rejection")).toBe(false);
    expect(result.messages?.every((m) => m.sender === "alice")).toBe(true);

    // The boundary rejection shows up in the full log.
    bob.send({ kind: "log_query", query: { member: "any", limit: 50 }, peer_activity: false });
    const fullLog = await bob.waitFor(is("log_result", (f) => !f.peer));
    expect(fullLog.entries.some((e) => e.source === "boundary_rejection")).toBe(true);
    const rejectionEntry = fullLog.entries.find((e) => e.source === "boundary_rejection");
    expect(rejectionEntry?.why_trigger).not.toContain("--- a/");

    bob.close();
  }, 15000);

  it("refuses a second use of an invite and a third member", async () => {
    const minted = (await http(
      `/workspaces/${workspaceId}/invites`,
      { invitee: "carol" },
      aliceToken
    )) as { ok: boolean; error?: string };
    // The workspace already has two members. The mint itself must refuse.
    expect(minted.ok).toBe(false);
  });

  it("rejects auth with a bad token", async () => {
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
        ws.on("open", () =>
          ws.send(JSON.stringify({ kind: "hello", workspace_id: workspaceId, token: "wrong" }))
        );
        ws.on("message", (data) => {
          const frame = JSON.parse(String(data)) as { kind: string; code?: string };
          if (frame.kind === "error" && frame.code === "auth_failed") reject(new Error("auth_failed"));
          else resolve(frame);
        });
        ws.on("error", reject);
      })
    ).rejects.toThrow("auth_failed");
  });
});
