// PreToolUse hook (T035).
// While the member is paused, deny every tool call with an STE reason.
// Otherwise stay silent. When the daemon is down, stay silent too.
import { daemonRequest, emit, readStdin } from "./io.js";

export async function runPreToolHook(): Promise<void> {
  await readStdin(1200);
  const health = (await daemonRequest("/api/pause", undefined, 1200)) as
    | { paused: boolean }
    | undefined;
  if (!health || !health.paused) return;
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "SAW: your workspace member state is paused. Resume from the SAW web page."
    }
  });
}
