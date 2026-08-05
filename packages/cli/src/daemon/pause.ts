// Pause mirror (T034).
// The relay owns pause state. The daemon mirrors it for fast local checks.
// On resume the daemon asks the relay to replay what was held back. The
// replay arrives in seq order, so queued messages deliver in order.
import type { PauseStateFrame } from "@saw/shared";

export class PauseMirror {
  private me: string;
  private paused = new Map<string, boolean>();
  /** Called when this member resumes. The daemon syncs from the relay. */
  onOwnResume?: () => void;

  constructor(me: string) {
    this.me = me;
  }

  get ownPaused(): boolean {
    return this.paused.get(this.me) ?? false;
  }

  isPaused(member: string): boolean {
    return this.paused.get(member) ?? false;
  }

  /** Seed own state from hello_ok. */
  seedOwn(paused: boolean): void {
    this.paused.set(this.me, paused);
  }

  apply(frame: PauseStateFrame): void {
    const before = this.paused.get(frame.member) ?? false;
    this.paused.set(frame.member, frame.paused);
    if (frame.member === this.me && before && !frame.paused) {
      this.onOwnResume?.();
    }
  }
}
