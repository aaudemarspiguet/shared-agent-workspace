# Contract: `saw` CLI

One command with three subcommands. All output is plain text in STE style.
Exit code 0 on success, 1 on user error (bad input, bad invite), 2 on
environment error (no git repo, relay unreachable).

## saw init

Create a workspace for the current repository. Run by the first member.

```
saw init --name <workspace-name> [--relay <url>] [--github <username>]
```

Preconditions: current directory is a git repository with at least one
remote. Fails with exit 2 otherwise.

Effects:

1. Registers the workspace at the relay (name, repo remote URL); stores the
   returned workspace id and creator credential.
2. Writes `.saw/config.json` — workspace id, relay URL, github username,
   repo remote, branch prefix (`<username>/`).
3. Writes `.saw/credential` (bearer token) and appends `.saw/credential` to
   `.gitignore`.
4. Writes `.saw/AGENT.md` — STE instructions that tell the agent: which
   five tools exist, the five message types, how to claim and hand off
   work, the own-branch rule, and that only messages and refs may be sent.
5. Prints next steps, including the invite command.

```
saw invite --github <invitee-username> [--expires 72h]
```

Prints a signed invite link (see research.md §6). Creator only.

## saw join

Connect the second member using an invite.

```
saw join <invite-link> [--github <username>]
```

Preconditions: current directory is a clone of the same repository (remote
URL must match the workspace's `repo_remote`; mismatch → exit 1).

Effects:

1. Presents the invite to the relay; on success receives member identity +
   bearer token.
2. Writes `.saw/config.json`, `.saw/credential` (git-ignored), and
   `.saw/AGENT.md` exactly as `saw init` does.
3. Prints confirmation with both members' names.

Failure modes: expired invite, already-used invite, username mismatch,
workspace already has two members → clear STE error message, exit 1.

## saw up

Start the member's local SAW stack. Long-running; Ctrl-C stops it.

```
saw up [--port <web-port>] [--no-web]     # web-port default: 7420
```

Effects:

1. Starts the daemon: connects to the relay over WebSocket (auth via
   `.saw/credential`), syncs missed messages, mirrors pause state.
2. Starts the MCP server (stdio entry `saw mcp` is spawned by the coding
   tool; `saw up` registers it if not present — for Claude Code via
   `claude mcp add saw -- saw mcp`).
3. Installs/verifies the Claude Code hooks adapter entries in
   `.claude/settings.json` (see contracts/hooks-adapter.md).
4. Serves the web interface at `http://localhost:<port>`.
5. Prints: relay status, member presence, web URL.

`saw up` never touches the peer's machine and never opens any non-localhost
listener except the relay client connection.

## Git conventions (documented in AGENT.md, not enforced by CLI)

- Each agent works only on branches with its member's prefix
  (`alice/...`).
- Push to the existing remote; never force-push another member's branch.
- Merges are negotiated in the room (`decision` message closes the
  question), then performed by a human or the claiming agent locally.
