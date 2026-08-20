// Unit tests for the durable run log spool (T055).
// These cover the parts a live relay cannot show: the exact send order, the
// cap, and what two overlapping drains do. Each test gets a fresh temp dir.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunLogEntryInput } from "@saw/shared";
import { logSpoolPath } from "../src/config.js";
import { LogSpool } from "../src/daemon/log-spool.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saw-spool-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One run entry. The number makes the entry easy to name in an assertion. */
function run(n: number): RunLogEntryInput {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return {
    started_at: at,
    ended_at: at,
    what: { tools_used: { Edit: n } },
    why_trigger: `run ${n}`
  };
}

/** A sender that records what it was asked to send. */
function recorder(accept: () => boolean = () => true) {
  const seen: string[] = [];
  return {
    seen,
    send: async (entry: RunLogEntryInput) => {
      seen.push(entry.why_trigger);
      return { ok: accept() };
    }
  };
}

describe("LogSpool add and drain", () => {
  it("sends the held runs oldest first and then empties the file", async () => {
    const spool = new LogSpool(root);
    spool.add(run(1));
    spool.add(run(2));
    spool.add(run(3));
    expect(spool.size).toBe(3);
    expect(existsSync(logSpoolPath(root))).toBe(true);

    const rec = recorder();
    const result = await spool.drain(rec.send);
    expect(result).toEqual({ sent: 3, remaining: 0, busy: false });
    expect(rec.seen).toEqual(["run 1", "run 2", "run 3"]);
    expect(spool.size).toBe(0);
    expect(existsSync(logSpoolPath(root))).toBe(false);
  });

  it("keeps the original timestamps of each run", async () => {
    const spool = new LogSpool(root);
    spool.add(run(7));
    const sent: RunLogEntryInput[] = [];
    await spool.drain(async (entry) => {
      sent.push(entry);
      return { ok: true };
    });
    expect(sent[0]?.started_at).toBe(run(7).started_at);
    expect(sent[0]?.ended_at).toBe(run(7).ended_at);
  });

  it("stops at the first refusal and keeps the rest in order", async () => {
    const spool = new LogSpool(root);
    spool.add(run(1));
    spool.add(run(2));
    spool.add(run(3));

    // The relay takes the first run, then goes away again.
    let calls = 0;
    const first = await spool.drain(async () => {
      calls += 1;
      return { ok: calls === 1 };
    });
    expect(first.sent).toBe(1);
    expect(first.remaining).toBe(2);
    expect(spool.list().map((r) => r.entry.why_trigger)).toEqual(["run 2", "run 3"]);

    // The next drain resumes at run 2. Run 1 is never sent again.
    const rec = recorder();
    const second = await spool.drain(rec.send);
    expect(second.sent).toBe(2);
    expect(rec.seen).toEqual(["run 2", "run 3"]);
  });

  it("does not send the same run twice when two drains overlap", async () => {
    const spool = new LogSpool(root);
    spool.add(run(1));
    spool.add(run(2));

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    let firstSend = true;

    const slow = async (entry: RunLogEntryInput) => {
      seen.push(entry.why_trigger);
      if (firstSend) {
        firstSend = false;
        await gate;
      }
      return { ok: true };
    };

    const running = spool.drain(slow);
    // A reconnect lands while the first send is still in flight.
    const overlapping = await spool.drain(slow);
    expect(overlapping).toEqual({ sent: 0, remaining: 2, busy: true });

    release();
    const result = await running;
    expect(result.sent).toBe(2);
    expect(seen).toEqual(["run 1", "run 2"]);
  });

  it("gives an overlapping drain a pass of its own after a refusal", async () => {
    const spool = new LogSpool(root);
    spool.add(run(1));

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    let attempt = 0;

    // The first send waits, then fails: that is the socket going away. The
    // reconnect lands while it waits, so the drain owes it one more pass.
    const send = async (entry: RunLogEntryInput) => {
      seen.push(entry.why_trigger);
      attempt += 1;
      if (attempt === 1) {
        await gate;
        return { ok: false };
      }
      return { ok: true };
    };

    const running = spool.drain(send);
    expect((await spool.drain(send)).busy).toBe(true);
    release();

    const result = await running;
    expect(seen).toEqual(["run 1", "run 1"]);
    expect(result.sent).toBe(1);
    expect(spool.size).toBe(0);
  });

  it("treats a thrown send as a refusal and keeps the run", async () => {
    const spool = new LogSpool(root);
    spool.add(run(1));
    const result = await spool.drain(async () => {
      throw new Error("socket is gone");
    });
    expect(result.sent).toBe(0);
    expect(spool.size).toBe(1);
  });
});

describe("LogSpool cap", () => {
  it("drops the oldest runs at the cap and keeps the newest", () => {
    const spool = new LogSpool(root, 3);
    for (let n = 1; n <= 5; n += 1) spool.add(run(n));
    expect(spool.size).toBe(3);
    expect(spool.dropped).toBe(2);
    expect(spool.list().map((r) => r.entry.why_trigger)).toEqual([
      "run 3",
      "run 4",
      "run 5"
    ]);
  });

  it("writes the cap through to the file", () => {
    const spool = new LogSpool(root, 2);
    for (let n = 1; n <= 4; n += 1) spool.add(run(n));
    const reloaded = new LogSpool(root, 2);
    expect(reloaded.list().map((r) => r.entry.why_trigger)).toEqual(["run 3", "run 4"]);
  });
});

describe("LogSpool file", () => {
  it("survives a daemon restart with the order intact", () => {
    const spool = new LogSpool(root);
    spool.add(run(1));
    spool.add(run(2));

    const reloaded = new LogSpool(root);
    expect(reloaded.list().map((r) => r.entry.why_trigger)).toEqual(["run 1", "run 2"]);
  });

  it("drops a half written last line and keeps the whole runs", () => {
    const spool = new LogSpool(root);
    spool.add(run(1));
    const path = logSpoolPath(root);
    writeFileSync(path, readFileSync(path, "utf8") + '{"id":"x","entry":{"start', "utf8");

    const reloaded = new LogSpool(root);
    expect(reloaded.list().map((r) => r.entry.why_trigger)).toEqual(["run 1"]);
  });

  it("drops a line that is not a valid run entry", () => {
    const spool = new LogSpool(root);
    spool.add(run(1));
    const path = logSpoolPath(root);
    writeFileSync(
      path,
      readFileSync(path, "utf8") + '{"id":"x","entry":{"started_at":"nonsense"}}\n',
      "utf8"
    );

    const reloaded = new LogSpool(root);
    expect(reloaded.size).toBe(1);
  });

  it("adds the spool line to .gitignore the first time it writes", () => {
    // An older workspace wrote .gitignore before the spool existed.
    writeFileSync(join(root, ".gitignore"), "# SAW member-local files\n.saw/credential\n");
    new LogSpool(root);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).not.toContain("log-spool");

    new LogSpool(root).add(run(1));
    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ignore).toContain(".saw/log-spool.jsonl");
    expect(ignore).toContain(".saw/log-spool.jsonl.tmp");
    // The header is written once, not once per call.
    expect(ignore.split("# SAW member-local files").length - 1).toBe(1);
  });
});
