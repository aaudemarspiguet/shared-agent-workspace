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
loads `tsx` and runs the TypeScript source directly. Call the command as
`node_modules/.bin/saw`, or run `npm link` in `packages/cli` once to put
`saw` on your PATH.

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
also registers the MCP server (`claude mcp add saw -- saw mcp`).

Run the stdio MCP server. Coding tools spawn this. Do not run it by hand:

```
saw mcp
```

Hook entry points. `saw up` registers them. Do not run them by hand:

```
saw hook session-start | prompt-submit | pre-tool | stop
```

## The .saw/ files

| File          | What it is                                        | In git?    |
|---------------|---------------------------------------------------|------------|
| `config.json` | Workspace settings: ids, relay URL, members.      | Commit it. |
| `credential`  | Your bearer token. Mode 0600. Never share it.     | Ignored.   |
| `AGENT.md`    | Room rules for your coding agent.                 | Commit it. |
| `daemon.json` | Runtime info for a running daemon: web port, pid. | Ignored.   |
| `state.json`  | Local read cursor (last injected seq).            | Ignored.   |

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
