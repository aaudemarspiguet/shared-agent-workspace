// Run context (T040).
// Records why a run started and when. The Stop hook adds the mechanical
// "what". Together they form one complete RunLogEntry with no agent help.
import type { RunLogEntryInput, RunWhat, StoredMessage } from "@saw/shared";

const WHY_LIMIT = 600;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > WHY_LIMIT ? flat.slice(0, WHY_LIMIT - 1) + "…" : flat;
}

export class RunContext {
  private me: string;
  private startedAt: string | undefined;
  private whyTrigger: string | undefined;

  constructor(me: string) {
    this.me = me;
  }

  /**
   * Record the trigger candidate at an injection point.
   * A human redirect aimed at this member wins over the raw prompt.
   */
  recordInjection(source: "session-start" | "prompt-submit", options: {
    prompt?: string;
    injected: StoredMessage[];
  }): void {
    if (!this.startedAt) this.startedAt = new Date().toISOString();
    const redirect = [...options.injected]
      .reverse()
      .find((m) => m.sender_kind === "human" && m.target === this.me);
    if (redirect) {
      this.whyTrigger = `Redirect from ${redirect.sender}: ${excerpt(redirect.body)}`;
      return;
    }
    if (options.prompt && options.prompt.trim().length > 0) {
      this.whyTrigger = excerpt(options.prompt);
      return;
    }
    if (!this.whyTrigger && source === "session-start") {
      this.whyTrigger = "session start";
    }
  }

  /** Compose the full entry at run end, then reset for the next run. */
  compose(what: RunWhat, activeWorkItem: string | undefined): RunLogEntryInput {
    const endedAt = new Date().toISOString();
    const entry: RunLogEntryInput = {
      started_at: this.startedAt ?? endedAt,
      ended_at: endedAt,
      what,
      why_trigger: this.whyTrigger ?? "run with no recorded trigger",
      work_item: activeWorkItem
    };
    this.startedAt = undefined;
    this.whyTrigger = undefined;
    return entry;
  }
}
