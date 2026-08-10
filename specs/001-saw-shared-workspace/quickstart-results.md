# Quickstart Validation Results (T053)

**Date**: 2026-08-01 · **Runner**: @shreyk2 (scripted) · **Result**:
25/25 scripted checks pass

> **Read this first (added 2026-08-09).** The 25/25 result below is real,
> but it is narrow. This run drove SAW through its local HTTP API and
> through the hook binaries with JSON piped on stdin. It did not set the
> product up the way a person does. A later readiness pass did set it up
> that way, and it found blockers that stopped a new pair before
> Scenario 1. This run could not have caught them, because it never
> touched the steps they live in. The scenario results stay on the page.
> The claim "SAW is ready for a new pair" does not follow from them.
> [quickstart.md](./quickstart.md) has the corrected setup steps.

## How this run worked

One machine, two real clones of one bare remote, one relay process — the
one-machine variant that quickstart.md permits. The run used these
surfaces:

- the `saw` CLI for `init`, `invite`, `join`, and two `saw up` stacks,
  started from a known path inside the repository checkout;
- the local HTTP API of the daemon — the same API the web page and the
  MCP tools call;
- the hook entry points (`saw hook pre-tool`, `saw hook stop`) with JSON
  piped on stdin in the shape Claude Code sends;
- real git for the handoff branch (`git push` in one clone, `git fetch`
  of the ref in the other).

## What this run did not exercise

Each item below is a step a real pair must complete. The script either
skipped it or arranged it in advance.

- **How the `saw` command is found.** The script called the binary from a
  path it already knew. It never proved that `saw` resolves on a member's
  PATH. In a fresh monorepo install the command sits at
  `node_modules/.bin/saw` and is not on the PATH.
- **The MCP registration, and MCP as the agent's route in.** No MCP
  server was registered with Claude Code, and no agent called a SAW tool
  through MCP. Posts and reads went to the daemon HTTP API directly. The
  stdio server was probed on its own with raw JSON-RPC (initialize,
  tools/list, calls to all five tools), which proves the server answers.
  It does not prove an agent can reach it.
- **A live Claude Code session.** Hook input was piped. No agent turn ran.
  Nothing tested that injected context arrives in a real turn, or that a
  denied tool call reads clearly to an agent.
- **The commit-and-push of the shared SAW config.** The second clone got
  the config because the run put it there. A real second member gets it
  only after the first member commits and pushes it. Skip that step and
  `saw join` falls back to the default relay URL and stops with "the
  relay is not reachable", which is false and sends you to debug a
  healthy relay.
- **Getting a relay at all.** The run started the relay from this
  repository. It never followed the prerequisite the document gave the
  reader at the time (`npx saw-relay`), which fails: no such package
  exists on npm.

No script from this run survives in the repository, so the run cannot be
repeated as written.

## Results by scenario

| Check | Result | Measured |
|-------|--------|----------|
| Relay starts; `/health` answers | PASS | — |
| `saw init` / `invite` / `join` (STE output, committed-config pickup) | PASS | setup 0.9 s † |
| Reused invite refused, exit 1 | PASS | — |
| Both `saw up` stacks connect; both members online | PASS | — |
| S1 intent visible to peer daemon | PASS | 1 ms (<5 s) |
| S1 duplicate claim rejected visibly; first claim wins (FR-006a) | PASS | — |
| S1 handoff ref crosses SAW; branch fetches through git only | PASS | — |
| S1 30-line fence rejected `content_smuggling`; logged; payload never echoed (SC-005) | PASS | — |
| S2 human redirect delivered to target daemon (SC-006) | PASS | 1 ms (<5 s) |
| S2 redirect injected at next turn boundary | PASS | — |
| S2 `PreToolUse` denies while paused, exit 0; silent after resume | PASS | — |
| S2 peer sees the pause; messages held; ordered replay on resume (FR-013/014) | PASS | — |
| S3 `Stop` hook exits 0 silently; complete entry (what/when/why/feature), zero manual steps (SC-003) | PASS | why = "Redirect from …" |
| S3 log filter by feature tag | PASS | — |
| S4 peer question answered from stored history while peer offline (SC-004, FR-019) | PASS | 1 ms (<30 s) |
| S4 empty window answered honestly with empty arrays | PASS | — |
| S5 100% of missed messages replayed in seq order after restart (SC-007) | PASS | — |

† **The 0.9 s does not measure SC-001.** It measures how long three
commands take when a script runs them back to back with the relay
already up, the command already resolved, and the shared config already
in place. SC-001 asks whether a pair reaches a working room in 15
minutes. This run did not measure that, and the readiness pass later
showed a new pair does not get there from the document alone. SC-001
stays unproven until a pair runs the corrected steps end to end.

## Automated coverage of the same scenarios

`tests/integration/` re-runs these flows on every `npm test`:
`room.test.ts` (S1), `steering.test.ts` (S2 + SC-006 timing + a forged
`pause_set` raw frame), `log.test.ts` (S3), `peer-activity.test.ts`
(S4 + SC-004 timing), `reconnect.test.ts` (S5). Full suite at the time of
this run: 56 tests, all green.

These tests share this run's blind spot by design. They drive the same
local HTTP API. Green integration tests say the protocol and the daemon
behave. They say nothing about whether a person can install SAW, find the
command, and connect two members.

## Open items

1. Re-run the five scenarios from [quickstart.md](./quickstart.md) as
   written, with no shortcuts: install from the document, put `saw` on
   the PATH from the document, commit and push the shared config from the
   document.
2. Do that run on two machines with live Claude Code sessions on both
   sides, and with the MCP server registered. Confirm each agent lists
   all five SAW tools before the scenarios start.
3. Check the T053 box after step 2, and record the result here with the
   same honesty about what the run did not cover.
