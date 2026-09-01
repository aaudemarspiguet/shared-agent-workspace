// Unit tests for the two things saw up must get right before it prints:
//   1. the command it gives Claude Code must really resolve (hooks + MCP);
//   2. the process must stay alive and say what happened, even with no relay.
// A stub `claude` on PATH stands in for the real CLI, so no test touches the
// member's own Claude Code configuration.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveSawCommand,
  sawCommandLine,
  type SawCommand
} from "../src/hooks/install.js";
import { parseMcpListStatus, registerMcp } from "../src/commands/up.js";

const SAW_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "saw.js");

/**
 * PATH entries that hold the platform's own tools, but never saw and never
 * claude. The separator and the directories both differ by platform: on
 * Windows the POSIX pair does not exist and ":" is not the separator, which
 * leaves a PATH in which even the stub directory cannot be found.
 */
const SYSTEM_ROOT = process.env.SystemRoot ?? "C:/Windows";
const SAFE_PATH =
  process.platform === "win32"
    ? [join(SYSTEM_ROOT, "System32"), SYSTEM_ROOT].join(delimiter)
    : ["/usr/bin", "/bin"].join(delimiter);

/** The stub directory ahead of the platform's own tools. */
function stubPath(): string {
  return [stubBin, SAFE_PATH].join(delimiter);
}

interface StubState {
  /** The argv of the registered MCP server, or null when there is none. */
  server: string[] | null;
  /** Every claude call, in order. */
  calls: string[][];
}

let base: string;
let stubBin: string;
let statePath: string;
let savedPath: string | undefined;
let savedState: string | undefined;

/**
 * Write a stub `claude` that answers the three commands saw up uses.
 * The stub reports a server as connected only when its command resolves,
 * which is the exact property the real health check tests.
 */
function writeClaudeStub(): void {
  const script = `#!${process.execPath}
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const statePath = process.env.SAW_STUB_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const resolves = (file) => {
  if (file.includes(path.sep)) return fs.existsSync(file);
  return (process.env.PATH || "")
    .split(path.delimiter)
    .some((dir) => dir && fs.existsSync(path.join(dir, file)));
};
if (args[0] !== "mcp") { save(); process.exit(0); }
if (args[1] === "list") {
  let out = "Checking MCP server health...\\n\\n";
  if (!state.server) out += "No MCP servers configured. Use claude mcp add.\\n";
  else {
    const shown = state.server.join(" ");
    out += resolves(state.server[0])
      ? "saw: " + shown + " - \\u2714 Connected\\n"
      : "saw: " + shown + " - \\u2718 Failed to connect\\n";
  }
  save();
  process.stdout.write(out);
  process.exit(0);
}
if (args[1] === "add") {
  if (state.server) {
    save();
    process.stderr.write("MCP server saw already exists in local config\\n");
    process.exit(1);
  }
  state.server = args.slice(args.indexOf("--") + 1);
  save();
  process.stdout.write("Added stdio MCP server saw to local config\\n");
  process.exit(0);
}
if (args[1] === "remove") {
  state.server = null;
  save();
  process.stdout.write("Removed MCP server saw from local config\\n");
  process.exit(0);
}
save();
process.exit(0);
`;
  writeStubProgram("claude", script);
}

/**
 * Write a stub program the running platform can actually start.
 *
 * POSIX runs the shebang file directly. Windows starts real executables and
 * shims only, so the script goes beside a .cmd that hands it to node - the
 * same shape npm gives its own bin shims, which is the form saw meets in the
 * field on Windows.
 */
function writeStubProgram(name: string, script: string): void {
  if (process.platform !== "win32") {
    const file = join(stubBin, name);
    writeFileSync(file, script);
    chmodSync(file, 0o755);
    return;
  }
  const scriptFile = join(stubBin, `${name}-stub.js`);
  writeFileSync(scriptFile, script);
  writeFileSync(
    join(stubBin, `${name}.cmd`),
    `@echo off\r\n"${process.execPath}" "${scriptFile}" %*\r\n`
  );
}

function writeState(state: StubState): void {
  writeFileSync(statePath, JSON.stringify(state));
}

function readState(): StubState {
  return JSON.parse(readFileSync(statePath, "utf8")) as StubState;
}

/** A workspace directory with the files a daemon needs. */
function makeWorkspace(relayUrl: string): string {
  const root = join(base, `ws-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, ".saw"), { recursive: true });
  writeFileSync(
    join(root, ".saw", "config.json"),
    JSON.stringify({
      workspace_id: "ws-test",
      workspace_name: "up-test",
      relay_url: relayUrl,
      github_username: "tester",
      repo_remote: "git@github.com:example/repo.git",
      branch_prefix: "tester/",
      members: ["tester"],
      web_port: 0
    })
  );
  writeFileSync(join(root, ".saw", "credential"), "test-token\n", { mode: 0o600 });
  return root;
}

/** A port with nothing on it. Bind it once, then give it back. */
async function deadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "saw-up-"));
  stubBin = join(base, "bin");
  mkdirSync(stubBin);
  statePath = join(base, "stub-state.json");
  savedPath = process.env.PATH;
  savedState = process.env.SAW_STUB_STATE;
  writeClaudeStub();
  writeState({ server: null, calls: [] });
  process.env.SAW_STUB_STATE = statePath;
  process.env.PATH = stubPath();
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedState === undefined) delete process.env.SAW_STUB_STATE;
  else process.env.SAW_STUB_STATE = savedState;
  rmSync(base, { recursive: true, force: true });
});

describe("resolveSawCommand", () => {
  it("uses the plain name when saw is on PATH", () => {
    writeStubProgram("saw", `#!${process.execPath}\nprocess.exit(0);\n`);

    const command = resolveSawCommand();
    expect(command).toEqual({ file: "saw", args: [], onPath: true });
    expect(sawCommandLine(command)).toBe("saw");
  });

  it("falls back to node plus the absolute script when saw is not on PATH", () => {
    const command = resolveSawCommand();
    expect(command.onPath).toBe(false);
    expect(command.file).toBe(process.execPath);
    expect(command.args).toHaveLength(1);
    expect(isAbsolute(command.args[0] ?? "")).toBe(true);
    // The line goes into a settings file, so both parts carry quotes.
    expect(sawCommandLine(command)).toBe(`"${command.file}" "${command.args[0]}"`);
  });
});

describe("parseMcpListStatus", () => {
  it("reads the failure the member really saw", () => {
    const text =
      "Checking MCP server health...\n\n" +
      'saw: saw mcp - ✘ Failed to connect — ENOENT: Executable not found in $PATH: "saw"\n';
    expect(parseMcpListStatus(text, "saw")).toBe("failed");
  });

  it("reads a working server", () => {
    // The mark the installed claude CLI prints today.
    const text = "saw: /usr/bin/node /repo/bin/saw.js mcp - ✔ Connected\n";
    expect(parseMcpListStatus(text, "saw")).toBe("connected");
  });

  it("reads a working server with the other check mark", () => {
    const text = "saw: /usr/bin/node /repo/bin/saw.js mcp - ✓ Connected\n";
    expect(parseMcpListStatus(text, "saw")).toBe("connected");
  });

  it("reports absent when the name is not in the list", () => {
    const text = "other: node other.js - ✓ Connected\n";
    expect(parseMcpListStatus(text, "saw")).toBe("absent");
  });
});

describe("registerMcp", () => {
  const root = () => makeWorkspace("ws://127.0.0.1:1");

  it("registers a command that resolves, never the bare name", () => {
    const result = registerMcp(root());
    expect(result.ok).toBe(true);
    expect(result.message).toContain("connected");

    const state = readState();
    expect(state.server?.[0]).toBe(process.execPath);
    expect(state.server?.[state.server.length - 1]).toBe("mcp");
    // The bare name is what broke the product. It must never be registered.
    expect(state.server).not.toEqual(["saw", "mcp"]);
  });

  it("detects a registration that cannot start, and repairs it", () => {
    writeState({ server: ["saw", "mcp"], calls: [] });

    const result = registerMcp(root());
    expect(result.ok).toBe(true);
    expect(result.message).toContain("re-registered");

    const state = readState();
    expect(state.calls.map((call) => call.join(" "))).toContain("mcp remove saw");
    expect(state.server?.[0]).toBe(process.execPath);
  });

  it("leaves a working registration alone", () => {
    writeState({ server: [process.execPath, "mcp"], calls: [] });

    const result = registerMcp(root());
    expect(result.ok).toBe(true);
    expect(result.message).toContain("already registered");

    const state = readState();
    const verbs = state.calls.map((call) => call[1]);
    expect(verbs).not.toContain("add");
    expect(verbs).not.toContain("remove");
  });

  it("never reports success for a registration that cannot start", () => {
    const broken: SawCommand = { file: "saw-is-not-here", args: [], onPath: true };

    const result = registerMcp(root(), broken);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("NOT working");
    expect(result.message).toContain("claude mcp add saw -- saw-is-not-here mcp");
  });

  it("says what to run by hand when the claude CLI is missing", () => {
    process.env.PATH = SAFE_PATH;

    const result = registerMcp(root());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("the claude CLI is not on PATH");
    expect(result.message).toContain("claude mcp add saw --");
  });
});

/**
 * True where the harness can deliver a real SIGINT and see the clean exit.
 *
 * Windows has no signal delivery: Node maps kill() to TerminateProcess
 * whatever name it is given, so saw's own Ctrl-C handler never runs and the
 * exit code comes back null. A real Ctrl-C in a real console does reach the
 * product as a console control event, so this is the harness's limit, not
 * the product's. Everything except the exit code is asserted on both.
 */
const SIGNALS_DELIVER = process.platform !== "win32";

/** One running `saw up`, with everything the assertions need. */
interface UpRun {
  out(): string;
  err(): string;
  exitCode(): number | null;
  /** True once the process has ended, whatever code it ended with. */
  hasExited(): boolean;
  /** Wait until the command has printed its last line, or the wait ends. */
  ready(): Promise<void>;
  stop(): Promise<number | null>;
}

/** Stop a run and assert it ended, with the exit code where that is real. */
async function stopCleanly(run: UpRun): Promise<void> {
  const code = await run.stop();
  expect(run.hasExited(), "saw up did not stop").toBe(true);
  if (SIGNALS_DELIVER) expect(code).toBe(0);
}

function runUp(root: string): UpRun {
  const child = spawn(process.execPath, [SAW_BIN, "up", "--port", "0"], {
    cwd: root,
    env: { ...process.env, PATH: stubPath(), SAW_STUB_STATE: statePath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  let err = "";
  let exited: number | null = null;
  let ended = false;
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  child.on("exit", (code) => {
    exited = code;
    ended = true;
  });

  return {
    out: () => out,
    err: () => err,
    exitCode: () => exited,
    hasExited: () => ended,
    ready: async () => {
      const deadline = Date.now() + 25_000;
      while (!out.includes("Press Ctrl-C to stop.") && exited === null) {
        if (Date.now() > deadline) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    stop: () => {
      child.kill("SIGINT");
      return new Promise<number | null>((resolve) => {
        if (exited !== null) return resolve(exited);
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(null);
        }, 5000);
        child.on("exit", (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    }
  };
}

describe("saw up without a relay", () => {
  it("prints its status, registers a real command, and keeps running", async () => {
    const root = makeWorkspace(`ws://127.0.0.1:${await deadPort()}`);
    const run = runUp(root);
    try {
      await run.ready();

      // The bug: exit 0 in 0.15s with both streams empty.
      expect(`${run.out()}${run.err()}`.length, "saw up printed nothing").toBeGreaterThan(0);
      expect(run.exitCode(), "saw up exited instead of running").toBeNull();
      expect(run.out()).toContain("NOT connected");
      expect(run.out()).toContain("Press Ctrl-C to stop.");
      // The registered command is one that Claude Code can really start.
      expect(run.out()).toContain("mcp:     registered with Claude Code and connected");
      const state = readState();
      expect(state.server?.[0]).toBe(process.execPath);
      expect(state.server?.[1] ?? "").toMatch(/saw\.js$/);
      expect(state.server?.[2]).toBe("mcp");
    } finally {
      await stopCleanly(run);
    }
  }, 40_000);

  it("says the credential is refused when the relay rejects it", async () => {
    const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    relay.on("connection", (socket) => {
      socket.on("message", () => {
        socket.send(
          JSON.stringify({ kind: "error", code: "auth_failed", message: "token is not valid" })
        );
        socket.close();
      });
    });
    await new Promise<void>((resolve) => relay.once("listening", () => resolve()));
    const address = relay.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const run = runUp(makeWorkspace(`ws://127.0.0.1:${port}`));
    try {
      await run.ready();
      expect(run.exitCode(), "saw up exited instead of running").toBeNull();
      expect(run.out()).toContain("refused the credential");
      expect(run.out()).toContain("saw join");
    } finally {
      await stopCleanly(run);
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  }, 40_000);
});
