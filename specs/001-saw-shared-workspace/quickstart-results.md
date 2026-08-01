# Quickstart Validation Results (T053)

**Date**: 2026-08-01 · **Runner**: @shreyk2 (scripted) · **Result**: 25/25 checks pass

## How this run worked

One machine, two real clones of one bare remote, one relay process — the
one-machine variant that quickstart.md permits. The run used the real
surfaces end to end:

- the real `saw` CLI for `init`, `invite`, `join`, and two `saw up` stacks;
- the real localhost APIs that the web page and the MCP tools call;
- the real hook entry points (`saw hook pre-tool`, `saw hook stop`) with
  JSON piped on stdin the way Claude Code sends it;
- real git for the handoff branch (`git push` in one clone,
  `git fetch` of the ref in the other).

**Caveats, stated plainly**: no live Claude Code session drove the agents —
hook inputs were piped, and posts came through the daemon API that the MCP
tools call. The MCP stdio surface itself was verified separately with a raw
JSON-RPC probe (initialize, tools/list, and calls to all five tools). A
two-machine re-run with live Claude Code sessions on both sides is the one
step that remains open; it is a good first joint dogfood session.

## Results by scenario

| Check | Result | Measured |
|-------|--------|----------|
| Relay starts; `/health` answers | PASS | — |
| `saw init` / `invite` / `join` (STE output, committed-config pickup) | PASS | setup 0.9 s (SC-001 budget: 15 min) |
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

## Automated coverage of the same scenarios

`tests/integration/` re-runs these flows on every `npm test`:
`room.test.ts` (S1), `steering.test.ts` (S2 + SC-006 timing + a forged
`pause_set` raw frame), `log.test.ts` (S3), `peer-activity.test.ts`
(S4 + SC-004 timing), `reconnect.test.ts` (S5). Full suite at the time of
this run: 56 tests, all green.

## Open item

Re-run the five scenarios with two machines and live Claude Code sessions
(the real dogfood). Check the T053 box after that session.
