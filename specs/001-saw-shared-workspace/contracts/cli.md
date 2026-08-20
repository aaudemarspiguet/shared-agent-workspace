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

1. Presents the invite to the relay; on success receives member identity,
   bearer token, and the workspace's `repo_remote`. The joiner has no other
   source for `repo_remote`, so the relay must return it for the precondition
   above to be checkable.
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
   `.claude/settings.local.json` (see contracts/hooks-adapter.md).
4. Serves the web interface at `http://localhost:<port>`.
5. Prints: relay status, member presence, web URL.

`saw up` never touches the peer's machine and never opens any non-localhost
listener except the relay client connection.

## Local surface authentication (T057, FR-021)

A bind to 127.0.0.1 stops other machines. It does not stop the member's own
browser. While `saw up` runs, any page the member visits can post to the local
API and can open the push channel, because neither is subject to the
same-origin policy. So both surfaces authenticate every caller, on reads as
well as on changes.

**The run token.** Each run of `saw up` makes a new token. It goes into
`.saw/daemon.json`, mode 0600, beside the port and the pid. That file is
git-ignored and is already the file hooks and MCP tools read.

**Who presents it, and how.**

| Caller | How it presents the token |
| --- | --- |
| MCP tools (`saw mcp`) | `Authorization: Bearer <token>` from `.saw/daemon.json` |
| Hooks (`saw hook …`) | `Authorization: Bearer <token>` from `.saw/daemon.json` |
| The room page, HTTP | `Authorization: Bearer <token>`, read from the served HTML |
| The room page, `/ws` | subprotocol `saw.token.<token>`, then `saw` |

The page gets the token once, in the HTML the daemon serves it. A page on
another origin cannot read that HTML, so it cannot get the token. Browser
JavaScript cannot set a header on a WebSocket handshake, so the socket carries
the token as a subprotocol rather than a query parameter: a subprotocol stays
out of the request line, so it does not reach an access log or an address the
member copies.

**What the daemon refuses.**

- Any request with an `Origin` that is not the server's own address — 403.
- Any request a browser marks as other than `same-origin` in `Sec-Fetch-Site`
  — 403. A static file also allows `none`, which is a navigation the member
  starts.
- Any request with no token, or with a token from another run — 401.
- Any change with a content type that is not `application/json` — 415. This
  alone stops the `<form enctype="text/plain">` vector, because a request that
  must be JSON is always preflighted and there is no answer to a preflight.
- Any `/ws` handshake that fails the same origin and token checks.

There are no CORS headers on any answer, and the room page is served
`no-store`, `nosniff`, `X-Frame-Options: DENY`, and a content security policy
with `frame-ancestors 'none'`.

**Upgrade.** The policy is fail closed. A `.saw/daemon.json` written by an
older version holds no token, and an older `saw` on the PATH presents none.
Both are refused. An MCP tool answers with the reason and the repair; a hook
stays silent and exits 0, exactly as it does when the daemon is down, because
a hook must never break the member's coding tool.

Hooks and MCP tools read `.saw/daemon.json` on every call, so a new run of
`saw up` repairs a stale or absent token with no other step. Only an older
`saw` binary needs the coding tool to start again, because the coding tool
spawns `saw mcp` and `saw hook` itself.

A room page left open across a restart holds the token of the run that is
gone, so its socket can never open again. When a socket fails to open, the
page asks for itself again: a different token in the answer means a new run,
and the page loads again to pick the token up. No answer at all means the
daemon is down, and the page keeps retrying with what it has.

## Git conventions (documented in AGENT.md, not enforced by CLI)

- Each agent works only on branches with its member's prefix
  (`alice/...`).
- Push to the existing remote; never force-push another member's branch.
- Merges are negotiated in the room (`decision` message closes the
  question), then performed by a human or the claiming agent locally.
