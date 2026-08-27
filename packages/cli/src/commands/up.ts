// saw up (T021): start the member's local SAW stack.
// One process: daemon (relay client) + web page + hook/MCP local API.
// Ctrl-C stops it and removes the daemon info file.
import { execFileSync } from "node:child_process";
import {
  readConfig,
  removeDaemonInfo,
  resolveRepoRoot,
  writeDaemonInfo,
  type SawConfig
} from "../config.js";
import { Daemon } from "../daemon/daemon.js";
import { displayRelay, isTunnelAddress, resolveRelay } from "../tunnel.js";
import { startWebServer } from "../web/server.js";
import {
  installHooks,
  resolveSawCommand,
  sawCommandLine,
  type SawCommand
} from "../hooks/install.js";
import { EXIT_ENV_ERROR, fail } from "./init.js";

export interface UpOptions {
  port?: string;
  web?: boolean;
}

/** The MCP server name inside Claude Code. */
const MCP_NAME = "saw";

/**
 * Cap on one claude CLI call. `claude mcp list` starts every server to test
 * it, so it is the slow one.
 */
const CLAUDE_TIMEOUT_MS = 30_000;

/** How often the keep-alive timer fires. The handle matters, not the work. */
const KEEP_ALIVE_MS = 3_600_000;

/** What `claude mcp list` says about one server. */
export type McpHealth = "connected" | "failed" | "absent";

export interface McpResult {
  /** True only when Claude Code can start the server and connect to it. */
  ok: boolean;
  /** The line `saw up` prints. */
  message: string;
}

interface ClaudeRun {
  ok: boolean;
  /** stdout and stderr together. Both hold parts of the answer. */
  out: string;
  /** True when the claude CLI is not on PATH. */
  missing: boolean;
}

/** Run one claude CLI command. Never throws. */
function runClaude(root: string, args: string[]): ClaudeRun {
  try {
    const out = execFileSync("claude", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: CLAUDE_TIMEOUT_MS
    });
    return { ok: true, out, missing: false };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    const out = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim();
    return {
      ok: false,
      out: out || failure.message || String(error),
      missing: failure.code === "ENOENT"
    };
  }
}

/** The marks the claude CLI puts in front of a healthy server. */
const HEALTHY_MARK = /[✓✔]/;

/**
 * Read the state of one MCP server from `claude mcp list` output.
 *
 * The list starts each server and prints the result on its own line, like
 * `saw: /path/to/node /path/to/saw.js mcp - ✔ Connected`. A registration that
 * cannot start prints `✘ Failed to connect` on the same shape of line. Read
 * the word too, because the mark can change with the CLI version.
 */
export function parseMcpListStatus(text: string, name: string): McpHealth {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${name}:`)) continue;
    if (/fail/i.test(trimmed)) return "failed";
    if (HEALTHY_MARK.test(trimmed) || /\bconnected\b/i.test(trimmed)) return "connected";
    return "failed";
  }
  return "absent";
}

/**
 * Register the MCP server with Claude Code, then prove that it works.
 *
 * The command must be one that Claude Code can really run. The plain name
 * "saw" is not on PATH in the documented install, so a registration of "saw"
 * gives the agent no tools at all while `saw up` claims success. Register the
 * resolved command, and read `claude mcp list` afterwards to see the truth.
 * A registration that is already there but cannot start gets removed and
 * added again: a dead entry is worse than none.
 */
export function registerMcp(root: string, command: SawCommand = resolveSawCommand()): McpResult {
  const argv = [command.file, ...command.args, "mcp"];
  const byHand = `claude mcp add ${MCP_NAME} -- ${sawCommandLine(command)} mcp`;

  const before = runClaude(root, ["mcp", "list"]);
  if (before.missing) {
    return {
      ok: false,
      message: `not registered: the claude CLI is not on PATH. Run this after you install it: ${byHand}`
    };
  }
  const health = parseMcpListStatus(before.out, MCP_NAME);
  if (health === "connected") {
    return { ok: true, message: "already registered with Claude Code and connected" };
  }

  let repaired = health === "failed";
  if (repaired) runClaude(root, ["mcp", "remove", MCP_NAME]);
  let added = runClaude(root, ["mcp", "add", MCP_NAME, "--", ...argv]);
  if (!added.ok && /already exists/i.test(added.out)) {
    // The list did not show it, but claude holds one in another scope. It
    // never answered a connect, so replace it too.
    runClaude(root, ["mcp", "remove", MCP_NAME]);
    added = runClaude(root, ["mcp", "add", MCP_NAME, "--", ...argv]);
    repaired = true;
  }

  const after = runClaude(root, ["mcp", "list"]);
  if (parseMcpListStatus(after.out, MCP_NAME) === "connected") {
    return {
      ok: true,
      message: repaired
        ? "re-registered with Claude Code and connected (the old registration could not start)"
        : "registered with Claude Code and connected"
    };
  }
  const why = added.ok ? "the server does not answer" : firstLine(added.out);
  return {
    ok: false,
    message: `NOT working (${why}). Your agent has no SAW tools. Fix it by hand: ${byHand}`
  };
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return (line ?? "no output").trim();
}

type WebServer = Awaited<ReturnType<typeof startWebServer>>;

/**
 * Start the web server. Turn a bind failure into a value, not a crash.
 *
 * A bind failure arrives twice. The http server rejects the start promise,
 * and the WebSocket server on top of it re-emits the same error with no
 * listener of its own. That second copy reaches node as an uncaught
 * exception and kills the process with a stack trace before the friendly
 * message can print. Hold uncaught exceptions for the length of the start,
 * so the member reads the reason instead of the trace.
 */
async function startWeb(daemon: Daemon, port: number): Promise<WebServer> {
  let onUncaught: ((error: unknown) => void) | undefined;
  const crashed = new Promise<never>((_resolve, reject) => {
    onUncaught = (error: unknown) => reject(error);
    process.on("uncaughtException", onUncaught);
  });
  try {
    return await Promise.race([startWebServer(daemon, port), crashed]);
  } finally {
    if (onUncaught) process.off("uncaughtException", onUncaught);
  }
}

/** The one line that says what the relay connection is doing. */
function relayLine(config: SawConfig, daemon: Daemon): string {
  if (daemon.connected) return `${displayRelay(config.relay_url)} — connected`;
  const problem = daemon.relayProblem;
  if (problem) return `${displayRelay(config.relay_url)} — NOT connected. ${problem}`;
  return (
    `${displayRelay(config.relay_url)} — NOT connected. saw keeps trying in the background. ` +
    "Check that the relay runs."
  );
}

export async function runUp(options: UpOptions): Promise<void> {
  const root = resolveRepoRoot();
  if (!root) {
    fail("this directory is not inside a git repository", EXIT_ENV_ERROR);
  }
  const config = readConfig(root);
  if (!config) {
    fail("this repository has no SAW workspace. Run saw init or saw join first.", EXIT_ENV_ERROR);
  }

  // A tunnel address in the config needs the tunnel up before the daemon
  // dials. For a direct URL this resolves to the URL itself at no cost.
  let relayWsUrl: string | undefined;
  let closeTunnel: (() => Promise<void>) | undefined;
  if (isTunnelAddress(config.relay_url)) {
    try {
      const resolved = await resolveRelay(config.relay_url);
      relayWsUrl = resolved.urls.ws;
      closeTunnel = resolved.close;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), EXIT_ENV_ERROR);
    }
  }

  let daemon: Daemon;
  try {
    daemon = new Daemon({ root, relayWsUrl });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), EXIT_ENV_ERROR);
  }

  // Say something before the first wait. The relay wait and the MCP check
  // both take seconds, and silence reads as a hang.
  console.log(`Starting SAW for "${config.workspace_name}" (${config.github_username})...`);

  const connected = await daemon.start();
  const port = options.port ? Number(options.port) : config.web_port;

  let webUrl = "off";
  let close: (() => Promise<void>) | undefined;
  if (options.web !== false) {
    try {
      const web = await startWeb(daemon, port);
      webUrl = `http://localhost:${web.port}`;
      // The token goes in the file that hooks and MCP tools already read. The
      // file is mode 0600, so no other user can take it (T057).
      writeDaemonInfo(root, {
        port: web.port,
        pid: process.pid,
        started_at: new Date().toISOString(),
        token: daemon.localToken
      });
      close = web.close;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (/EADDRINUSE/.test(reason)) {
        fail(
          `the web port ${port} is not free. Another saw up already runs in this repository. Stop it, or pass --port <other-port>`,
          EXIT_ENV_ERROR
        );
      }
      fail(
        `the web port ${port} did not open (${reason}). Stop the other saw up, or pass --port`,
        EXIT_ENV_ERROR
      );
    }
  } else {
    writeDaemonInfo(root, {
      port,
      pid: process.pid,
      started_at: new Date().toISOString(),
      token: daemon.localToken
    });
  }

  const hookResult = installHooks(root);
  const mcpResult = registerMcp(root);

  const status = daemon.status();
  console.log(`SAW is up for "${config.workspace_name}".`);
  console.log(`  member:  ${config.github_username}`);
  console.log(`  relay:   ${relayLine(config, daemon)}`);
  console.log(`  members: ${status.members.map((m) => `${m.github_username}${m.online ? " (online)" : ""}`).join(", ")}`);
  console.log(`  web:     ${webUrl}`);
  console.log(`  hooks:   ${hookResult.added.length > 0 ? `installed ${hookResult.added.join(", ")}` : "already installed"} (${hookResult.path})`);
  console.log(`  mcp:     ${mcpResult.message}`);
  console.log("");
  console.log("Press Ctrl-C to stop.");
  if (!connected) {
    console.log("");
    console.log(
      "The room needs the relay. Messages you send now fail, and each run is held locally until the relay answers."
    );
  }

  // Hold the event loop open. The relay client unrefs its reconnect timer, so
  // with the relay down and no web server nothing else keeps this process
  // alive: node would exit right after these lines print.
  const keepAlive = setInterval(() => {
    // Nothing to do. The live handle is the point.
  }, KEEP_ALIVE_MS);

  const shutdown = async (): Promise<void> => {
    clearInterval(keepAlive);
    removeDaemonInfo(root);
    daemon.stop();
    if (close) await close();
    if (closeTunnel) await closeTunnel();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
