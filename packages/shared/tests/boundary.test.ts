// Boundary contract tests.
// The constitution requires proof that non-conforming payloads are rejected.
import { describe, expect, it } from "vitest";
import {
  ClientFrameSchema,
  MESSAGE_TYPES,
  REDACTED_WHY_TRIGGER,
  validateLogEntry,
  validatePost
} from "../src/index.js";

describe("boundary: accepted payloads", () => {
  it("accepts each of the five message types", () => {
    for (const type of MESSAGE_TYPES) {
      const result = validatePost({ type, body: "I will take the login form." });
      expect(result.ok, `type ${type} must pass`).toBe(true);
    }
  });

  it("accepts a valid branch ref and a valid commit ref", () => {
    const result = validatePost({
      type: "handoff",
      body: "Login form is ready.",
      refs: [
        { kind: "branch", value: "alice/login-form" },
        { kind: "commit", value: "a1b2c3d" }
      ]
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a short code fence (20 lines or fewer)", () => {
    const fence = "```\n" + "line\n".repeat(5) + "```";
    const result = validatePost({ type: "question", body: `Is this right?\n${fence}` });
    expect(result.ok).toBe(true);
  });
});

describe("boundary: rejected payloads", () => {
  it("rejects an unknown message type", () => {
    const result = validatePost({ type: "gossip", body: "hello" });
    expect(result).toMatchObject({ ok: false, reason: "unknown_type" });
  });

  it("rejects a missing message type", () => {
    const result = validatePost({ body: "hello" });
    expect(result).toMatchObject({ ok: false, reason: "unknown_type" });
  });

  it("rejects an invalid commit sha", () => {
    const result = validatePost({
      type: "handoff",
      body: "see ref",
      refs: [{ kind: "commit", value: "not-a-sha!" }]
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid_ref" });
  });

  it("rejects an invalid branch name", () => {
    const bad = ["has space", "double..dot", "-leading-dash", "trail/", "a.lock"];
    for (const value of bad) {
      const result = validatePost({
        type: "handoff",
        body: "see ref",
        refs: [{ kind: "branch", value }]
      });
      expect(result, `branch "${value}" must fail`).toMatchObject({
        ok: false,
        reason: "invalid_ref"
      });
    }
  });

  it("rejects a body over 4000 chars", () => {
    const result = validatePost({ type: "status", body: "x".repeat(4001) });
    expect(result).toMatchObject({ ok: false, reason: "payload_too_large" });
  });

  it("rejects a code fence over 20 lines", () => {
    const fence = "```ts\n" + "const x = 1;\n".repeat(30) + "```";
    const result = validatePost({ type: "status", body: fence });
    expect(result).toMatchObject({ ok: false, reason: "content_smuggling" });
  });

  it("rejects unified diff markers", () => {
    const body = "review this\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@";
    const result = validatePost({ type: "status", body });
    expect(result).toMatchObject({ ok: false, reason: "content_smuggling" });
  });

  it("rejects a base64 run over 512 chars", () => {
    const result = validatePost({ type: "status", body: "data: " + "A".repeat(600) });
    expect(result).toMatchObject({ ok: false, reason: "content_smuggling" });
  });

  it("never echoes the rejected body in the summary", () => {
    const secret = "SECRETCODE".repeat(80);
    const result = validatePost({ type: "status", body: secret });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.summary).not.toContain("SECRETCODE");
    }
  });
});

describe("boundary: frame shapes", () => {
  it("rejects an unknown frame kind", () => {
    const parsed = ClientFrameSchema.safeParse({ kind: "file_transfer", data: "..." });
    expect(parsed.success).toBe(false);
  });

  it("accepts a valid post frame", () => {
    const parsed = ClientFrameSchema.safeParse({
      kind: "post",
      post: { type: "intent", body: "claiming the parser", work_item: "parser" }
    });
    expect(parsed.success).toBe(true);
  });
});

// A log entry is a member-to-member channel: the peer reads why_trigger back
// through peer_activity. The CLI fills it with the human's verbatim prompt,
// so it needs the same content check a post gets (T054).
describe("boundary: log entries", () => {
  const base = {
    started_at: "2026-08-01T10:00:00.000Z",
    ended_at: "2026-08-01T10:05:00.000Z",
    what: { tools_used: { Edit: 2 } }
  };

  it("passes a clean entry through unchanged", () => {
    const entry = { ...base, why_trigger: "Build the login form", work_item: "login-form" };
    const result = validateLogEntry(entry);
    expect(result.redactions).toEqual([]);
    expect(result.entry).toEqual(entry);
  });

  it("removes a unified diff pasted into why_trigger", () => {
    const result = validateLogEntry({
      ...base,
      why_trigger: "fix this:\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@"
    });
    expect(result.entry.why_trigger).toBe(REDACTED_WHY_TRIGGER);
    expect(result.redactions).toMatchObject([
      { field: "why_trigger", reason: "content_smuggling" }
    ]);
  });

  it("removes a long code fence pasted into why_trigger", () => {
    const fence = "```ts\n" + "const x = 1;\n".repeat(30) + "```";
    const result = validateLogEntry({ ...base, why_trigger: `do this: ${fence}` });
    expect(result.entry.why_trigger).toBe(REDACTED_WHY_TRIGGER);
    expect(result.redactions[0]?.reason).toBe("content_smuggling");
  });

  it("removes a long base64 run pasted into why_trigger", () => {
    const result = validateLogEntry({ ...base, why_trigger: "apply " + "A".repeat(600) });
    expect(result.entry.why_trigger).toBe(REDACTED_WHY_TRIGGER);
  });

  it("never echoes the removed text in the summary", () => {
    const secret = "SECRETCODE".repeat(80);
    const result = validateLogEntry({ ...base, why_trigger: secret });
    expect(result.redactions[0]?.summary).not.toContain("SECRETCODE");
    expect(result.entry.why_trigger).not.toContain("SECRETCODE");
  });

  it("drops a branch field that is not a valid git ref", () => {
    const result = validateLogEntry({
      ...base,
      why_trigger: "refactor",
      what: { tools_used: {}, branch: "../../etc/passwd" }
    });
    expect(result.entry.what.branch).toBeUndefined();
    expect(result.redactions).toMatchObject([{ field: "what.branch", reason: "invalid_ref" }]);
  });

  it("drops a head field that is not a commit sha", () => {
    const result = validateLogEntry({
      ...base,
      why_trigger: "refactor",
      what: { tools_used: {}, head: "not-a-sha" }
    });
    expect(result.entry.what.head).toBeUndefined();
    expect(result.redactions).toMatchObject([{ field: "what.head", reason: "invalid_ref" }]);
  });

  it("keeps a valid branch and head", () => {
    const what = { tools_used: {}, branch: "alice/login-form", head: "a1b2c3d" };
    const result = validateLogEntry({ ...base, why_trigger: "refactor", what });
    expect(result.entry.what).toEqual(what);
    expect(result.redactions).toEqual([]);
  });

  it("keeps the run itself when it removes a field (FR-015)", () => {
    const result = validateLogEntry({
      ...base,
      why_trigger: "--- a/x.ts\n+++ b/x.ts",
      work_item: "login-form"
    });
    expect(result.entry.started_at).toBe(base.started_at);
    expect(result.entry.ended_at).toBe(base.ended_at);
    expect(result.entry.work_item).toBe("login-form");
    expect(result.entry.what.tools_used).toEqual({ Edit: 2 });
  });
});
