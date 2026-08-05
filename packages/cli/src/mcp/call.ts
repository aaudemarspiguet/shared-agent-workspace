// Shared plumbing for the MCP tools.
// Every tool talks only to the member's own daemon over localhost HTTP.
// Error shape (contracts/mcp-tools.md):
//   { "error": { "code": "paused|not_connected|invalid_input|rejected", "message": "..." } }
import { readDaemonInfo, resolveRepoRoot } from "../config.js";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(code: string, message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
    isError: true
  };
}

export const NOT_RUNNING = "the SAW daemon is not running. Start it with: saw up";

export const NO_TOKEN =
  "the SAW daemon file .saw/daemon.json holds no run token, so an older " +
  "version of saw wrote it. Stop saw up and start it again with the current saw.";

/**
 * Call the daemon. Throw a coded error string on failure.
 *
 * Every call presents the run token of the daemon (T057). The daemon refuses
 * a call without it, because the same interface is open to any page in the
 * member's browser. The policy is fail closed: a daemon file with no token
 * gives an error that says what to do, not an unauthenticated call.
 */
export async function daemonCall(
  root: string,
  path: string,
  init?: { method?: string; body?: unknown },
  timeoutMs = 5000
): Promise<{ status: number; json: unknown } | undefined> {
  const info = readDaemonInfo(root);
  if (!info) return undefined;
  if (!info.token) {
    return { status: 401, json: { error: { code: "not_connected", message: NO_TOKEN } } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${info.token}` };
    if (init?.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal
    });
    return { status: res.status, json: (await res.json()) as unknown };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function repoRoot(): string | undefined {
  return resolveRepoRoot(process.cwd());
}

/**
 * Gate for agent tools other than workspace_status.
 * While the member is paused, every one of them answers "paused".
 */
export async function agentGate(root: string): Promise<ToolResult | undefined> {
  const health = await daemonCall(root, "/api/health", undefined, 2000);
  if (!health) return errorResult("not_connected", NOT_RUNNING);
  // A refused call means the daemon cannot be used from here. Report the
  // daemon's own reason, so the member reads what to do.
  if (health.status !== 200) return mapDaemonError(health.status, health.json);
  const body = health.json as { paused?: boolean };
  if (body.paused) {
    return errorResult(
      "paused",
      "your workspace member state is paused. Your human resumes you from the SAW web page."
    );
  }
  return undefined;
}

/** Statuses the daemon uses when it refuses a local caller (T057). */
const REFUSED = new Set([401, 403, 415]);

/**
 * Map a daemon error response to the contract error shape.
 *
 * A refusal keeps the daemon's message, because that message tells the member
 * what to do. The code becomes `not_connected`: the tool contract has a closed
 * set of codes, and from the agent's side a daemon it may not call is a daemon
 * it cannot reach.
 */
export function mapDaemonError(status: number, json: unknown): ToolResult {
  const err = (json as { error?: { code?: string; message?: string } }).error;
  const fallback = `daemon answered with status ${status}`;
  if (REFUSED.has(status)) return errorResult("not_connected", err?.message ?? fallback);
  const code = err?.code ?? (status === 503 ? "not_connected" : "invalid_input");
  return errorResult(code, err?.message ?? fallback);
}
