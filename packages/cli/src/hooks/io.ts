// Shared hook plumbing.
// Hooks read JSON on stdin, ask the local daemon over localhost HTTP, and
// answer on stdout. When the daemon is down, every hook stays silent and
// exits 0. A hook must never break the member's coding tool.
import { readDaemonInfo, resolveRepoRoot } from "../config.js";

/** Read all of stdin. Resolve with "" when stdin stays quiet. */
export function readStdin(timeoutMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString("utf8")), timeoutMs);
    process.stdin.on("data", (chunk) => chunks.push(chunk as Buffer));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

export function parseHookInput(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Call the local daemon. Return undefined on any failure.
 * The timeout keeps hooks fast even when the daemon hangs.
 *
 * The call presents the run token from .saw/daemon.json (T057). The daemon
 * refuses a call without it. A hook that cannot prove itself behaves exactly
 * as it does when the daemon is down: it stays silent and exits 0, because a
 * hook must never break the member's coding tool.
 */
export async function daemonRequest(
  path: string,
  init?: { method?: string; body?: unknown },
  timeoutMs = 1500,
  cwd?: string
): Promise<unknown> {
  const root = resolveRepoRoot(cwd ?? process.cwd());
  if (!root) return undefined;
  const info = readDaemonInfo(root);
  if (!info || !info.token) return undefined;
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
    if (!res.ok) return undefined;
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Write one JSON object to stdout for Claude Code. */
export function emit(output: object): void {
  process.stdout.write(JSON.stringify(output));
}
