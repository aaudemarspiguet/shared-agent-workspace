// The ack endpoint moves a persisted cursor. A bad value silences the member.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon, startWebServer } from "@saw/cli";
import { startWeb, twoMemberWorkspace, waitFor, type TestWorkspace } from "./helpers.js";

describe("injection acknowledgement bounds (PR #54 review)", () => {
  let ws: TestWorkspace;
  let web: Awaited<ReturnType<typeof startWeb>>;

  beforeAll(async () => {
    ws = await twoMemberWorkspace();
    web = await startWeb(ws.bob);
  });

  afterAll(async () => {
    await web.close();
    await ws.close();
  });

  async function ack(body: unknown) {
    const res = await fetch(`${web.url}/api/inject/ack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${web.token}`
      },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: (await res.json()) as unknown };
  }

  it("refuses a seq above anything the daemon issued, and keeps delivering", async () => {
    await ws.alice.daemon.post({ type: "status", body: "must not be lost", refs: [] }, "agent");
    await waitFor(
      () => ws.bob.daemon.messages(0).messages.some((m) => m.body === "must not be lost"),
      "bob to receive the message"
    );

    expect((await ack({ seq: 9_000_000 })).status).toBe(400);

    // The cursor did not move, so the message still arrives.
    const injected = ws.bob.daemon.inject("prompt-submit");
    expect(injected.messages.some((m) => m.body === "must not be lost")).toBe(true);
  });

  it("accepts the seq the daemon issued", async () => {
    const injected = ws.bob.daemon.inject("prompt-submit");
    expect((await ack({ seq: injected.ack_seq, notices: injected.ack_notices })).status).toBe(200);
    expect(ws.bob.daemon.inject("prompt-submit").messages.length).toBe(0);
  });

  it("refuses a negative notice count", async () => {
    expect((await ack({ seq: 0, notices: -1 })).status).toBe(400);
  });

  // The bound must not be latestSeq() alone. A daemon that has restarted but
  // not yet synced holds a persisted cursor over an empty cache, and inject()
  // answers with the cursor in that state. Rejecting it would stall the
  // cursor forever — the same defect in the other direction.
  it("accepts an ack at the cursor while the message cache is still empty", async () => {
    // bob's cursor is already past zero from the test above.
    const persisted = ws.bob.daemon.cursor.value;
    expect(persisted).toBeGreaterThan(0);

    // A second daemon on the same root: persisted cursor, nothing synced yet.
    const restarted = new Daemon({ root: ws.bob.root });
    try {
      expect(restarted.state.latestSeq()).toBe(0);
      expect(restarted.cursor.value).toBe(persisted);

      const empty = restarted.inject("prompt-submit");
      expect(empty.messages.length).toBe(0);
      expect(empty.ack_seq).toBe(persisted);

      const web2 = await startWebServer(restarted, 0);
      try {
        const res = await fetch(`http://127.0.0.1:${web2.port}/api/inject/ack`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${web2.token}`
          },
          body: JSON.stringify({ seq: empty.ack_seq })
        });
        expect(res.status).toBe(200);
      } finally {
        await web2.close();
      }
    } finally {
      restarted.stop();
    }
  });
});
