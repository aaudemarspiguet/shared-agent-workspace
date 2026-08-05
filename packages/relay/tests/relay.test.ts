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

/** Wait until no member holds a live socket, so presence starts from empty. */
async function waitForQuietRelay(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const live = relay.store.members(workspaceId).filter((m) => relay.registry.isOnline(m.id));
    if (live.length === 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("relay still has live connections");
}

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
    repo_remote: string;
  };
  expect(joined.ok).toBe(true);
  expect(joined.members).toEqual(["alice", "bob"]);
  // The joiner cannot check that they are in the right repository without
  // this (contracts/cli.md "saw join" preconditions).
  expect(joined.repo_remote).toBe("git@github.com:acme/app.git");
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

  // Found by running two live members against a real relay, not by a gate:
  // whoever started their stack second read the other as offline for the
  // whole session, and it never self-corrected. The existing coverage only
  // asserted that a broadcast fires, which is why it passed (T074).
  it("gives a member the current presence of the other on join", async () => {
    await waitForQuietRelay();

    // Alice is first. The snapshot tells her bob is not here.
    const alice = await connect(workspaceId, aliceToken);
    const bobOffline = await alice.waitFor(is("presence", (f) => f.member === "bob"));
    expect(bobOffline.online).toBe(false);
    expect(bobOffline.last_seen_at).toBeTruthy();

    // Bob is second. Before T074 he never heard about alice at all, because
    // her broadcast fired before he had a socket to receive it.
    const bob = await connect(workspaceId, bobToken);
    const aliceOnline = await bob.waitFor(is("presence", (f) => f.member === "alice"));
    expect(aliceOnline.online).toBe(true);

    // The direction that already worked still works.
    const bobOnline = await alice.waitFor(is("presence", (f) => f.member === "bob" && f.online));
    expect(bobOnline.online).toBe(true);

    // The snapshot does not duplicate what the broadcast already delivers:
    // bob hears about alice exactly once, from the snapshot.
    expect(bob.frames.filter((f) => f.kind === "presence" && f.member === "alice")).toHaveLength(1);

    alice.close();
    bob.close();
  });

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

  it("scrubs a log entry that carries smuggled content, and logs the rejection", async () => {
    const alice = await connect(workspaceId, aliceToken);
    const bob = await connect(workspaceId, bobToken);

    // A human pastes a diff into their prompt. The CLI copies the prompt
    // verbatim into why_trigger, so it arrives here (T054).
    alice.send({
      kind: "log_append",
      entry: {
        started_at: new Date(Date.now() - 30_000).toISOString(),
        ended_at: new Date().toISOString(),
        what: { tools_used: { Edit: 1 }, branch: "alice/../../etc/passwd" },
        why_trigger: "apply this:\n--- a/src/secret.ts\n+++ b/src/secret.ts\n@@ -1 +1 @@",
        work_item: "smuggle-check"
      }
    });
    const ok = await alice.waitFor(is("log_ok", (f) => Boolean(f.redacted)));
    expect(ok.redacted?.map((r) => r.field).sort()).toEqual(["what.branch", "why_trigger"]);

    // The run is still logged (FR-015), but the peer cannot read the payload.
    bob.send({ kind: "log_query", query: { member: "peer", limit: 50 }, peer_activity: true });
    const seen = await bob.waitFor(is("log_result", (f) => f.peer === "alice"));
    const run = seen.entries.find((e) => e.work_item === "smuggle-check");
    expect(run).toBeDefined();
    expect(run?.why_trigger).not.toContain("--- a/");
    expect(run?.why_trigger).not.toContain("secret.ts");
    expect(run?.what.branch).toBeUndefined();

    // And the rejection appears in the full log (SC-005).
    bob.send({ kind: "log_query", query: { member: "any", limit: 50 }, peer_activity: false });
    const full = await bob.waitFor(is("log_result", (f) => !f.peer));
    const rejections = full.entries.filter((e) => e.source === "boundary_rejection");
    expect(rejections.some((e) => e.why_trigger.includes("why_trigger"))).toBe(true);
    expect(rejections.every((e) => !e.why_trigger.includes("secret.ts"))).toBe(true);

    alice.close();
    bob.close();
  });

  it("keeps the run when a log_append field is over its cap (T073)", async () => {
    const alice = await connect(workspaceId, aliceToken);
    const bob = await connect(workspaceId, bobToken);

    // Every one of these failed the frame schema before T073, so the relay
    // sent post_rejected and the run was never stored at all.
    alice.send({
      kind: "log_append",
      entry: {
        started_at: new Date(Date.now() - 30_000).toISOString(),
        ended_at: new Date().toISOString(),
        what: { tools_used: { Edit: 1 }, branch: "b".repeat(300), extra_key: "x" },
        why_trigger: "why ".repeat(400),
        work_item: "over-limit-check" + "-x".repeat(60)
      }
    });
    const ok = await alice.waitFor(is("log_ok", (f) => Boolean(f.redacted)));
    expect(ok.redacted?.map((r) => r.field).sort()).toEqual([
      "what",
      "what.branch",
      "why_trigger",
      "work_item"
    ]);

    // The run is stored and the peer can read it (FR-015, SC-003).
    bob.send({ kind: "log_query", query: { member: "peer", limit: 50 }, peer_activity: true });
    const seen = await bob.waitFor(is("log_result", (f) => f.peer === "alice"));
    const run = seen.entries.find((e) => e.work_item.startsWith("over-limit-check"));
    expect(run).toBeDefined();
    expect(run?.work_item).toHaveLength(100);
    expect(run?.why_trigger).toHaveLength(1000);
    expect(run?.what.branch).toBeUndefined();
    expect(run?.what.tools_used).toEqual({ Edit: 1 });

    // Each removal is still a rejection in the log (SC-005).
    bob.send({ kind: "log_query", query: { member: "any", limit: 100 }, peer_activity: false });
    const full = await bob.waitFor(is("log_result", (f) => !f.peer));
    const rejections = full.entries.filter((e) => e.source === "boundary_rejection");
    expect(rejections.some((e) => e.why_trigger.includes("payload_too_large"))).toBe(true);

    alice.close();
    bob.close();
  });

  it("refuses a frame over the payload cap and stays up (T070)", async () => {
    const alice = await connect(workspaceId, aliceToken);
    const bob = await connect(workspaceId, bobToken);

    // With the `ws` default of 100 MiB, this frame was simply accepted.
    alice.send({
      kind: "post",
      post: { type: "status", body: "x", filler: "SECRETCODE".repeat(60_000) }
    });
    await new Promise((r) => setTimeout(r, 150));

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);

    // The rejection is in the log, without the payload (SC-005).
    bob.send({ kind: "log_query", query: { member: "any", limit: 200 }, peer_activity: false });
    const full = await bob.waitFor(is("log_result", (f) => !f.peer));
    const oversize = full.entries.filter(
      (e) => e.source === "boundary_rejection" && e.why_trigger.includes("bytes")
    );
    expect(oversize).toHaveLength(1);
    expect(oversize[0]?.why_trigger).toContain("payload_too_large");
    expect(oversize[0]?.why_trigger).not.toContain("SECRETCODE");

    bob.close();
  });

  it("survives a connection that dies without a close handshake", async () => {
    const alice = await connect(workspaceId, aliceToken);
    const bob = await connect(workspaceId, bobToken);

    // Reset the TCP connection instead of closing it. The server socket
    // raises 'error'; unhandled, that would end the relay process and take
    // the other member down with it.
    bob.ws.terminate();
    await new Promise((r) => setTimeout(r, 100));

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);

    // Alice is unaffected and a new connection still authenticates.
    const bobAgain = await connect(workspaceId, bobToken);
    alice.send({ kind: "post", post: { type: "status", body: "still here" } });
    await bobAgain.waitFor(is("message", (f) => f.message.body === "still here"));

    alice.close();
    bobAgain.close();
  });
});
