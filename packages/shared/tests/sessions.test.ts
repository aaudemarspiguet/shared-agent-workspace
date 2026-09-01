// T148: the session vocabulary and the wake rule (spec 002 US9).
import { describe, expect, it } from "vitest";
import {
  ClientFrameSchema,
  DEFAULT_MAX_TURNS,
  validateConvergePropose,
  validateSessionReady,
  wakeEligible,
  type WakeQuestion
} from "../src/index.js";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function q(over: Partial<WakeQuestion>): WakeQuestion {
  return {
    sender: "alice",
    sender_kind: "human",
    recipient: "alice",
    recipient_auto_on: false,
    recipient_paused: false,
    session: null,
    ...over
  };
}

describe("the wake rule (FR-049, FR-050)", () => {
  it("a member's own human message wakes their own agent, any surface", () => {
    expect(wakeEligible(q({}))).toEqual({ wake: true, reason: "own_message" });
  });

  it("the other member's human message wakes nobody", () => {
    expect(wakeEligible(q({ sender: "bob", recipient: "alice" }))).toEqual({ wake: false });
  });

  it("an agent's message wakes nobody outside a live session", () => {
    expect(
      wakeEligible(q({ sender: "bob", sender_kind: "agent", recipient: "alice" }))
    ).toEqual({ wake: false });
    expect(
      wakeEligible(
        q({
          sender: "bob",
          sender_kind: "agent",
          recipient: "alice",
          recipient_auto_on: true,
          session: { state: "forming", live_participants: ["alice", "bob"] }
        })
      )
    ).toEqual({ wake: false });
  });

  it("inside a live session, a participating agent wakes the other participant", () => {
    expect(
      wakeEligible(
        q({
          sender: "bob",
          sender_kind: "agent",
          recipient: "alice",
          recipient_auto_on: true,
          session: { state: "live", live_participants: ["alice", "bob"] }
        })
      )
    ).toEqual({ wake: true, reason: "session_turn" });
  });

  it("a session wake needs the recipient's own auto mode and participation", () => {
    const base = {
      sender: "bob",
      sender_kind: "agent" as const,
      recipient: "alice",
      session: { state: "live" as const, live_participants: ["alice", "bob"] }
    };
    expect(wakeEligible(q({ ...base, recipient_auto_on: false }))).toEqual({ wake: false });
    expect(
      wakeEligible(
        q({
          ...base,
          recipient_auto_on: true,
          session: { state: "live", live_participants: ["bob"] }
        })
      )
    ).toEqual({ wake: false });
  });

  it("an agent never wakes itself, and a member's own agent message wakes nobody", () => {
    expect(
      wakeEligible(
        q({
          sender: "alice",
          sender_kind: "agent",
          recipient: "alice",
          recipient_auto_on: true,
          session: { state: "live", live_participants: ["alice", "bob"] }
        })
      )
    ).toEqual({ wake: false });
  });

  it("suspended, converged, concluded, and ended sessions wake nobody", () => {
    for (const state of ["suspended", "converged", "concluded", "ended"] as const) {
      expect(
        wakeEligible(
          q({
            sender: "bob",
            sender_kind: "agent",
            recipient: "alice",
            recipient_auto_on: true,
            session: { state, live_participants: ["alice", "bob"] }
          })
        )
      ).toEqual({ wake: false });
    }
  });
});

describe("pause wins over every wake (FR-051)", () => {
  it("a paused member's agent never wakes, their own typing included", () => {
    expect(wakeEligible(q({ recipient_paused: true }))).toEqual({ wake: false });
    expect(
      wakeEligible(
        q({
          sender: "bob",
          sender_kind: "agent",
          recipient: "alice",
          recipient_auto_on: true,
          recipient_paused: true,
          session: { state: "live", live_participants: ["alice", "bob"] }
        })
      )
    ).toEqual({ wake: false });
  });
});

describe("session payloads and boundary (T148, FR-025)", () => {
  it("accepts a fair readiness and defaults exist", () => {
    const v = validateSessionReady({ thread_id: ULID, task: "wire the auth flow" });
    expect(v.ok).toBe(true);
    expect(DEFAULT_MAX_TURNS).toBe(50);
  });

  it("rejects smuggled code in the task and the summary", () => {
    const flat = "```" + Array.from({ length: 25 }, (_, i) => `x${i}=${i};`).join(" ");
    expect(validateSessionReady({ thread_id: ULID, task: flat })).toMatchObject({
      ok: false,
      reason: "content_smuggling"
    });
    expect(
      validateConvergePropose({ session_id: ULID, summary: flat })
    ).toMatchObject({ ok: false, reason: "content_smuggling" });
  });

  it("rejects a bad proposal ref with its true reason", () => {
    const v = validateConvergePropose({
      session_id: ULID,
      summary: "done, both halves reviewed",
      refs: [{ kind: "commit", value: "zzz" }]
    });
    expect(v).toMatchObject({ ok: false, reason: "invalid_ref" });
  });

  it("over-long text reports its true reason (review finding 2)", () => {
    expect(validateSessionReady({ thread_id: ULID, task: "x".repeat(601) })).toMatchObject({
      ok: false,
      reason: "payload_too_large"
    });
    expect(
      validateConvergePropose({ session_id: ULID, summary: "x".repeat(2001) })
    ).toMatchObject({ ok: false, reason: "payload_too_large" });
  });

  it("bounds the turn budget", () => {
    expect(validateSessionReady({ thread_id: ULID, max_turns: 0 }).ok).toBe(false);
    expect(validateSessionReady({ thread_id: ULID, max_turns: 501 }).ok).toBe(false);
    expect(validateSessionReady({ thread_id: ULID, max_turns: 50 }).ok).toBe(true);
  });

  it("the new client frames parse, and writes stay self-directed", () => {
    expect(ClientFrameSchema.parse({ kind: "auto_mode_set", set: {} }).kind).toBe("auto_mode_set");
    expect(ClientFrameSchema.parse({ kind: "session_ready", ready: {} }).kind).toBe(
      "session_ready"
    );
    expect(ClientFrameSchema.parse({ kind: "session_end", session_id: ULID }).kind).toBe(
      "session_end"
    );
    expect(ClientFrameSchema.parse({ kind: "converge_approve", session_id: ULID }).kind).toBe(
      "converge_approve"
    );
    expect(ClientFrameSchema.parse({ kind: "claim_approve", thread_id: ULID }).kind).toBe(
      "claim_approve"
    );
  });
});
