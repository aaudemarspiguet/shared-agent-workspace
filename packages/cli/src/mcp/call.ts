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

/** Call the daemon. Throw a coded error string on failure. */
export async function daemonCall(
  root: string,
  path: string,
  init?: { method?: string; body?: unknown },
  timeoutMs = 5000
): Promise<{ status: number; json: unknown } | undefined> {
  const info = readDaemonInfo(root);
  if (!info) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "content-type": "application/json" } : {},
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
  const body = health.json as { paused?: boolean };
  if (body.paused) {
    return errorResult(
      "paused",
      "your workspace member state is paused. Your human resumes you from the SAW web page."
    );
  }
  return undefined;
}

/** Map a daemon error response to the contract error shape. */
export function mapDaemonError(status: number, json: unknown): ToolResult {
  const err = (json as { error?: { code?: string; message?: string } }).error;
  const code = err?.code ?? (status === 503 ? "not_connected" : "invalid_input");
  return errorResult(code, err?.message ?? `daemon answered with status ${status}`);
}
