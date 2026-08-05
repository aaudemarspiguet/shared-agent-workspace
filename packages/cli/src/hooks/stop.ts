// Stop hook (T039).
// Post the automatic run summary. Zero agent cooperation. Always exit 0.
// A logging failure goes nowhere near the agent: the hook stays silent.
//
// The hook discards the daemon answer on purpose, and it never retries. The
// daemon owns durability: a run the relay refuses goes to the local spool
// and reaches the work log at the next reconnect (T055). A retry here would
// log the run twice.
import { daemonRequest, parseHookInput, readStdin } from "./io.js";
import { composeRunWhat } from "./summary.js";

export async function runStopHook(): Promise<void> {
  const input = parseHookInput(await readStdin());
  const transcriptPath =
    typeof input.transcript_path === "string" ? input.transcript_path : undefined;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const what = composeRunWhat(transcriptPath, cwd);
  await daemonRequest(
    "/api/run/stop",
    { method: "POST", body: { what } },
    2500,
    cwd
  );
}
