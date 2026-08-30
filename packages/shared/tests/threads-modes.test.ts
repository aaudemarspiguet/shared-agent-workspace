// T094: thread and handoff schema tests. T095: the boundary rejects code,
// diffs, and encoded payloads in every new field (FR-025, SC-016 groundwork).
import { describe, expect, it } from "vitest";
import {
  ACTION_MODES,
  canTransitionHandoff,
  ClientFrameSchema,
  DEFAULT_FORCE,
  DEFAULT_MODE,
  HANDOFF_STATES,
  isPendingAssignment,
  isValidThreadId,
  MIGRATED_THREAD_MODE,
  modeAllows,
  modeAtLeast,
  MODES,
  needsUpgradeMessage,
  PENDING_WORK_ITEM,
  PROTOCOL_VERSION,
  ThreadModeSetSchema,
  validateHandoffPropose,
  validateLogEntry,
  validatePost,
  validateThreadOpen
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/**
 * A paste that must never cross, small enough to fit under the title cap:
 * an unterminated fence whose tail reads as ~23 statements.
 */
const FLAT_CODE = "```" + Array.from({ length: 22 }, (_, i) => `x${i}=${i};`).join(" ");

describe("thread schemas (T094)", () => {
  it("accepts a fair thread open", () => {
    const v = validateThreadOpen({ type: "work_item", title: "auth refactor", workspace_id: "w1" });
    expect(v.ok).toBe(true);
  });

  it("rejects an unknown type and a missing title", () => {
    expect(validateThreadOpen({ type: "epic", title: "x", workspace_id: "w1" }).ok).toBe(false);
    expect(validateThreadOpen({ type: "general", workspace_id: "w1" }).ok).toBe(false);
  });

  it("rejects an over-long title with its true reason", () => {
    const v = validateThreadOpen({ type: "general", title: "x".repeat(201), workspace_id: "w1" });
    expect(v).toMatchObject({ ok: false, reason: "payload_too_large" });
  });

  it("only a ULID is a thread id", () => {
    expect(isValidThreadId(ULID)).toBe(true);
    expect(isValidThreadId("not-a-ulid")).toBe(false);
    expect(isValidThreadId("../../etc/passwd")).toBe(false);
  });
});

describe("handoff lifecycle (T094)", () => {
  it("proposed is the only live state", () => {
    expect(canTransitionHandoff("proposed", "accepted", "to_member")).toBe(true);
    expect(canTransitionHandoff("proposed", "declined", "to_member")).toBe(true);
    expect(canTransitionHandoff("proposed", "withdrawn", "from_member")).toBe(true);
    expect(canTransitionHandoff("proposed", "withdrawn", "system")).toBe(true);
    for (const terminal of ["accepted", "declined", "withdrawn"] as const) {
      for (const to of HANDOFF_STATES) {
        for (const actor of ["from_member", "to_member", "system"] as const) {
          expect(canTransitionHandoff(terminal, to, actor)).toBe(false);
        }
      }
    }
  });

  it("only the recipient accepts; only the sender withdraws", () => {
    expect(canTransitionHandoff("proposed", "accepted", "from_member")).toBe(false);
    expect(canTransitionHandoff("proposed", "withdrawn", "to_member")).toBe(false);
  });

  it("accepts a fair proposal and rejects a bad tip ref", () => {
    const good = validateHandoffPropose({
      thread_id: ULID,
      to: "aaudemarspiguet",
      tip_ref: { kind: "branch", value: "shreyk2/auth" }
    });
    expect(good.ok).toBe(true);
    const bad = validateHandoffPropose({
      thread_id: ULID,
      to: "aaudemarspiguet",
      tip_ref: { kind: "commit", value: "zzz" }
    });
    expect(bad).toMatchObject({ ok: false, reason: "invalid_ref" });
  });
});

describe("mode ladder (T094)", () => {
  it("orders view < comment < edit", () => {
    expect(MODES).toEqual(["view", "comment", "edit"]);
    expect(modeAtLeast("edit", "comment")).toBe(true);
    expect(modeAtLeast("view", "comment")).toBe(false);
    expect(modeAtLeast("comment", "comment")).toBe(true);
  });

  it("gates actions per the contract", () => {
    expect(modeAllows("view", "read")).toBe(true);
    expect(modeAllows("view", "post")).toBe(false);
    expect(modeAllows("comment", "post")).toBe(true);
    expect(modeAllows("comment", "claim")).toBe(false);
    expect(modeAllows("edit", "claim")).toBe(true);
    expect(modeAllows("edit", "accept_handoff")).toBe(true);
    expect(ACTION_MODES.bind_ref).toBe("edit");
  });

  it("keeps the founder defaults", () => {
    expect(DEFAULT_MODE).toBe("comment");
    expect(MIGRATED_THREAD_MODE).toBe("edit");
  });

  it("a mode write carries no field for another member (SC-016)", () => {
    // The authorization is structural: even when a caller smuggles a
    // member field in, the parsed result does not carry it.
    const parsed = ThreadModeSetSchema.parse({
      thread_id: ULID,
      mode: "edit",
      member: "aaudemarspiguet",
      member_id: "aaudemarspiguet"
    });
    expect(parsed).toEqual({ thread_id: ULID, mode: "edit" });
  });
});

describe("boundary on the new fields (T095)", () => {
  it("rejects smuggled code in a thread title", () => {
    const v = validateThreadOpen({ type: "general", title: FLAT_CODE, workspace_id: "w1" });
    expect(v).toMatchObject({ ok: false, reason: "content_smuggling" });
  });

  it("rejects diff markers in a thread title", () => {
    const v = validateThreadOpen({
      type: "general",
      title: "see --- a/src/x.ts +++ b/src/x.ts",
      workspace_id: "w1"
    });
    expect(v).toMatchObject({ ok: false, reason: "content_smuggling" });
  });

  it("rejects smuggled content in a handoff recipient", () => {
    const v = validateHandoffPropose({
      thread_id: ULID,
      to: "x --- a/ +++ b/",
      tip_ref: { kind: "branch", value: "b" }
    });
    expect(v).toMatchObject({ ok: false, reason: "content_smuggling" });
  });

  it("a post accepts thread_id and force, and rejects wrong values plainly", () => {
    const good = validatePost({ type: "status", body: "hi", thread_id: ULID, force: "binding" });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.post.thread_id).toBe(ULID);
      expect(good.post.force).toBe("binding");
    }
    const defaulted = validatePost({ type: "status", body: "hi" });
    expect(defaulted.ok && defaulted.post.force).toBe(DEFAULT_FORCE);
    const broadcast = validatePost({ type: "status", body: "hi", thread_id: null });
    expect(broadcast.ok).toBe(true);
    expect(validatePost({ type: "status", body: "hi", thread_id: "```code```" })).toMatchObject({
      ok: false,
      summary: "thread id is not valid"
    });
    expect(validatePost({ type: "status", body: "hi", force: "imperative" })).toMatchObject({
      ok: false,
      summary: "force is not valid"
    });
  });

  it("a base64 payload big enough to matter cannot fit a title at all", () => {
    // The smuggling rule needs a 512-char run; the title cap is 200. The
    // length cap therefore fires first, and that is the boundary holding:
    // there is no title long enough to carry an encoded payload.
    const blob = "QQ==".repeat(200);
    const v = validateThreadOpen({ type: "general", title: blob, workspace_id: "w1" });
    expect(v).toMatchObject({ ok: false, reason: "payload_too_large" });
  });

  it("a log entry drops a bad thread id and keeps the run (FR-015)", () => {
    const v = validateLogEntry({
      started_at: "2026-08-30T00:00:00.000Z",
      ended_at: "2026-08-30T00:01:00.000Z",
      what: { tools_used: {} },
      why_trigger: "asked a question",
      thread_id: "not-a-ulid"
    });
    expect(v.entry.thread_id).toBeUndefined();
    expect(v.redactions).toContainEqual(
      expect.objectContaining({ field: "thread_id", reason: "not_json" })
    );
    const ok = validateLogEntry({
      started_at: "2026-08-30T00:00:00.000Z",
      ended_at: "2026-08-30T00:01:00.000Z",
      what: { tools_used: {} },
      why_trigger: "worked the thread",
      thread_id: ULID
    });
    expect(ok.entry.thread_id).toBe(ULID);
    expect(ok.redactions).toEqual([]);
  });

  it("names the pending-assignment state (constitution 2.1.0)", () => {
    expect(PENDING_WORK_ITEM).toBe("unassigned");
    expect(isPendingAssignment({ work_item: "unassigned", thread_id: null })).toBe(true);
    expect(isPendingAssignment({ work_item: "unassigned", thread_id: ULID })).toBe(false);
    expect(isPendingAssignment({ work_item: "auth", thread_id: null })).toBe(false);
  });
});

describe("protocol version (T093)", () => {
  it("a version-less hello parses as v0", () => {
    const v = ClientFrameSchema.parse({ kind: "hello", workspace_id: "w", token: "t" });
    expect(v.kind === "hello" && v.protocol).toBeUndefined();
  });

  it("a versioned hello parses and the version is current", () => {
    const v = ClientFrameSchema.parse({
      kind: "hello",
      workspace_id: "w",
      token: "t",
      protocol: PROTOCOL_VERSION
    });
    expect(v.kind === "hello" && v.protocol).toBe(1);
  });

  it("both upgrade instructions are plain and name the actor", () => {
    expect(needsUpgradeMessage("client")).toContain("Update saw");
    expect(needsUpgradeMessage("relay")).toContain("relay host must update");
  });

  it("the new client frames parse and reject a foreign member field shape", () => {
    expect(ClientFrameSchema.parse({ kind: "thread_open", open: {} }).kind).toBe("thread_open");
    expect(ClientFrameSchema.parse({ kind: "thread_mode_set", set: {} }).kind).toBe("thread_mode_set");
    expect(
      ClientFrameSchema.parse({ kind: "handoff_resolve", handoff_id: ULID, to_state: "accepted" }).kind
    ).toBe("handoff_resolve");
    expect(() =>
      ClientFrameSchema.parse({ kind: "handoff_resolve", handoff_id: ULID, to_state: "proposed" })
    ).toThrow();
  });
});
