// The companion (spec 002 US9, T153 — FR-053).
// A thread-scoped responder each member has: it answers questions about the
// thread when the member's coding agent does not, and it observes without
// interfering. It sits outside the mode ladder. It reads only what SAW
// already stores — the thread, the work log, the bound refs — and it posts
// as its own identity, attributed to the member. It never authors code,
// never claims, never binds, never uses binding force.
//
// It rides the member's own tooling through the wake adapter (Principle V:
// no SAW-side model runtime — the documented finding T153 asked for is
// therefore not needed, and this comment records why). The spawned run
// carries SAW_COMPANION=1; the MCP layer reads that and posts with the
// companion sender kind, so the identity is structural, not a prompt hope.
import type { StoredMessage } from "@saw/shared";
import type { WakeAdapter } from "./wake.js";

export interface CompanionQuestion {
  threadId: string;
  threadTitle: string;
  asker: string;
  question: string;
  seq: number;
}

/** The companion's instructions. Plain speech, restrictions stated. */
export function companionPrompt(member: string, q: CompanionQuestion): string {
  return (
    `You are ${member}'s SAW companion for the thread "${q.threadTitle}". ` +
    `${q.asker} asked: ${q.question} ` +
    `Answer from the stored record only: room_read (thread_id ${q.threadId}), ` +
    `work_log, workspace_status, and peer_activity. Post ONE plain answer ` +
    `into the thread with room_post (thread_id ${q.threadId}), leading with ` +
    `the point. You must not edit files, run code, claim work, hand off, ` +
    `bind refs, or use binding force - you answer, nothing else. If the ` +
    `record cannot answer, say so plainly and name who can.`
  );
}

/**
 * Decide and schedule companion answers. The trigger is narrow on purpose:
 * a QUESTION, in a thread, addressed to this member, from someone else.
 * The companion waits a grace period; if the member's own agent (or the
 * member) answers in the thread first, the companion stays silent. The
 * grace is what keeps it an understudy rather than a chatterbox.
 */
export class Companion {
  private member: string;
  private graceMs: number;
  private timers = new Map<number, NodeJS.Timeout>();

  constructor(member: string, graceMs = 90_000) {
    this.member = member;
    this.graceMs = graceMs;
  }

  /** Watch one arriving message. Returns the question it scheduled, if any. */
  observe(
    message: StoredMessage,
    threadTitle: string | undefined,
    answerLater: (q: CompanionQuestion) => void
  ): CompanionQuestion | undefined {
    // The member's own words or their agent's answer in ANY form cancels
    // every pending companion answer for that thread: someone real spoke.
    if (message.sender === this.member && message.thread_id) {
      for (const [seq, timer] of this.timers) {
        clearTimeout(timer);
        this.timers.delete(seq);
      }
      return undefined;
    }
    if (
      message.type !== "question" ||
      message.target !== this.member ||
      !message.thread_id ||
      message.sender === this.member ||
      message.sender_kind === "companion"
    ) {
      return undefined;
    }
    const q: CompanionQuestion = {
      threadId: message.thread_id,
      threadTitle: threadTitle ?? message.thread_id,
      asker: message.sender,
      question: message.body,
      seq: message.seq
    };
    const timer = setTimeout(() => {
      this.timers.delete(q.seq);
      answerLater(q);
    }, this.graceMs);
    this.timers.set(q.seq, timer);
    return q;
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

/** Run one companion answer through the member's own tool. */
export async function runCompanion(
  adapter: WakeAdapter,
  member: string,
  q: CompanionQuestion,
  root: string
): Promise<{ ok: boolean; message?: string }> {
  if (!adapter.supportsWake()) {
    return { ok: false, message: "the coding tool cannot be started headlessly here" };
  }
  return adapter.startRun(
    {
      threadId: q.threadId,
      threadTitle: q.threadTitle,
      reason: "own_message",
      sessionId: null,
      companionPrompt: companionPrompt(member, q)
    },
    root
  );
}
