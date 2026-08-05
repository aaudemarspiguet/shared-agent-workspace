// saw up (T021): start the member's local SAW stack.
// One process: daemon (relay client) + web page + hook/MCP local API.
// Ctrl-C stops it and removes the daemon info file.
import { execFileSync } from "node:child_process";
import {
  readConfig,
  removeDaemonInfo,
  resolveRepoRoot,
  writeDaemonInfo
} from "../config.js";
import { Daemon } from "../daemon/daemon.js";
import { startWebServer } from "../web/server.js";
import { installHooks } from "../hooks/install.js";
import { EXIT_ENV_ERROR, fail } from "./init.js";

export interface UpOptions {
  port?: string;
  web?: boolean;
}

/** Register the MCP server with Claude Code when the claude CLI is present. */
function registerMcp(root: string): string {
  try {
    execFileSync("claude", ["mcp", "add", "saw", "--", "saw", "mcp"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return "registered with Claude Code (claude mcp add saw -- saw mcp)";
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/already exists/i.test(text)) {
      return "already registered with Claude Code";
    }
    return "not registered. Run by hand: claude mcp add saw -- saw mcp";
  }
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

  let daemon: Daemon;
  try {
    daemon = new Daemon({ root });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), EXIT_ENV_ERROR);
  }

  const connected = await daemon.start();
  const port = options.port ? Number(options.port) : config.web_port;

  let webUrl = "off";
  let close: (() => Promise<void>) | undefined;
  if (options.web !== false) {
    try {
      const web = await startWebServer(daemon, port);
      webUrl = `http://localhost:${web.port}`;
      writeDaemonInfo(root, {
        port: web.port,
        pid: process.pid,
        started_at: new Date().toISOString()
      });
      close = web.close;
    } catch (error) {
      fail(
        `the web port ${port} is not free (${error instanceof Error ? error.message : "bind failed"}). Stop the other saw up, or pass --port`,
        EXIT_ENV_ERROR
      );
    }
  } else {
    writeDaemonInfo(root, {
      port,
      pid: process.pid,
      started_at: new Date().toISOString()
    });
  }

  const hookResult = installHooks(root);
  const mcpResult = registerMcp(root);

  const status = daemon.status();
  console.log(`SAW is up for "${config.workspace_name}".`);
  console.log(`  member:  ${config.github_username}`);
  console.log(`  relay:   ${config.relay_url} — ${connected ? "connected" : "NOT connected (retrying in the background)"}`);
  console.log(`  members: ${status.members.map((m) => `${m.github_username}${m.online ? " (online)" : ""}`).join(", ")}`);
  console.log(`  web:     ${webUrl}`);
  console.log(`  hooks:   ${hookResult.added.length > 0 ? `installed ${hookResult.added.join(", ")}` : "already installed"} (${hookResult.path})`);
  console.log(`  mcp:     ${mcpResult}`);
  console.log("");
  console.log("Press Ctrl-C to stop.");

  const shutdown = async (): Promise<void> => {
    removeDaemonInfo(root);
    daemon.stop();
    if (close) await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
