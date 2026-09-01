// The wake adapter (spec 002 US9, T151/T152 — FR-054).
// A wake is the daemon telling the member's coding tool: start one run
// with this thread's context. The contract is one small interface so any
// tool can implement it; Claude Code is the first. A tool with no wake
// support still gets the full companion (FR-054) — the conversation floor
// never depends on this file.
import { execFileSync, spawn } from "node:child_process";
import { launchFor } from "../launch.js";

/** What a wake run is asked to do. The prompt is plain speech (FR-048). */
export interface WakeRun {
  threadId: string;
  threadTitle: string;
  reason: "own_message" | "session_turn";
  sessionId: string | null;
}

/** The tool-agnostic contract (FR-054). One method, declared support. */
export interface WakeAdapter {
  /** The tool this adapter drives, for logs and setup lines. */
  name: string;
  /** Whether the tool can be started headlessly on this machine. */
  supportsWake(): boolean;
  /**
   * Start ONE run in the member's coding tool with the wake context.
   * Resolves when the run has been handed to the tool, not when it ends;
   * the returned promise settles the run's exit for the caller's cap.
   */
  startRun(run: WakeRun, root: string): Promise<{ ok: boolean; message?: string }>;
}

/** The prompt a woken run starts from. Short: injection carries the rest. */
export function wakePrompt(run: WakeRun): string {
  const why =
    run.reason === "own_message"
      ? "your member posted in the SAW thread"
      : "the other member's agent took a turn in your live session";
  return (
    `SAW woke you: ${why} "${run.threadTitle}". ` +
    `Read the thread (room_read with thread_id ${run.threadId}), then do what ` +
    `your member would want and post your reply into the thread. Keep the ` +
    `post plain and lead with the point. If the session's task is finished, ` +
    `propose done instead of continuing.`
  );
}

/**
 * Claude Code, headlessly: `claude -p "<prompt>"` in the workspace root.
 * The run gets its SAW context the ordinary way — the SessionStart hook
 * injects the thread's unread messages — so the prompt stays short. The
 * run's Stop hook logs it like any other run. Nothing here bypasses pause:
 * the caller checks the mirror first, and the gate denies tools besides.
 */
export class ClaudeWakeAdapter implements WakeAdapter {
  name = "claude-code";

  supportsWake(): boolean {
    try {
      execFileSync(process.platform === "win32" ? "where" : "which", ["claude"], {
        stdio: ["ignore", "ignore", "ignore"]
      });
      return true;
    } catch {
      return false;
    }
  }

  startRun(run: WakeRun, root: string): Promise<{ ok: boolean; message?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean, message?: string): void => {
        if (!settled) {
          settled = true;
          resolve({ ok, message });
        }
      };
      try {
        const child = spawn("claude", ["-p", wakePrompt(run)], {
          cwd: root,
          stdio: ["ignore", "ignore", "ignore"],
          detached: false
        });
        child.on("error", (err) => done(false, err.message));
        child.on("exit", (code) => done(code === 0, code === 0 ? undefined : `exit ${code}`));
      } catch (error) {
        done(false, error instanceof Error ? error.message : String(error));
      }
    });
  }
}
