# Quickstart: Validate SAW End-to-End

**Feature**: [spec.md](./spec.md) | **Contracts**: [contracts/](./contracts/)

This guide proves the feature works. It runs two members ("alice" and
"bob") against one relay. Use two machines, or two clones in separate
directories on one machine.

Do the three setup steps in order. Each step has a check. Do not start a
scenario until every check passes.

## Prerequisites

- Node.js 20+ and git on both member machines.
- One shared git repository with a remote both members can push to.
- Claude Code on both member machines. Scenario 1 needs a live agent on
  each side. Scenarios 3 and 4 need one on alice's side.
- A clone of this repository on the machine that runs the relay. The
  relay is not published to npm. You run it from source or from Docker.
  Step 1 shows how.

## Step 1 — Start the relay

There is no `saw-relay` package on npm. `npx saw-relay` fails with a 404.
Do not run `npx saw` either: `saw` on npm is an unrelated file-watcher by
another author, not this project.

Start the relay from a clone of this repository:

```bash
# At the repository root:
npm install
npm run dev --workspace @saw/relay
```

The relay prints the port and the database path, then stays in the
foreground. The default port is 8787. The default database is
`saw-relay.db` in the current directory. Two environment variables change
that:

| Variable         | Default        | Meaning                     |
| ---------------- | -------------- | --------------------------- |
| `SAW_RELAY_PORT` | `8787`         | TCP port to listen on       |
| `SAW_RELAY_DB`   | `saw-relay.db` | Path of the SQLite database |

```bash
# Example: a different port and a database outside the repository.
mkdir -p ~/saw
SAW_RELAY_PORT=8899 SAW_RELAY_DB=~/saw/relay.db \
  npm run dev --workspace @saw/relay
```

Make the folder first. The relay does not create it. A missing folder
stops the relay with `Cannot open database because the directory does not
exist`.

**Check**: `curl http://localhost:8787/health` answers `{"ok":true}`.
Use your port when you changed it.

Docker is the other way to run the relay. The image builds from the
repository root, because the relay uses the workspace package
`@saw/shared`:

```bash
docker build -f packages/relay/Dockerfile -t saw-relay .
docker run -d --name saw-relay -p 8787:8787 -v saw-relay-data:/data saw-relay
```

[packages/relay/README.md](../../packages/relay/README.md) is the full
reference for the relay: both run modes, the environment variables, and
the security notes. Read it before you put a relay on a network.

**One relay serves both members.** Start it once. `ws://localhost:8787`
works only for the machine that runs the relay. On two machines, give the
other member the host of the relay machine, like
`ws://relay-host.local:8787`. Use `wss://` behind TLS.

## Step 2 — Get the `saw` command on your PATH

Each member does this in their own clone. The monorepo install puts the
command at `node_modules/.bin/saw`, which is **not** on your PATH.

```bash
# At the repository root of your clone:
npm install
cd packages/cli && npm link
```

**Check**: `which saw` prints a path. `saw --help` lists the commands
`init`, `invite`, `join`, `up`, `mcp`, and `hook`.

The full path works too, if you prefer not to link. Use
`./node_modules/.bin/saw` in place of `saw` in every command below.

**Why this step matters.** Every step after this one is a `saw` command.
Without one of the two routes above, your shell answers
`command not found: saw`, and you cannot start.

`saw up` also writes your `saw` command into two places: the Claude Code
hook entries, and the MCP server registration. It resolves that command
itself. It uses the plain name `saw` when the name is on your PATH, and
the node binary plus the absolute script path when it is not. Both forms
work, so the full-path route does not cost you the hooks or the MCP
tools. Read the `mcp:` line of the `saw up` output in Step 3 and confirm
it before you start a scenario.

## Step 3 — Create the workspace and join it

```bash
# Machine A (alice) — in the repo clone
saw init --name demo --relay ws://localhost:8787 --github alice
saw invite --github bob            # prints a signed invite link
```

**Now commit and push the shared SAW config.** `saw init` lists the files
it wrote and tells you which of them to commit. Commit what it names, and
push it before bob runs `saw join`:

```bash
# Machine A (alice), still in the repo clone
git add .saw .gitignore
git commit -m "chore: add SAW workspace config"
git push
```

`git add .saw` is safe. Git ignores your credential and your other
member-local files, so this command stages the shared config only. It
cannot leak your token.

```bash
# Machine B (bob) — in a clone of the same repository
git pull                           # gets the shared SAW config
saw join "<invite-link>" --github bob
```

**Do not skip the commit and push.** `saw join` reads the relay URL from
the shared config in bob's clone. Without that file, join has no URL. It
falls back to `ws://localhost:8787`. When your relay runs on any other
port or host, join then stops with:

```
saw: join failed: the relay is not reachable
```

That message is misleading. It does not mean your relay is down. It means
join looked at the default address and found nothing there. Do not debug
a healthy relay. Push the config, run `git pull` in bob's clone, and join
again.

The other way is to pass the URL by hand. Use this when the config is not
committed yet, or when the two members use different relay hosts:

```bash
saw join "<invite-link>" --github bob --relay ws://relay-host.local:8787
```

Then start the stack on both machines:

```bash
saw up
```

**Two clones on one machine**: give each member a different web port,
because both stacks bind the same address. The second `saw up` on the
same port stops with an `EADDRINUSE` error.

```bash
saw up --port 7420      # alice
saw up --port 7421      # bob
```

Expected: each `saw up` prints a block like this, with `connected` on the
relay line and both members listed once the second member is up.

```
Starting SAW for "demo" (bob)...
SAW is up for "demo".
  member:  bob
  relay:   ws://localhost:8787 — connected
  members: bob (online), alice
  web:     http://localhost:7421
  hooks:   installed SessionStart, UserPromptSubmit, PreToolUse, Stop (…)
  mcp:     registered with Claude Code and connected
```

**Read the `mcp:` line.** It must end with `connected`. `saw up` adds the
server, then asks Claude Code whether the server really starts, so this
line reports the truth and not the intent. Two other answers are fine:
`already registered with Claude Code and connected`, and
`re-registered with Claude Code and connected …`.

Anything else stops you here. `not registered: the claude CLI is not on
PATH` means Claude Code is missing on this machine. `NOT working (…).
Your agent has no SAW tools` means the server does not answer; the line
prints the `claude mcp add` command to run by hand. Do not start
Scenario 1 until this line says `connected`. Without it the agent has no
SAW tools, and Scenarios 1, 3, and 4 fail in a way that looks like a bug
in SAW.

Open the web page of each member. Both pages show alice and bob, with
presence dots live. (Covers cli.md contract; SC-001: this setup fits in
15 minutes.)

## Scenario 1 — Room coordination (User Story 1, P1)

1. In alice's Claude Code session, ask the agent to announce work: it
   calls `room_post` `{type:"intent", body:"I will take the login form",
   work_item:"login-form"}`.
2. Expected: message appears in both web UIs within 5 s; bob's next agent
   turn receives it via hook injection (`UserPromptSubmit`).
3. Alice's agent pushes branch `alice/login-form`, then posts a `handoff`
   with ref `{kind:"branch", value:"alice/login-form"}`.
4. Expected: bob's agent can `git fetch` that branch from the remote. The
   ref crossed through SAW; the code crossed only through git.

**Boundary check (SC-005)**: have an agent (or `wscat`) post a body
containing a 30-line fenced code block or a unified diff. Expected:
`post_rejected` with `content_smuggling`, a BoundaryRejection entry in the
log browser, and the payload not stored. Repeat with the diff in `work_item`
and in `target`; both are checked too.

Then send the same diff in a `log_append` — in `why_trigger`, in
`work_item`, and as a key of `what.tools_used`. A log entry is **scrubbed**,
not refused (FR-008): expect `log_ok` carrying a `redacted` entry per field,
a BoundaryRejection per removal, and the run itself present in the log
browser with the content gone. A run must never be lost to the check
(FR-015).

**Claim conflict (FR-006a)**: have bob's agent post an intent claiming
`login-form` while alice holds it. Expected: `claim_result
{granted:false}`, a `claim_rejected` notice visible in both web UIs.

## Scenario 2 — Human steering and pause (User Story 2, P2)

1. In bob's web UI message box, send a redirect targeted at alice's agent:
   "Stop the parser. Switch to the API."
2. Expected: message visible in both UIs instantly; alice's agent receives
   it as injected context on its next turn (<5 s delivery to daemon,
   SC-006).
3. Alice clicks **Pause** in her own UI. Expected: alice's next agent tool
   call is denied by the PreToolUse hook with the SAW pause message; the
   room shows alice as paused.
4. Bob posts two messages while alice is paused. Alice clicks **Resume**.
   Expected: both messages inject on alice's next turn, in order (FR-014).
5. Negative test: bob's UI must not offer pause for alice; a forged
   `pause_set` for another member is rejected by the relay (FR-013).

## Scenario 3 — Automatic run log (User Story 3, P3)

1. Run any short task in alice's Claude Code session and let it finish.
2. Expected: within seconds of Stop, a new RunLogEntry appears in both log
   browsers with: what (tool counts, branch, head SHA, files-changed
   count), when (start/end), why (the triggering prompt or room message +
   the claimed work item, or `unassigned`) — with zero manual steps
   (SC-003).
3. Filter the log browser by `login-form`. Expected: only entries tagged
   to that work item.

## Scenario 4 — Peer activity while offline (User Story 4, P4)

1. Stop bob entirely: close his agent and `saw up` (bob is offline in both
   UIs).
2. In alice's Claude Code session ask: "What did bob's agent do today?"
   The agent calls `peer_activity {since:<today>}`.
3. Expected: a correct answer from stored history (bob's runs and
   messages), returned in <30 s, with `peer_online:false` (SC-004).
4. Ask about a window with no activity. Expected: the agent reports "no
   recorded activity" — it must not invent activity.

## Scenario 5 — Reconnect ordering (SC-007)

1. With bob offline, alice posts several messages over a few minutes.
2. Start bob's `saw up` again. Expected: bob's daemon `sync` replays 100%
   of the missed messages in `seq` order; his next agent turn receives
   them all.

## Pass criteria

All five scenarios behave as stated; every acceptance scenario in
[spec.md](./spec.md) maps to one of them; no scenario requires SAW to move
anything between members except JSON messages and git refs.

Record the outcome in [quickstart-results.md](./quickstart-results.md).
Say which surfaces you drove, and name every step you did not do.
