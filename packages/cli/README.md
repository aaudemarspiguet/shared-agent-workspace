# @saw/cli

The `saw` command. It connects you and your coding agent to a shared SAW
workspace. One package contains:

- The setup commands: `init`, `invite`, and `join`.
- The daemon and a local web page, started by `saw up`.
- Five MCP tools for your coding agent (stdio server, `saw mcp`).
- Four Claude Code hooks (`saw hook <event>`).

Hooks, MCP tools, and the web page all talk to your own daemon. Nothing in
this package touches your teammate's machine.

## Install and run

Run `npm install` at the repo root. There is no build step. The bin shim
loads `tsx` and runs the TypeScript source directly.

The install puts the command at `node_modules/.bin/saw`. That path is
**not** on your PATH. Put it there once:

```sh
npm install                    # at the repo root
cd packages/cli && npm link     # puts `saw` on your PATH
which saw                       # must print a path
```

The full path works too, if you prefer not to link. Use
`node_modules/.bin/saw` in place of `saw` in every command.

**How other programs call saw.** `saw up` writes your saw command into
the Claude Code hook entries and into the MCP server registration. It
resolves the command first: the plain name `saw` when that name is on
your PATH, and the node binary plus the absolute path of the script when
it is not. Both forms start, so an unlinked install keeps its hooks and
its MCP tools. A registration of the bare `saw` on a machine that has no
`saw` on the PATH would give the agent no tools at all, so the command is
never written that way.

## Commands

Create the workspace. The first member runs this inside a git repository
that has a remote:

```
saw init --name <workspace-name> [--relay <url>] [--github <username>]
```

The relay default is `ws://localhost:8787`. When you omit `--github`, saw
reads `git config github.user`.

Print a signed invite link for your teammate. Creator only. The invite is
valid for 72 hours by default:

```
saw invite --github <invitee-username> [--expires <hours>]
```

Join with the invite link. Run it inside a clone of the same repository:

```
saw join <invite-link> [--github <username>] [--relay <url>]
```

Start the local SAW stack. Ctrl-C stops it:

```
saw up [--port <web-port>] [--no-web]
```

`saw up` starts the daemon, serves the web page (default port 7420), and installs
the four hooks in `.claude/settings.json`. When the `claude` CLI is present, it
also registers the MCP server, then reads `claude mcp list` to check that the
server really starts. The `mcp:` line of the output reports that check. A
registration that cannot start is removed and added again.

Two members on one machine need two web ports. Pass `--port`. A second
`saw up` on a port in use stops with `EADDRINUSE`.

Share this machine's relay so members reach it with no VPN (see the
section below):

```
saw share-relay [--target <url>] [--key <path>] [--write-config]
```

Run the stdio MCP server. Coding tools spawn this. Do not run it by hand:

```
saw mcp
```

Hook entry points. `saw up` registers them. Do not run them by hand:

```
saw hook session-start | prompt-submit | pre-tool | stop
```

## Share the relay with no VPN

The relay listens on one machine. Without help, the other members need a
VPN or a port forward to reach it. `saw share-relay` removes that step.

On the machine that runs the relay, in its own terminal:

```bash
saw share-relay
```

The command prints an `iroh:` address. Put that address in
`.saw/config.json` as `relay_url` (or run with `--write-config`) and
commit the file. Every other member now joins and connects with no
network setup: `saw join` and `saw up` open the tunnel on their side by
themselves.

How it works: the address names the host machine's public key, not an
IP. The connection dials the key, punches through NAT when it can (about
9 of 10 networks), and falls back to a public transport relay when it
cannot. Only bytes of the existing relay protocol cross. The host key
lives in `~/.saw/relay-tunnel.key`, so the address stays stable across
restarts. Keep `saw share-relay` running whenever the relay runs.

A direct `ws://` relay URL still works everywhere. The tunnel is used
only when `relay_url` starts with `iroh:`.

## The .saw/ files

| File          | What it is                                        | In git?    |
|---------------|---------------------------------------------------|------------|
| `config.json` | Workspace settings both members share: ids, relay URL, members, web port. | Commit it. |
| `member.json` | Who you are here: your GitHub username and your branch prefix. | Ignored.   |
| `credential`  | Your bearer token. Mode 0600. Never share it.     | Ignored.   |
| `AGENT.md`    | Room rules for your coding agent. `init` and `join` write your own. | Ignored.   |
| `daemon.json` | Runtime info for a running daemon: web port, pid, run token. Mode 0600. | Ignored. |
| `state.json`  | Local read cursor (last injected seq).            | Ignored.   |
| `log-spool.jsonl` | Runs the relay has not accepted yet.          | Ignored.   |

`config.json` is the only shared file. Commit it after `saw init`, and
push it before your teammate runs `saw join`. Their `join` reads the
relay URL from it. Without it, `join` falls back to the default relay URL
and reports "the relay is not reachable".

## The local surface is authenticated

`saw up` listens on 127.0.0.1 only. That stops other machines. It does not
stop your own browser, because a page you visit can post to a local address
and can open a local WebSocket. So the room page, the API, and the push
channel all need a run token.

`saw up` makes a new token for each run and writes it into `.saw/daemon.json`.
Hooks and MCP tools read it from there. The room page receives it in the HTML
the daemon serves, which a page on another site cannot read. The daemon
refuses any caller with a foreign origin, with no token, or with a change that
is not `application/json`.

Each run of `saw up` makes a new token. Hooks and MCP tools read
`.saw/daemon.json` on every call, so they follow a restart with no other step.
An older `saw` sends no token at all: hooks then stay silent and the MCP tools
report the reason. Upgrade `saw`, then start `saw up` again.

## How the hooks behave

Each hook reads the hook JSON on stdin and asks the daemon over localhost
HTTP. When the daemon is down, every hook prints nothing and exits 0. The
agent then works normally, without coordination.

- `SessionStart` and `UserPromptSubmit` inject unread room messages, claim
  notices, and your pause state. They advance the read cursor.
- `PreToolUse` (matcher `*`) denies every tool call while you are paused,
  with a clear reason.
- `Stop` posts the mechanical run summary: tool-use counts, branch, head SHA,
  changed-file count. File paths and file contents never enter it. It exits 0
  even when logging fails.

A run that ends while the relay is away is not lost. The daemon writes it to
`.saw/log-spool.jsonl` and sends it at the next reconnect, oldest first. The
entry keeps the times of the run, so the log shows when you worked and not
when the network returned. The spool holds 500 runs; at that cap the oldest
run goes.

## The five MCP tools

- `room_read` — read room messages in seq order, newest last.
- `room_post` — post one message. An intent with a `work_item` claims it.
  The first claim wins.
- `work_log` — query stored run summaries by member, work item, and time.
- `peer_activity` — report what your teammate did since a time. Works
  while the peer is offline.
- `workspace_status` — snapshot of members, presence, pause, unread, work items.

While you are paused, every tool except `workspace_status` answers with a
`paused` error.

## The web page

`saw up` serves the page on `http://localhost:7420`. It binds 127.0.0.1
only. The page shows:

- The room, with live updates.
- A composer with a redirect target (`to: everyone` or one member).
- A pause button. It pauses your own member only.
- A work log browser with member and work-item filters.

## Boundary

Only messages and git refs cross between members. Code moves only through
git. The daemon validates each post before it sends it. The relay
validates again and logs each rejection in the work log. A rejected body
is never stored and never delivered.
