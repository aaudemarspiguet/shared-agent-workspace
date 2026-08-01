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

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`saw: ${message}`);
  process.exit(2);
});
