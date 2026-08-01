// Boundary contract tests.
// The constitution requires proof that non-conforming payloads are rejected.
import { describe, expect, it } from "vitest";
import {
  ClientFrameSchema,
  MESSAGE_TYPES,
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
