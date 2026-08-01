# Quickstart: Validate SAW End-to-End

**Feature**: [spec.md](./spec.md) | **Contracts**: [contracts/](./contracts/)

This guide proves the feature works. It runs two members ("alice" and
"bob") against one relay. Use two machines, or two clones in separate
directories on one machine.

## Prerequisites

- Node.js 20+ and git on both member machines.
- One shared git repository with a remote both members can push to.
- Claude Code installed for at least one member (hooks scenarios).
- A relay: `npx saw-relay` locally, or any self-hosted instance
  (contracts/relay-protocol.md).

## Setup

```bash
# Machine A (alice) — in the repo clone
saw init --name demo --relay ws://localhost:8787 --github alice
saw invite --github bob            # prints a signed invite link
saw up                             # daemon + MCP + hooks + web UI

# Machine B (bob) — in a clone of the same repo
saw join "<invite-link>" --github bob
saw up
```

Expected: both `saw up` outputs show `relay: connected` and both members
listed. Both web UIs at `http://localhost:7420` show alice and bob, with
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
log browser, and the payload not stored.

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
