// SessionStart and UserPromptSubmit hooks (T029).
// They inject unread room messages and claim/pause state as
// additionalContext, and they advance the read cursor through the daemon.
// When the daemon is down they print nothing and exit 0.
import type { StoredMessage } from "@saw/shared";
import type { ClaimNotice, WorkItemView } from "../daemon/state.js";
import { daemonRequest, emit, parseHookInput, readStdin } from "./io.js";

interface InjectResponse {
  messages: StoredMessage[];
  notices: ClaimNotice[];
  paused: boolean;
  work_items: WorkItemView[];
  me: string;
}

function renderMessage(m: StoredMessage): string {
  const target = m.target ? ` → ${m.target}` : "";
  const refs =
    m.refs.length > 0 ? ` [refs: ${m.refs.map((r) => `${r.kind}:${r.value}`).join(", ")}]` : "";
  const item = m.work_item ? ` (work_item: ${m.work_item})` : "";
  return `- #${m.seq} ${m.sender} (${m.sender_kind}) ${m.type}${target}: ${m.body}${refs}${item}`;
}

function renderContext(
  event: "session-start" | "prompt-submit",
  data: InjectResponse
): string {
  const lines: string[] = [];
  if (event === "session-start") {
    lines.push(
      "SAW shared workspace is active. Read .saw/AGENT.md for the room rules.",
      `You are the agent for member "${data.me}".`
    );
  }
  if (data.paused) {
    lines.push(
      "Your member state is PAUSED. Tool calls are blocked until your human resumes you."
    );
  }
  const claimed = data.work_items.filter((w) => w.state !== "done");
  if (event === "session-start" && claimed.length > 0) {
    lines.push(
      "Work items: " +
        claimed
          .map((w) => `${w.feature_tag}=${w.state}${w.claimed_by ? ` by ${w.claimed_by}` : ""}`)
          .join(", ")
    );
  }
  for (const notice of data.notices) {
    lines.push(
      notice.granted
        ? `Claim update: "${notice.work_item}" is now held by ${notice.claimed_by}.`
        : `Claim rejected: "${notice.work_item}" is already held by ${notice.claimed_by}. Pick other work or coordinate in the room.`
    );
  }
  if (data.messages.length > 0) {
    lines.push(
      event === "session-start"
        ? `Unread room messages (${data.messages.length}):`
        : `New room messages since your last turn (${data.messages.length}):`
    );
    for (const message of data.messages) lines.push(renderMessage(message));
  }
  return lines.join("\n");
}

export async function runInjectHook(event: "session-start" | "prompt-submit"): Promise<void> {
  const input = parseHookInput(await readStdin());
  const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
  const data = (await daemonRequest("/api/inject", {
    method: "POST",
    body: { source: event, prompt }
  })) as InjectResponse | undefined;
  if (!data) return;

  const isSessionStart = event === "session-start";
  const hasNews = data.messages.length > 0 || data.notices.length > 0 || data.paused;
  if (!isSessionStart && !hasNews) return;

  const context = renderContext(event, data);
  if (!context) return;
  emit({
    hookSpecificOutput: {
      hookEventName: isSessionStart ? "SessionStart" : "UserPromptSubmit",
      additionalContext: context
    }
  });
}
