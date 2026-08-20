// Durable local spool for run log entries (T055).
//
// FR-015 asks for a log entry for every run. The relay is not always there:
// it restarts, the laptop sleeps, the member works on a train. A run that
// ends in that window still has to reach the work log later.
//
// The spool holds the runs that no relay has accepted yet. It lives in
// .saw/log-spool.jsonl, next to state.json, and it survives a daemon
// restart. The daemon drains it after every reconnect. The entry keeps its
// own started_at and ended_at, so a replayed run reports when it ran, not
// when it was flushed.
//
// Nothing here may throw. The Stop hook must stay silent (Principle V), so
// every file operation is best effort and every failure only means "try
// again at the next reconnect".
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RunLogEntryInputSchema, type RunLogEntryInput } from "@saw/shared";
import { appendGitignore, logSpoolPath, logSpoolTempPath } from "../config.js";

/**
 * How many unsent runs the spool holds.
 *
 * One entry is small: tool counts, a branch name, a head SHA, a file count,
 * and a trigger of at most 1000 characters. 500 entries stay under about
 * 1 MB. 500 runs is also more agent runs than one member starts in several
 * days, so a normal outage never reaches the cap.
 *
 * At the cap the OLDEST entry goes. Two reasons. First, the newest runs are
 * the ones the peer asks about when the relay returns ("what did you do
 * while I was away"), so keeping them costs the least. Second, dropping the
 * newest would make the spool refuse work forever once it filled, and the
 * member would silently lose every run from then on. A ring buffer degrades;
 * a full bucket stops.
 */
export const SPOOL_CAPACITY = 500;

/** One run waiting for the relay. */
export interface SpooledRun {
  /** Local identity. It never leaves this machine. */
  id: string;
  entry: RunLogEntryInput;
}

/** Sends one entry to the relay. Resolves with the relay verdict. */
export type SpoolSend = (entry: RunLogEntryInput) => Promise<{ ok: boolean }>;

export interface SpoolDrainResult {
  /** Runs the relay accepted in this drain. */
  sent: number;
  /** Runs still waiting. */
  remaining: number;
  /** True when another drain was already running and this call did nothing. */
  busy: boolean;
}

export class LogSpool {
  private readonly root: string;
  private readonly path: string;
  private readonly tempPath: string;
  private readonly capacity: number;
  private entries: SpooledRun[] = [];
  private draining = false;
  private redrive = false;
  private prepared = false;
  private droppedCount = 0;

  constructor(root: string, capacity: number = SPOOL_CAPACITY) {
    this.root = root;
    this.path = logSpoolPath(root);
    this.tempPath = logSpoolTempPath(root);
    this.capacity = Math.max(1, capacity);
    this.entries = this.load();
  }

  /** Runs waiting for the relay. */
  get size(): number {
    return this.entries.length;
  }

  /** Runs the cap has dropped since this daemon started. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** The waiting runs, oldest first. A copy: callers cannot reorder the spool. */
  list(): SpooledRun[] {
    return [...this.entries];
  }

  /**
   * Keep one run the relay did not accept.
   * The caller passes the composed entry, so the timestamps are the run's own.
   */
  add(entry: RunLogEntryInput): void {
    this.entries.push({ id: randomUUID(), entry });
    if (this.entries.length > this.capacity) {
      this.droppedCount += this.entries.length - this.capacity;
      this.entries = this.entries.slice(-this.capacity);
      // The head moved, so the whole file has to be written again.
      this.persist();
      return;
    }
    const record = this.entries[this.entries.length - 1];
    if (record) this.append(record);
  }

  /**
   * Send every waiting run, oldest first.
   *
   * Order: the drain walks the head of the list and stops at the first
   * failure. It never skips ahead, so the relay sees the runs in the order
   * they happened.
   *
   * No double send: one drain runs at a time. A reconnect during a drain
   * only asks the running drain for one more pass.
   *
   * A run leaves the spool only after the relay confirms the append. A
   * daemon that dies between the append and the confirmation sends that one
   * run again on the next start. Delivery is at least once. FR-015 asks for
   * every run, so one duplicate is the right side of that trade: a lost run
   * cannot be recovered, a duplicate can be read past.
   */
  async drain(send: SpoolSend): Promise<SpoolDrainResult> {
    if (this.draining) {
      this.redrive = true;
      return { sent: 0, remaining: this.entries.length, busy: true };
    }
    this.draining = true;
    let sent = 0;
    try {
      do {
        this.redrive = false;
        let stalled = false;
        while (!stalled && this.entries.length > 0) {
          const head = this.entries[0];
          if (!head) break;
          let ok = false;
          try {
            ok = (await send(head.entry)).ok;
          } catch {
            ok = false;
          }
          if (!ok) {
            stalled = true;
            break;
          }
          this.remove(head.id);
          sent += 1;
        }
        // A reconnect that landed during this pass gets a pass of its own.
        // Without it, a drain that failed on the socket that was going away
        // would wait for the next reconnect, and there may not be one.
      } while (this.redrive);
    } finally {
      this.draining = false;
    }
    return { sent, remaining: this.entries.length, busy: false };
  }

  // ---- file ----

  private load(): SpooledRun[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: SpooledRun[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        // A half written last line after a crash. Drop it and keep the rest.
        continue;
      }
      const record = raw as { id?: unknown; entry?: unknown };
      const parsed = RunLogEntryInputSchema.safeParse(record.entry);
      // Only a valid entry may be replayed. A hand edited file must not make
      // the daemon send something the relay will refuse on every reconnect.
      if (!parsed.success) continue;
      out.push({
        id: typeof record.id === "string" ? record.id : randomUUID(),
        entry: parsed.data
      });
    }
    // The file can hold more than the cap when the cap changes between runs.
    return out.slice(-this.capacity);
  }

  /** Drop one confirmed run and write the file again. */
  private remove(id: string): void {
    const index = this.entries.findIndex((r) => r.id === id);
    // Already gone: the cap dropped it while the send was in flight.
    if (index < 0) return;
    this.entries.splice(index, 1);
    this.persist();
  }

  private prepare(): void {
    if (this.prepared) return;
    this.prepared = true;
    mkdirSync(dirname(this.path), { recursive: true });
    // A workspace created before the spool existed wrote its .gitignore
    // without this line. Add it the first time a spool file appears, so an
    // older clone does not commit the file. The call adds only what is
    // missing and is safe to repeat.
    appendGitignore(this.root);
  }

  private append(record: SpooledRun): void {
    try {
      this.prepare();
      appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
    } catch {
      // The run stays in memory. The next write or drain tries again.
    }
  }

  /** Write the whole file. Temp file plus rename, so no reader sees a torn file. */
  private persist(): void {
    try {
      this.prepare();
      if (this.entries.length === 0) {
        rmSync(this.path, { force: true });
        return;
      }
      const text = this.entries.map((r) => JSON.stringify(r)).join("\n") + "\n";
      writeFileSync(this.tempPath, text, "utf8");
      renameSync(this.tempPath, this.path);
    } catch {
      // Best effort. The runs stay in memory for this daemon's lifetime.
    }
  }
}
