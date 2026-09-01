// The saw command line. Subcommands: init, invite, join, up, mcp, hook.
import { Command } from "commander";
import { runInit, runInvite } from "./commands/init.js";
import { runJoin } from "./commands/join.js";

const program = new Command();

program
  .name("saw")
  .description("SAW connects two coding agents through a shared, human-visible room.")
  .version("0.1.0");

program
  .command("init")
  .description("Create a workspace for this repository. Run by the first member.")
  .requiredOption("--name <workspace-name>", "workspace name")
  .option("--relay <url>", "relay URL (default ws://localhost:8787)")
  .option("--github <username>", "your GitHub username")
  .action(async (opts: { name: string; relay?: string; github?: string }) => {
    await runInit(opts);
  });

program
  .command("invite")
  .description("Print a signed invite link for your teammate. Creator only.")
  .requiredOption("--github <invitee-username>", "the invitee GitHub username")
  .option("--expires <hours>", "invite lifetime in hours, like 72h")
  .action(async (opts: { github: string; expires?: string }) => {
    await runInvite(opts);
  });

program
  .command("join")
  .description("Join a workspace with an invite link. Run inside a clone of the repo.")
  .argument("<invite-link>", "the signed invite link from saw invite")
  .option("--github <username>", "your GitHub username")
  .option("--relay <url>", "relay URL when .saw/config.json is not in the clone")
  .action(async (invite: string, opts: { github?: string; relay?: string }) => {
    await runJoin({ invite, ...opts });
  });

program
  .command("up")
  .description("Start the local SAW stack: daemon, web page, hooks, MCP registration.")
  .option("--port <web-port>", "web port (default 7420)")
  .option("--no-web", "run without the web page")
  .action(async (opts: { port?: string; web?: boolean }) => {
    const { runUp } = await import("./commands/up.js");
    await runUp(opts);
  });

const thread = program
  .command("thread")
  .description("Threads: the unit of collaboration (spec 002).");
thread
  .command("list")
  .description("List the workspace's threads with claim state.")
  .action(async () => {
    const { runThreadList } = await import("./commands/thread.js");
    await runThreadList();
  });
thread
  .command("open")
  .description("Open a thread.")
  .option("--title <title>", "thread title")
  .option("--type <type>", "work_item (default), brainstorm, or general")
  .action(async (opts: { title?: string; type?: string }) => {
    const { runThreadOpen } = await import("./commands/thread.js");
    await runThreadOpen(opts);
  });

thread
  .command("mode")
  .description("Set YOUR OWN mode on a thread: view, comment, or edit.")
  .option("--id <thread-id>", "the thread")
  .option("--mode <mode>", "view | comment | edit")
  .action(async (opts: { id?: string; mode?: string }) => {
    const { runThreadMode } = await import("./commands/thread.js");
    await runThreadMode(opts);
  });
thread
  .command("handoff <action>")
  .description("propose | accept | decline | withdraw a claim handoff.")
  .option("--id <thread-id>", "for propose: the thread")
  .option("--to <member>", "for propose: the recipient")
  .option("--ref <branch>", "for propose: your tip branch")
  .option("--handoff <handoff-id>", "for accept/decline/withdraw")
  .action(async (action: string, opts: Record<string, string>) => {
    const { runThreadHandoff } = await import("./commands/thread.js");
    await runThreadHandoff({ action, ...opts });
  });

program
  .command("share-relay")
  .description("Share this machine's relay: members reach it with no VPN and no port forwarding.")
  .option("--target <url>", "the relay this machine runs (default ws://127.0.0.1:8787)")
  .option("--key <path>", "host key file (default ~/.saw/relay-tunnel.key)")
  .option("--write-config", "write the printed address into .saw/config.json")
  .action(async (opts: { target?: string; key?: string; writeConfig?: boolean }) => {
    const { runShareRelay } = await import("./commands/share-relay.js");
    await runShareRelay(opts);
  });

program
  .command("mcp")
  .description("Run the stdio MCP server. Coding tools spawn this; do not run it by hand.")
  .action(async () => {
    const { runMcpServer } = await import("./mcp/server.js");
    await runMcpServer();
  });

const hook = program
  .command("hook")
  .description("Claude Code hook entry points. Registered by saw up.");
hook.command("session-start").action(async () => {
  const { runInjectHook } = await import("./hooks/inject.js");
  await runInjectHook("session-start");
});
hook.command("prompt-submit").action(async () => {
  const { runInjectHook } = await import("./hooks/inject.js");
  await runInjectHook("prompt-submit");
});
hook.command("pre-tool").action(async () => {
  const { runPreToolHook } = await import("./hooks/pre-tool.js");
  await runPreToolHook();
});
hook.command("stop").action(async () => {
  const { runStopHook } = await import("./hooks/stop.js");
  await runStopHook();
});

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`saw: ${message}`);
  process.exit(2);
});
