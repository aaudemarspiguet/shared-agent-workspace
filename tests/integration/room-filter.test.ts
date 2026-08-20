// T066 — filter the room by work item.
// The filter is a view: it narrows the messages only. It never moves the read
// cursor, and latest_seq keeps reporting the latest seq of the whole room.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiGet,
  startWeb,
  twoMemberWorkspace,
  waitFor,
  type TestWorkspace
} from "./helpers.js";

interface MessagePage {
  messages: { seq: number; body: string; work_item?: string }[];
  latest_seq: number;
}

describe("room filter by work item (T066)", () => {
  let ws: TestWorkspace;
  let web: Awaited<ReturnType<typeof startWeb>>;

  /** Post one message as alice. Fail loudly when the relay refuses it. */
  async function post(type: "intent" | "status", body: string, workItem?: string) {
    const outcome = await ws.alice.daemon.post(
      { type, body, refs: [], work_item: workItem },
      "agent"
    );
    if (!outcome.ok) throw new Error(`post failed: ${outcome.message}`);
  }

  /** Read one page of messages from bob's local API. */
  async function read(query: string): Promise<MessagePage> {
    const res = await apiGet(web, `/api/messages?${query}`);
    expect(res.status).toBe(200);
    return res.json as MessagePage;
  }

  beforeAll(async () => {
    ws = await twoMemberWorkspace();
    web = await startWeb(ws.bob);

    // Two features in flight, plus one message with no work item.
    await post("intent", "I take the login form.", "login-form");
    await post("intent", "I take the search box.", "search-box");
    await post("status", "Standup in five minutes.");
    await post("status", "Login form is in review.", "login-form");

    await waitFor(
      () => ws.bob.daemon.messages(0).messages.length === 4,
      "bob to receive all four messages"
    );
  });

  afterAll(async () => {
    await web.close();
    await ws.close();
  });

  it("returns only the messages of the chosen work item", async () => {
    const page = await read("since_seq=0&work_item=login-form");
    expect(page.messages.map((m) => m.body)).toEqual([
      "I take the login form.",
      "Login form is in review."
    ]);
    expect(page.messages.every((m) => m.work_item === "login-form")).toBe(true);
  });

  it("keeps latest_seq at the true latest seq of the room", async () => {
    const all = await read("since_seq=0");
    const filtered = await read("since_seq=0&work_item=search-box");
    expect(all.messages).toHaveLength(4);
    expect(filtered.messages).toHaveLength(1);
    // The filtered page holds one older message, but the position is the same.
    expect(filtered.latest_seq).toBe(all.latest_seq);
    expect(filtered.latest_seq).toBe(ws.bob.daemon.state.latestSeq());
    expect(filtered.messages[0].seq).toBeLessThan(filtered.latest_seq);
  });

  it("returns an empty list for a work item nobody used", async () => {
    const page = await read("since_seq=0&work_item=no-such-item");
    expect(page.messages).toEqual([]);
    expect(page.latest_seq).toBe(ws.bob.daemon.state.latestSeq());
  });

  it("does not move the read cursor", async () => {
    const before = ws.bob.daemon.cursor.value;
    await read("work_item=login-form");
    await read("since_seq=0&work_item=search-box");
    await read("since_seq=0");
    expect(ws.bob.daemon.cursor.value).toBe(before);
  });

  // The filter must run before the limit. If it ran after, a bounded read
  // would answer with only the matches that fell inside the first page, and
  // a work item discussed late in a busy room would look like it had no
  // messages at all.
  it("fills a small limit with the item's own messages, not the first page", async () => {
    for (let i = 1; i <= 12; i += 1) {
      const posted = await ws.alice.daemon.post(
        { type: "status", body: `noise ${i}`, refs: [] },
        "agent"
      );
      expect(posted.ok).toBe(true);
    }
    const tagged = await ws.alice.daemon.post(
      { type: "status", body: "late but tagged", refs: [], work_item: "search-box" },
      "agent"
    );
    expect(tagged.ok).toBe(true);
    await waitFor(
      () => ws.bob.daemon.messages(0, 500).messages.some((m) => m.body === "late but tagged"),
      "bob to receive the late tagged message"
    );

    // Only 3 messages, but they must be search-box messages from anywhere in
    // the room — not "search-box messages among the oldest 3".
    const page = await read("since_seq=0&limit=3&work_item=search-box");
    expect(page.messages.length).toBeGreaterThan(0);
    expect(page.messages.every((m) => m.work_item === "search-box")).toBe(true);
    expect(page.messages.map((m) => m.body)).toContain("late but tagged");
  });

  it("still starts from the read cursor when since_seq is absent", async () => {
    const first = ws.bob.daemon.messages(0).messages[0];
    ws.bob.daemon.ackInjection(first.seq);
    const page = await read("work_item=login-form");
    // The first login-form message is at the cursor now, so it is gone.
    expect(page.messages.map((m) => m.body)).toEqual(["Login form is in review."]);
    expect(page.latest_seq).toBe(ws.bob.daemon.state.latestSeq());
  });
});
