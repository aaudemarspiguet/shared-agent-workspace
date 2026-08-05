// ReadCursor (T028).
// Tracks the highest message seq already injected into the agent context.
// The cursor survives daemon restarts through .saw/state.json.
import { readState, writeState } from "../config.js";
import type { StoredMessage } from "@saw/shared";

export class ReadCursor {
  private root: string;
  private lastInjectedSeq: number;

  constructor(root: string) {
    this.root = root;
    this.lastInjectedSeq = readState(root).last_injected_seq;
  }

  get value(): number {
    return this.lastInjectedSeq;
  }

  /** Messages after the cursor, in seq order. */
  unread(messages: StoredMessage[]): StoredMessage[] {
    return messages.filter((m) => m.seq > this.lastInjectedSeq);
  }

  /** Advance the cursor after an injection. Persist at once. */
  advance(toSeq: number): void {
    if (toSeq <= this.lastInjectedSeq) return;
    this.lastInjectedSeq = toSeq;
    writeState(this.root, { last_injected_seq: toSeq });
  }
}
