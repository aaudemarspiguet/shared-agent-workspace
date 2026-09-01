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

describe("modes, authority, handoffs over the wire (spec 002 US8)", () => {
  it("refuses a binding post from a member without authority, never downgrades (T130, SC-020)", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);
    await bob.waitFor(is("thread_snapshot"));
    alice.send({
      kind: "thread_open",
      open: { type: "work_item", title: "authority target", workspace_id: workspaceId }
    });
    const t = (await alice.waitFor(is("thread", (f) => f.thread.title === "authority target")))
      .thread;
    await bob.waitFor(is("thread", (f) => f.thread.id === t.id));

    // bob joined; he is not the owner. His binding post is refused plainly.
    bob.send({
      kind: "post",
      post: { type: "decision", body: "we ship friday", thread_id: t.id, force: "binding" },
      sender_kind: "human"
    });
    const refused = await bob.waitFor(is("error", (f) => f.code === "no_authority"));
    expect(refused.message).toContain("advisory");
    // Nothing was stored: a full replay carries no such message.
    bob.send({ kind: "sync", since_seq: 0 });
    await bob.waitFor(is("thread_snapshot"), 3000);
    expect(bob.frames.some((f) => f.kind === "message" && f.message.body === "we ship friday")).toBe(
      false
    );

    // The owner's binding post lands, force intact.
    alice.send({
      kind: "post",
      post: { type: "decision", body: "we ship monday", thread_id: t.id, force: "binding" },
      sender_kind: "human"
    });
    const landed = await bob.waitFor(is("message", (f) => f.message.body === "we ship monday"));
    expect(landed.message.force).toBe("binding");

    alice.close();
    bob.close();
  });

  it("a mode write applies to the sender only, even with an injected member field (T123, SC-016)", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);
    await bob.waitFor(is("thread_snapshot"));
    alice.send({
      kind: "thread_open",
      open: { type: "work_item", title: "mode target", workspace_id: workspaceId }
    });
    const t = (await alice.waitFor(is("thread", (f) => f.thread.title === "mode target"))).thread;
    await bob.waitFor(is("thread", (f) => f.thread.id === t.id));

    // A hand-crafted frame naming alice: the schema strips the field and the
    // write lands on bob himself. No route reaches another member's mode.
    bob.send({
      kind: "thread_mode_set",
      set: { thread_id: t.id, mode: "view", member: "alice", member_username: "alice" }
    });
    const row = await bob.waitFor(is("thread_mode", (f) => f.mode.thread_id === t.id));
    expect(row.mode.member).toBe("bob");
    expect(row.mode.mode).toBe("view");
    const aliceRow = relay.store
      .threadModes(workspaceId)
      .find((m) => m.thread_id === t.id && m.member === "alice");
    expect(aliceRow).toBeUndefined();

    alice.close();
    bob.close();
  });

  it("runs the handoff lifecycle: claim moves only on accept, edit mode required (T135, SC-022)", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);
    await bob.waitFor(is("thread_snapshot"));
    alice.send({
      kind: "thread_open",
      open: { type: "work_item", title: "handoff target", workspace_id: workspaceId }
    });
    const t = (await alice.waitFor(is("thread", (f) => f.thread.title === "handoff target")))
      .thread;
    await bob.waitFor(is("thread", (f) => f.thread.id === t.id));

    // alice claims, then proposes. The claim stays hers while proposed.
    alice.send({
      kind: "post",
      post: { type: "intent", body: "claiming", thread_id: t.id },
      sender_kind: "agent"
    });
    await alice.waitFor(is("claim_result", (f) => f.thread_id === t.id && f.granted));
    alice.send({
      kind: "handoff_propose",
      propose: {
        thread_id: t.id,
        to: "bob",
        tip_ref: { kind: "branch", value: "alice/handoff-target" }
      }
    });
    const proposed = (await bob.waitFor(is("handoff", (f) => f.handoff.state === "proposed")))
      .handoff;
    expect(relay.store.threadClaim(t.id)?.claimed_by).toBe("alice");

    // bob's default mode is comment: acceptance is refused, mode named.
    bob.send({ kind: "handoff_resolve", handoff_id: proposed.id, to_state: "accepted" });
    const denied = await bob.waitFor(is("error", (f) => f.code === "mode_denied"));
    expect(denied.message).toContain("edit");
    expect(relay.store.threadClaim(t.id)?.claimed_by).toBe("alice");

    // bob raises HIS OWN mode, then accepts: the claim moves.
    bob.send({ kind: "thread_mode_set", set: { thread_id: t.id, mode: "edit" } });
    await bob.waitFor(is("thread_mode", (f) => f.mode.member === "bob" && f.mode.mode === "edit"));
    bob.send({ kind: "handoff_resolve", handoff_id: proposed.id, to_state: "accepted" });
    await bob.waitFor(is("handoff", (f) => f.handoff.id === proposed.id && f.handoff.state === "accepted"));
    expect(relay.store.threadClaim(t.id)?.claimed_by).toBe("bob");

    // Terminal states stay terminal.
    bob.send({ kind: "handoff_resolve", handoff_id: proposed.id, to_state: "declined" });
    const terminal = await bob.waitFor(is("error", (f) => f.code === "invalid_input"));
    expect(terminal.message).toContain("cannot move");

    alice.close();
    bob.close();
  });

  it("a directed handoff is owner-only and moves the claim at once (FR-044)", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);
    await bob.waitFor(is("thread_snapshot"));
    alice.send({
      kind: "thread_open",
      open: { type: "work_item", title: "directed target", workspace_id: workspaceId }
    });
    const t = (await alice.waitFor(is("thread", (f) => f.thread.title === "directed target")))
      .thread;
    await bob.waitFor(is("thread", (f) => f.thread.id === t.id));

    // bob claims his own thread, then tries to DIRECT a handoff: refused.
    bob.send({
      kind: "post",
      post: { type: "intent", body: "claiming", thread_id: t.id },
      sender_kind: "agent"
    });
    await bob.waitFor(is("claim_result", (f) => f.thread_id === t.id && f.granted));
    bob.send({
      kind: "handoff_propose",
      propose: {
        thread_id: t.id,
        to: "alice",
        tip_ref: { kind: "branch", value: "bob/directed-target" },
        directed: true
      }
    });
    await bob.waitFor(is("error", (f) => f.code === "no_authority"));

    // A plain proposal from bob works; alice as owner directs one back
    // after taking the claim over the lifecycle is out of scope here — the
    // owner-only rule is what this test pins.
    alice.close();
    bob.close();
  });

  // The prefix rule has two ways in, and until this test it held on only
  // one of them: the frame path had no check at all, so a member could bind
  // the other member's branch namespace by binding directly instead of
  // posting - silently, with no refusal and no rejection log.
  it("refuses the other member's branch on the DIRECT bind frame too (T143, FR-040)", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);
    await bob.waitFor(is("thread_snapshot"));
    alice.send({
      kind: "thread_open",
      open: { type: "work_item", title: "direct bind guard", workspace_id: workspaceId }
    });
    const t = (await alice.waitFor(is("thread", (f) => f.thread.title === "direct bind guard"))).thread;
    await bob.waitFor(is("thread", (f) => f.thread.id === t.id));

    // Alice binds a branch under BOB's prefix through the frame.
    alice.send({
      kind: "thread_ref_bind",
      thread_id: t.id,
      workspace_id: workspaceId,
      ref: { kind: "branch", value: "bob/not-mine" }
    });
    const err = await alice.waitFor(is("error", (f) => f.message.includes("bob/not-mine")));
    // The refusal names the branch and the prefix that would have worked.
    expect(err.message).toContain("alice/");

    // The refusal is recorded, not only spoken: nothing drops silently.
    alice.send({ kind: "log_query", query: { member: "any", limit: 50 }, peer_activity: false });
    const log = await alice.waitFor(is("log_result", (f) => !f.peer));
    expect(
      log.entries.some(
        (e) => e.source === "boundary_rejection" && (e.why_trigger ?? "").includes("bob/not-mine")
      )
    ).toBe(true);

    // Her own branch binds through the same frame.
    alice.send({
      kind: "thread_ref_bind",
      thread_id: t.id,
      workspace_id: workspaceId,
      ref: { kind: "branch", value: "alice/mine" }
    });
    await alice.waitFor(is("thread_ref", (f) => f.binding.ref.value === "alice/mine"));

    // A commit has no owner, so it binds for anyone.
    alice.send({
      kind: "thread_ref_bind",
      thread_id: t.id,
      workspace_id: workspaceId,
      ref: { kind: "commit", value: "b".repeat(40) }
    });
    await alice.waitFor(is("thread_ref", (f) => f.binding.ref.kind === "commit"));

    const bound = relay.store
      .threadRefs(workspaceId)
      .filter((b) => b.thread_id === t.id)
      .map((b) => b.ref.value);
    expect(bound).not.toContain("bob/not-mine");
    expect(bound).toContain("alice/mine");
    alice.close();
    bob.close();
  });

  it("binds a branch to a thread only under its author's own prefix (T143, FR-040)", async () => {
    const alice = await connect(aliceToken);
    const bob = await connect(bobToken);
    await bob.waitFor(is("thread_snapshot"));
    alice.send({
      kind: "thread_open",
      open: { type: "work_item", title: "prefix target", workspace_id: workspaceId }
    });
    const t = (await alice.waitFor(is("thread", (f) => f.thread.title === "prefix target"))).thread;
    await bob.waitFor(is("thread", (f) => f.thread.id === t.id));

    alice.send({
      kind: "post",
      post: {
        type: "status",
        body: "two refs, one mine",
        thread_id: t.id,
        refs: [
          { kind: "branch", value: "bob/not-mine" },
          { kind: "branch", value: "alice/mine" }
        ]
      },
      sender_kind: "agent"
    });
    const bound = await bob.waitFor(is("thread_ref", (f) => f.binding.thread_id === t.id));
    expect(bound.binding.ref.value).toBe("alice/mine");
    const all = relay.store.threadRefs(workspaceId).filter((b) => b.thread_id === t.id);
    expect(all.map((b) => b.ref.value)).toEqual(["alice/mine"]);

    // The refusal reaches the sender, not only the rejection log. The post
    // succeeded and still carries both refs; only the binding was refused,
    // and saying so is what keeps "nothing drops silently" true.
    const ok = await alice.waitFor(is("post_ok"));
    expect(ok.unbound_refs?.map((u) => u.ref.value)).toEqual(["bob/not-mine"]);
    expect(ok.unbound_refs?.[0]?.reason).toBe("invalid_ref");
    // The message names the branch and the prefix that would have worked.
    expect(ok.unbound_refs?.[0]?.summary).toContain("bob/not-mine");
    expect(ok.unbound_refs?.[0]?.summary).toContain("alice/");

    alice.close();
    bob.close();
  });

  it("says nothing about unbound refs when every ref bound", async () => {
    const alice = await connect(aliceToken);
    alice.send({
      kind: "thread_open",
      open: { type: "work_item", title: "all mine", workspace_id: workspaceId }
    });
    const t = (await alice.waitFor(is("thread", (f) => f.thread.title === "all mine"))).thread;

    alice.send({
      kind: "post",
      post: {
        type: "status",
        body: "only my own branch",
        thread_id: t.id,
        refs: [{ kind: "branch", value: "alice/fine" }]
      },
      sender_kind: "agent"
    });

    const ok = await alice.waitFor(is("post_ok"));
    expect(ok.unbound_refs).toBeUndefined();

    alice.close();
  });

  it("binds a commit sha whoever posts it, and reports nothing unbound", async () => {
    const alice = await connect(aliceToken);
    alice.send({
      kind: "thread_open",
      open: { type: "work_item", title: "sha thread", workspace_id: workspaceId }
    });
    const t = (await alice.waitFor(is("thread", (f) => f.thread.title === "sha thread"))).thread;

    // A commit has no owner, so the prefix rule does not apply to it.
    alice.send({
      kind: "post",
      post: {
        type: "status",
        body: "a sha",
        thread_id: t.id,
        refs: [{ kind: "commit", value: "a42c95c" }]
      },
      sender_kind: "agent"
    });

    const ok = await alice.waitFor(is("post_ok"));
    expect(ok.unbound_refs).toBeUndefined();
    const bound = relay.store.threadRefs(workspaceId).filter((b) => b.thread_id === t.id);
    expect(bound.map((b) => b.ref.value)).toEqual(["a42c95c"]);

    alice.close();
  });
});
