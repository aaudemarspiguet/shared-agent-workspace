// Boundary contract tests.
// The constitution requires proof that non-conforming payloads are rejected.
import { describe, expect, it } from "vitest";
import {
  ClientFrameSchema,
  findSmuggledContent,
  MAX_TOOLS_USED_KEYS,
  MAX_WHY_TRIGGER_LENGTH,
  MESSAGE_TYPES,
  MISSING_WHY_TRIGGER,
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

  // body is not the only free text on a post. work_item and target cross to
  // the peer the same way and were unchecked until T070.
  it("rejects diff markers in work_item and in target", () => {
    for (const field of ["work_item", "target"] as const) {
      const result = validatePost({
        type: "status",
        body: "on it",
        [field]: "--- a/src/x.ts"
      });
      expect(result, `${field} must be checked`).toMatchObject({
        ok: false,
        reason: "content_smuggling"
      });
    }
  });

  it("reports an over-long work_item or target as too large, not as bad shape", () => {
    for (const field of ["work_item", "target"] as const) {
      const result = validatePost({ type: "status", body: "on it", [field]: "x".repeat(101) });
      expect(result, `${field} must be too large`).toMatchObject({
        ok: false,
        reason: "payload_too_large"
      });
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

// The keys of what.tools_used are member-controlled free text: the CLI copies
// them from the tool names on the sending machine, and a member controls the
// names of their own MCP tools. So are work_item and the unknown keys of
// what. None of them was checked until T070.
describe("boundary: the rest of a log entry (T070)", () => {
  const base = {
    started_at: "2026-08-01T10:00:00.000Z",
    ended_at: "2026-08-01T10:05:00.000Z",
    why_trigger: "Build the login form"
  };

  it("drops a source file smuggled in as a tool name", () => {
    const source = "export function secret() {\n  return 1;\n}\n".repeat(150);
    const result = validateLogEntry({
      ...base,
      what: { tools_used: { Edit: 1, [source]: 1 } }
    });
    expect(Object.keys(result.entry.what.tools_used)).toEqual(["Edit"]);
    expect(result.redactions).toMatchObject([
      { field: "what.tools_used", reason: "content_smuggling" }
    ]);
    expect(result.redactions[0]?.summary).not.toContain("secret");
  });

  it("drops a diff smuggled in as a tool name", () => {
    const result = validateLogEntry({
      ...base,
      what: { tools_used: { "--- a/src/x.ts": 1 } }
    });
    expect(result.entry.what.tools_used).toEqual({});
    expect(result.redactions[0]?.reason).toBe("content_smuggling");
  });

  it("drops a multi-line tool name", () => {
    const result = validateLogEntry({
      ...base,
      what: { tools_used: { "Edit\nconst secret = 1;": 1 } }
    });
    expect(result.entry.what.tools_used).toEqual({});
  });

  it("caps the number of tool names", () => {
    const tools: Record<string, number> = {};
    for (let i = 0; i < 5000; i += 1) tools[`Tool${i}`] = 1;
    const result = validateLogEntry({ ...base, what: { tools_used: tools } });
    expect(Object.keys(result.entry.what.tools_used)).toHaveLength(MAX_TOOLS_USED_KEYS);
    expect(result.redactions).toMatchObject([
      { field: "what.tools_used", reason: "payload_too_large" }
    ]);
  });

  it("drops a tool count that is not a count", () => {
    const result = validateLogEntry({
      ...base,
      what: { tools_used: { Edit: 1, Bash: "rm -rf /home/bob" } }
    });
    expect(result.entry.what.tools_used).toEqual({ Edit: 1 });
    expect(result.redactions).toMatchObject([{ field: "what.tools_used", reason: "not_json" }]);
  });

  it("drops diff markers in work_item", () => {
    const result = validateLogEntry({
      ...base,
      what: { tools_used: {} },
      work_item: "--- a/src/x.ts"
    });
    expect(result.entry.work_item).toBeUndefined();
    expect(result.redactions).toMatchObject([
      { field: "work_item", reason: "content_smuggling" }
    ]);
  });

  it("drops an unknown key inside what, and never names it", () => {
    const result = validateLogEntry({
      ...base,
      what: { tools_used: {}, payload: "SECRETCODE" } as never
    });
    expect(result.entry.what).toEqual({ tools_used: {} });
    expect(result.redactions).toMatchObject([{ field: "what", reason: "not_json" }]);
    expect(result.redactions[0]?.summary).not.toContain("payload");
    expect(result.redactions[0]?.summary).not.toContain("SECRETCODE");
  });
});

// Before T073 each of these failed the frame schema, so the relay refused the
// frame and the run was never stored — the opposite of the FR-015 reasoning
// that T054 wrote into the code and the contract.
describe("boundary: an over-limit field keeps its run (T073)", () => {
  const base = {
    started_at: "2026-08-01T10:00:00.000Z",
    ended_at: "2026-08-01T10:05:00.000Z",
    what: { tools_used: { Edit: 2 } }
  };

  it("trims a why_trigger over the cap instead of losing the run", () => {
    const why = "why ".repeat(400); // 1600 chars, clean
    const result = validateLogEntry({ ...base, why_trigger: why });
    expect(result.entry.why_trigger).toHaveLength(MAX_WHY_TRIGGER_LENGTH);
    expect(result.entry.started_at).toBe(base.started_at);
    expect(result.redactions).toMatchObject([
      { field: "why_trigger", reason: "payload_too_large" }
    ]);
  });

  it("trims a work_item over the cap instead of losing the run", () => {
    const result = validateLogEntry({ ...base, why_trigger: "ok", work_item: "w".repeat(150) });
    expect(result.entry.work_item).toHaveLength(100);
    expect(result.redactions).toMatchObject([
      { field: "work_item", reason: "payload_too_large" }
    ]);
  });

  it("drops an over-long branch and head instead of losing the run", () => {
    const result = validateLogEntry({
      ...base,
      why_trigger: "ok",
      what: { tools_used: {}, branch: "b".repeat(300), head: "a".repeat(64) }
    });
    expect(result.entry.what.branch).toBeUndefined();
    expect(result.entry.what.head).toBeUndefined();
    expect(result.redactions.map((r) => r.field)).toEqual(["what.branch", "what.head"]);
  });

  it("fills an empty why_trigger rather than refusing the entry", () => {
    const result = validateLogEntry({ ...base, why_trigger: "" });
    expect(result.entry.why_trigger).toBe(MISSING_WHY_TRIGGER);
    // Nothing was removed, so nothing is reported as removed.
    expect(result.redactions).toEqual([]);
  });

  it("checks content before length, so a long diff is replaced not trimmed", () => {
    const result = validateLogEntry({
      ...base,
      why_trigger: "--- a/src/x.ts\n" + "+ leaked\n".repeat(300)
    });
    expect(result.entry.why_trigger).toBe(REDACTED_WHY_TRIGGER);
    expect(result.entry.why_trigger).not.toContain("leaked");
    expect(result.redactions[0]?.reason).toBe("content_smuggling");
  });

  it("still refuses a frame with no usable run in it", () => {
    const noStart = ClientFrameSchema.safeParse({
      kind: "log_append",
      entry: { ended_at: base.ended_at, what: {}, why_trigger: "ok" }
    });
    expect(noStart.success).toBe(false);

    const badTime = ClientFrameSchema.safeParse({
      kind: "log_append",
      entry: { started_at: "yesterday", ended_at: base.ended_at, what: {}, why_trigger: "ok" }
    });
    expect(badTime.success).toBe(false);
  });

  it("accepts the frame for every entry the boundary can repair", () => {
    const parsed = ClientFrameSchema.safeParse({
      kind: "log_append",
      entry: {
        started_at: base.started_at,
        ended_at: base.ended_at,
        what: { tools_used: {}, branch: "b".repeat(300), surprise: "x" },
        why_trigger: "w".repeat(5000),
        work_item: "i".repeat(500)
      }
    });
    expect(parsed.success).toBe(true);
  });
});

describe("boundary: a payload whose whitespace was collapsed (T080)", () => {
  /** What `packages/cli/src/daemon/run-context.ts` does to a prompt. */
  const flatten = (text: string): string => text.replace(/\s+/g, " ").trim();

  /** The full CLI path: flatten, then cut to the `why_trigger` excerpt cap. */
  const WHY_LIMIT = 600;
  const excerpt = (text: string): string => {
    const flat = flatten(text);
    return flat.length > WHY_LIMIT ? flat.slice(0, WHY_LIMIT - 1) + "…" : flat;
  };

  const times = {
    started_at: "2026-08-20T10:00:00.000Z",
    ended_at: "2026-08-20T10:05:00.000Z"
  };

  /** The entry the daemon sends after it works the human's prompt over. */
  function runFrom(whyTrigger: string) {
    return validateLogEntry({
      ...times,
      what: { tools_used: { Edit: 1 } },
      why_trigger: whyTrigger
    });
  }

  it("catches a diff whose newlines are gone", () => {
    const diff = [
      "apply this:",
      "--- a/src/secret.ts",
      "+++ b/src/secret.ts",
      "@@ -1,3 +1,4 @@",
      " const key = process.env.API_KEY;"
    ].join("\n");

    // Unflattened, this was already caught. Flattened, every line anchor is
    // gone, so the whole thing crossed into the shared log unredacted.
    expect(validatePost({ type: "status", body: diff }).ok).toBe(false);
    expect(validatePost({ type: "status", body: flatten(diff) }).ok).toBe(false);

    const run = runFrom(excerpt(diff));
    expect(run.redactions.map((r) => r.field)).toContain("why_trigger");
    expect(run.entry.why_trigger).not.toContain("--- a/");
    expect(run.entry.why_trigger).not.toContain("secret.ts");
    expect(run.entry.why_trigger).not.toContain("API_KEY");
  });

  it("catches a git diff header and a hunk header on their own", () => {
    for (const marker of [
      "diff --git a/src/app.ts b/src/app.ts",
      "@@ -12,7 +12,9 @@ function main() {"
    ]) {
      const result = validatePost({ type: "status", body: `look: ${flatten(marker)}` });
      expect(result, marker).toMatchObject({ ok: false, reason: "content_smuggling" });
    }
  });

  it("catches a long code fence whose newlines are gone", () => {
    const fence = "```ts\n" + "const x = 1;\n".repeat(30) + "```";

    expect(validatePost({ type: "status", body: fence }).ok).toBe(false);
    expect(validatePost({ type: "status", body: flatten(fence) }).ok).toBe(false);

    const run = runFrom(flatten(fence));
    expect(run.redactions.map((r) => r.field)).toContain("why_trigger");
    expect(run.entry.why_trigger).not.toContain("const x = 1;");
  });

  it("catches a paste that lost its closing fence to the length cap", () => {
    // The real path does both: it flattens the prompt AND cuts it to fit
    // `why_trigger`, so the closing marker is gone and a paired-fence rule
    // never sees a fence at all. This is the common shape, not the rare one:
    // a paste worth worrying about is longer than the 600-character cap.
    const paste = "here:\n```ts\n" + "const secret = 'hunter2';\n".repeat(60) + "```";
    const why = excerpt(paste);
    expect(why).toHaveLength(WHY_LIMIT);
    // One marker survives: the opener. The closer was cut off.
    expect(why.match(/```/g)).toHaveLength(1);

    const run = runFrom(why);
    expect(run.redactions.map((r) => r.field)).toContain("why_trigger");
    expect(run.entry.why_trigger).not.toContain("hunter2");
  });

  it("catches a flattened fence with no punctuation, on size alone", () => {
    const fence = "```\n" + "the quick brown fox jumps\n".repeat(24) + "```";
    const result = validatePost({ type: "status", body: flatten(fence) });
    expect(result).toMatchObject({ ok: false, reason: "content_smuggling" });
  });

  it("still accepts a short fence, flattened or not", () => {
    const body = "Is this right?\n```\n" + "line\n".repeat(5) + "```";
    expect(validatePost({ type: "question", body }).ok).toBe(true);
    expect(validatePost({ type: "question", body: flatten(body) }).ok).toBe(true);
  });

  it("does not read two stray @@ in prose as a hunk header", () => {
    // The loose `@@ ... @@` form would match this once the anchor is dropped.
    // A rejected post is a message the member never gets to send, so the
    // boundary looks for the exact hunk shape instead.
    const result = validatePost({
      type: "question",
      body: "is the @@ marker or the @@ sigil the one you meant?"
    });
    expect(result.ok).toBe(true);
  });

  it("does not read a stray fence marker in prose as a paste", () => {
    const result = validatePost({
      type: "question",
      body: "wrap it in ``` when you paste it into the room"
    });
    expect(result.ok).toBe(true);
  });

  it("never echoes the flattened payload in the summary", () => {
    const secret = "```\n" + "const TOKEN = 'hunter2';\n".repeat(30) + "```";
    const result = validatePost({ type: "status", body: flatten(secret) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.summary).not.toContain("hunter2");
      expect(result.summary).not.toContain("TOKEN");
    }
  });
});

// An opening fence marker with no close is measured only when the tail reads
// as code. Prose mentions a fence marker too, and measuring an ordinary
// message by its length rejected a handoff that held no code at all — a post
// the member then could not send (review of PR #100).
describe("boundary: an unterminated fence marker in prose (T080)", () => {
  const flatten = (text: string): string => text.replace(/\s+/g, " ").trim();

  it("accepts a long handoff that only mentions a fence marker", () => {
    const body =
      "End of day.\n" +
      Array.from({ length: 26 }, (_, i) => `Point ${i + 1} about the work today.`).join(
        "\n"
      ) +
      "\nWrap pastes in ``` next time.";
    expect(findSmuggledContent(body)).toBeNull();
    expect(findSmuggledContent(flatten(body))).toBeNull();
  });

  it("accepts a review message past the size backstop that mentions a fence", () => {
    const body =
      "Please wrap any paste in ``` before you send it. " +
      "The branch naming is the thing to settle first, because otherwise we ".repeat(6);
    expect(body.length).toBeGreaterThan(400);
    expect(findSmuggledContent(body)).toBeNull();
  });

  it("still catches a real paste behind an unterminated fence", () => {
    const body = "look:\n```ts\n" + "const y = 2;\n".repeat(30);
    expect(findSmuggledContent(body)).toContain("code fence");
  });
});
