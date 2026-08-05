# Tasks: SAW Shared Workspace

**Input**: Design documents from `/specs/001-saw-shared-workspace/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included where the constitution mandates them (boundary-rejection
contract tests, automatic-log verification) and as one integration test per
user story mapped to quickstart.md scenarios. No full TDD.

**Organization**: Tasks are grouped by user story so each story is an
independently testable increment.

## Ownership

Work is split by package. **This table is the authority on ownership.** The
GitHub issues carry the same assignment where one is set, but most issues
predate that practice and have no assignee, so do not read an unassigned
issue as unowned.

Issue numbers match task IDs for T001–T053 only. After that they diverge:
**T054 is #56**, **T055 is #57**, **T056 is #60**, **T057 is #61**,
**T060 is #65**, **T061–T067 are #67–#73**, and **T070–T073 are #74–#77**.
T058 and T059 have no issue: they landed in the pull request that added them.

| Owner | Tasks | Scope |
|-------|-------|-------|
| @aaudemarspiguet | T001–T003, T005–T014, T022–T024, T032–T033, T041, T045, T049, T052, T054, T058–T059, T070–T073 | Repo setup, `packages/shared`, `packages/relay` |
| @shreyk2 | T004, T015–T021, T025–T030, T034–T040, T042–T043, T046, T055–T057, T061–T067 | `packages/cli` (daemon, MCP, hooks, web). T004 moved here: it creates the `packages/cli` scaffold, which only the cli owner may write. Reassign issue #4. |
| joint (pair or split at the time) | T031, T038, T044, T047, T048, T050, T051, T053, T060 | Integration tests + polish that genuinely spans both packages |

**Rule for `/speckit-implement` runs**: execute only the invoking member's
tasks. Do not create or modify files in the other member's package.
`packages/shared` is frozen after T010 lands on `main`; change it only via
a PR both members approve. CODEOWNERS alone does not enforce that — it
requires approval from **any one** listed owner. The "both approve" rule
needs branch protection with a required-approvals count.

**On the joint bucket**: a task belongs there only if it cannot be done
inside one package. Two were misfiled, which put them in direct conflict
with the rule above — the owner of `packages/cli` could not execute either
without breaking it (`/speckit-analyze` finding I1). Both move to
@aaudemarspiguet:

- **T049** was always scoped to `packages/relay` alone.
- **T052** spanned both packages until T056 and T057 took the
  `packages/cli` half. What remains is the relay hashed-token path.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)

## Path Conventions

Monorepo per plan.md: `packages/shared/`, `packages/relay/`,
`packages/cli/`, root `tests/integration/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Monorepo skeleton that everything else builds inside

- [X] T001 Create monorepo root: `package.json` (npm workspaces), `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore` (include `.saw/credential`)
- [X] T002 [P] Initialize `packages/shared/` package: `package.json`, `tsconfig.json`, empty `src/index.ts`
- [X] T003 [P] Initialize `packages/relay/` package: `package.json` (deps: `ws`, `better-sqlite3`), `tsconfig.json`, `src/index.ts`
- [X] T004 [P] Initialize `packages/cli/` package: `package.json` (bin `saw`, deps: `commander`, `ws`, `@modelcontextprotocol/sdk`), `tsconfig.json`, `src/index.ts`
- [X] T005 [P] Configure ESLint + Prettier at root: `eslint.config.js`, `.prettierrc`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared schemas, relay core, workspace membership, and daemon
skeleton. No user story works without these.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T006 [P] Message + GitRef zod schemas in `packages/shared/src/messages.ts`: five type enum, body ≤4000, refs 0–10, branch/commit format rules, smuggling heuristics (data-model.md §Boundary rules)
- [X] T007 [P] Relay WebSocket frame schemas (client→relay and relay→client kinds) in `packages/shared/src/frames.ts` per contracts/relay-protocol.md
- [X] T008 [P] RunLogEntry + BoundaryRejection schemas in `packages/shared/src/log.ts`
- [X] T009 [P] Invite mint/verify helpers (base64url payload + HMAC-SHA256, expiry, nonce) in `packages/shared/src/invite.ts`
- [X] T010 Boundary contract tests in `packages/shared/tests/boundary.test.ts`: accept the five types and valid refs; reject unknown type, invalid ref, oversize body, code fences >20 lines, diff markers, long base64 (constitution gate: rejection of non-conforming payloads)
- [X] T011 SQLite store (all tables from data-model.md, WAL mode, gapless per-workspace seq allocation) in `packages/relay/src/store.ts`
- [X] T012 WebSocket server + `hello` auth (token hash check; sender identity bound to connection, never client-claimed) in `packages/relay/src/server.ts`
- [X] T013 Relay boundary enforcement (validate every frame with shared schemas; write BoundaryRejection without echoing payload; send `post_rejected`/`error`) in `packages/relay/src/boundary.ts`
- [X] T014 Workspace registration, invite mint, and join redemption (single-use nonce, expiry, 2-member cap, bearer token issue + hash storage) in `packages/relay/src/join.ts`
- [X] T015 [P] `.saw/` config + credential read/write in `packages/cli/src/config.ts`
- [X] T016 [P] STE-written `AGENT.md` template (five tools, five message types, claim/handoff conventions, own-branch rule, messages-and-refs-only rule, missing-ref handling: when a received ref is not on the remote, post a `status` message that reports "ref not found" instead of failing silently) in `packages/cli/src/templates/agent-md.ts`
- [X] T017 `saw init` + `saw invite` commands in `packages/cli/src/commands/init.ts` (git repo precondition, writes `.saw/config.json`, `.saw/credential`, `.saw/AGENT.md`, appends `.gitignore`) per contracts/cli.md
- [X] T018 `saw join` command in `packages/cli/src/commands/join.ts` (remote-URL match check, invite redemption, same three files written, STE failure messages)
- [X] T019 Daemon relay client with reconnect/backoff + `sync` replay handling in `packages/cli/src/daemon/client.ts`
- [X] T020 Daemon localhost HTTP API for hooks + in-memory state cache (pause, cursor, presence) in `packages/cli/src/daemon/local-api.ts`
- [X] T021 `saw up` command skeleton in `packages/cli/src/commands/up.ts`: start daemon, connect relay, register MCP server (`claude mcp add saw -- saw mcp`), install hook entries in `.claude/settings.json`, print status

**Checkpoint**: Two members can init/join a workspace and both daemons hold
authenticated relay connections. User story phases can start.

---

## Phase 3: User Story 1 - Agents coordinate work in a shared room (Priority: P1) 🎯 MVP

**Goal**: Agents exchange the five typed messages with refs, claim and hand
off work; both humans can read the full history.

**Independent Test**: quickstart.md Scenario 1 — intent → claim → handoff
with a branch ref between two live members; smuggling payload rejected;
duplicate claim rejected visibly.

### Implementation for User Story 1

- [X] T022 [US1] Relay message flow: accept `post`, assign seq, persist, broadcast `message` frames in order in `packages/relay/src/messages.ts`
- [X] T023 [US1] Claim resolution in seq order (first wins; `claim_result` broadcast to both members; WorkItem state transitions from data-model.md) in `packages/relay/src/claims.ts`
- [X] T024 [US1] `sync` request handling: replay missed messages ≥ since_seq in order in `packages/relay/src/sync.ts`
- [X] T025 [P] [US1] MCP stdio server scaffold (`saw mcp` entry) in `packages/cli/src/mcp/server.ts`
- [X] T026 [US1] `room_read` + `room_post` tools (schemas + error shape from contracts/mcp-tools.md) in `packages/cli/src/mcp/tools/room.ts`
- [X] T027 [US1] `workspace_status` tool in `packages/cli/src/mcp/tools/status.ts`
- [X] T028 [US1] ReadCursor tracking (last_injected_seq, unread computation) in `packages/cli/src/daemon/cursor.ts`
- [X] T029 [US1] `SessionStart` + `UserPromptSubmit` hook entries: inject unread messages + claim/pause state as additionalContext, advance cursor, no-op cleanly when daemon is down in `packages/cli/src/hooks/inject.ts`
- [X] T030 [US1] Read-only web room view: daemon web server in `packages/cli/src/web/server.ts` + `packages/cli/src/web/static/index.html`, `app.js`, `style.css` (live message list over daemon WebSocket)
- [X] T031 [US1] Integration test in `tests/integration/room.test.ts`: two simulated members — intent/claim/handoff with ref; duplicate claim rejected with visible notice; smuggling body rejected and logged (SC-002, SC-005)

**Checkpoint**: MVP — two agents coordinate through the room; humans can
read everything.

---

## Phase 4: User Story 2 - Humans steer and pause agents (Priority: P2)

**Goal**: Either human posts redirects from the web UI; each human can
pause/resume their own agent; paused agents are blocked and messages queue.

**Independent Test**: quickstart.md Scenario 2 — redirect reaches target
agent's next turn; pause denies tool calls; queued messages deliver in
order on resume; forged pause for the peer is rejected.

### Implementation for User Story 2

- [X] T032 [US2] Relay pause handling: `pause_set` (own member only), PauseState persistence, hold undelivered messages for paused members in `packages/relay/src/pause.ts`
- [X] T033 [P] [US2] Relay presence tracking (ping/pong liveness, `presence` broadcasts) in `packages/relay/src/presence.ts`
- [X] T034 [US2] Daemon pause mirror + ordered queued delivery on resume in `packages/cli/src/daemon/pause.ts`
- [X] T035 [US2] `PreToolUse` hook: deny with STE reason while paused, silent pass otherwise, matcher `*` in `packages/cli/src/hooks/pre-tool.ts`
- [X] T036 [US2] Web human message box: post as `sender_kind:"human"` with optional target member (redirect) via daemon local API, in `packages/cli/src/web/static/app.js` + endpoint in `packages/cli/src/web/server.ts`
- [X] T037 [US2] Web pause control (own member only) + presence indicators for both members in `packages/cli/src/web/static/app.js`
- [X] T038 [US2] Integration test in `tests/integration/steering.test.ts`: redirect reaches the target daemon <5 s and injects at next turn boundary, pause blocks, resume replays queue in seq order, relay rejects `pause_set` naming the peer (FR-013/014, SC-006)

**Checkpoint**: Room + human steering both work independently.

---

## Phase 5: User Story 3 - Every agent run is logged automatically (Priority: P3)

**Goal**: Stop hook posts mechanical run summaries (what/when/why/feature)
with zero agent cooperation; humans browse and filter the log.

**Independent Test**: quickstart.md Scenario 3 — finish any agent run;
entry appears with all four fields and no manual step; log browser filters
by feature tag.

### Implementation for User Story 3

- [X] T039 [US3] `Stop` hook run-summary composer: tool counts from transcript, branch name + head SHA + changed-file count from git (counts and git refs only — no file paths), always exit 0, in `packages/cli/src/hooks/stop.ts`
- [X] T040 [US3] Daemon run context: record `why_trigger` at prompt-submit/injection, attach active claimed work item (or `unassigned`) in `packages/cli/src/daemon/run-context.ts`
- [X] T041 [US3] Relay `log_append` + `log_query` (filters: member, work_item, since, limit) in `packages/relay/src/log.ts`
- [X] T042 [US3] `work_log` MCP tool in `packages/cli/src/mcp/tools/work-log.ts`
- [X] T043 [US3] Web log browser with feature-tag filter in `packages/cli/src/web/static/app.js` + daemon endpoint in `packages/cli/src/web/server.ts`
- [X] T044 [US3] Integration test in `tests/integration/log.test.ts`: a simulated run produces a complete entry automatically; boundary rejections appear in the log; filter by feature works (SC-003)

**Checkpoint**: All activity is recorded with what/when/why/feature.

---

## Phase 6: User Story 4 - Ask about a teammate's agent, even offline (Priority: P4)

**Goal**: `peer_activity(since)` answers from relay-stored history while
the peer is fully offline; empty windows answered honestly.

**Independent Test**: quickstart.md Scenario 4 — peer offline; question
answered from stored runs + messages in <30 s; empty window returns "no
recorded activity".

### Implementation for User Story 4

- [X] T045 [US4] Relay peer-activity query (runs + peer messages in window, `peer_online` flag, independent of peer connection) extending `packages/relay/src/log.ts`
- [X] T046 [US4] `peer_activity` MCP tool (requires `since`; returns empty arrays + honesty note when no activity) in `packages/cli/src/mcp/tools/peer-activity.ts`
- [X] T047 [US4] Integration test in `tests/integration/peer-activity.test.ts`: peer disconnected, query answered from store; empty-window case (SC-004, FR-019)

**Checkpoint**: All four user stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T048 [P] STE documentation pass: root `README.md`, `packages/*/README.md`, code comments — short sentences, active voice, simple words (constitution)
- [ ] T049 [P] Relay self-hosting: `packages/relay/Dockerfile` + run instructions in `packages/relay/README.md` (Principle VII)
- [ ] T050 Reconnect-ordering integration test (24 h-offline replay, 100% in order) in `tests/integration/reconnect.test.ts` (SC-007, quickstart Scenario 5)
- [ ] T051 Timing assertions in existing integration tests: redirect to target daemon <5 s, peer answer <30 s (SC-004, SC-006)
- [ ] T052 Hashed-token verification path in `packages/relay/src/server.ts` and `packages/relay/src/store.ts`: store a hash of each member credential, not the credential itself. (Scope reduced — see the note below. The credential-at-rest and local-surface halves are now T056 and T057.)
- [ ] T053 Run full quickstart.md validation with two real clones + Claude Code; record results in `specs/001-saw-shared-workspace/quickstart-results.md`

### Added after the first `/speckit-analyze` pass

Both close gates that the original 53 tasks left open. See the analysis
findings referenced on each line.

- [X] T054 Content-validate every payload-bearing relay frame, not only `post` (`log_append.why_trigger` and `what.branch` cross the member boundary unchecked): extend `parseClientFrame` in `packages/relay/src/boundary.ts`, write a BoundaryRejection for a rejected append, and extend the T010 contract tests in `packages/shared/tests/boundary.test.ts` (FR-008, SC-005, Principle II — analyze D1, issue #56)
- [ ] T055 [US3] Durable local log spool in `.saw/`: persist unsent run entries when the relay is unreachable, drain on reconnect keeping original `started_at`/`ended_at`, bound the spool size; add an integration test that fires the Stop hook against a dead relay in `packages/cli/src/daemon/` + `tests/integration/log.test.ts` (FR-015, SC-003, Principle IV — analyze C1, issue #57)
- [ ] T056 Protect the credential at rest on every supported platform, and report plainly when it cannot: `packages/cli/src/config.ts`. Windows cannot express the restriction through permission bits, so use that platform's own access control. Replace the mode-only assertion in `packages/cli/tests/config.test.ts` with a platform-aware check — it fails on Windows today (FR-020, SC-008 — analyze U1)
- [ ] T057 Authenticate the local surface: `packages/cli/src/web/server.ts` (HTTP + the `/ws` push channel) and `packages/cli/src/daemon/local-api.ts`, with matching changes in the callers that must present proof — `packages/cli/src/mcp/call.ts` and `packages/cli/src/hooks/io.ts`. Reads need the same protection as changes: the `/ws` snapshot leaks the whole room (FR-021, SC-009 — analyze U1)

**Note on T052**: FR-020 and FR-021 now own the credential-protection and
local-surface scope that T052 listed without acceptance criteria. T056 and
T057 are the tracking tasks for both. T052 keeps only the relay hashed-token
verification path.

### Added after the second `/speckit-analyze` pass

- [ ] T060 Tell a real "why" from a stand-in in the work log (FR-016a, SC-010 — analyze U2, issue #65). The Stop hook writes `"run with no recorded trigger"` when it captured no prompt, and the relay now writes `[removed at the boundary]` when it took one out. Both read as if they were the reason. Record which case applies alongside the text — `packages/shared/src/log.ts` (the stored entry), `packages/cli/src/daemon/run-context.ts` and `packages/cli/src/hooks/stop.ts` (the capture side), `packages/cli/src/web/` (show it). Joint: the field is in the frozen `packages/shared`, so it needs a PR both members approve

### Added after the review of PR #54

Raised by @shreyk2 in the PR description. Both are `packages/relay`, so they
are @aaudemarspiguet's to do. Neither has its own issue: they landed in the
same pull request that added these lines.

- [X] T058 Handle `error` on relay sockets and on the WebSocket server in `packages/relay/src/server.ts`. An unhandled `error` event ends the relay process, so one member's broken connection stops the other member from working. Includes the shutdown ordering that surfaced with it: drop live sockets before the store closes, so a closing socket cannot query a closed database (FR-013)
- [X] T059 Return the workspace `repo_remote` from `POST /join` in `packages/relay/src/join.ts`. `contracts/cli.md` makes a matching remote a precondition of `saw join`, but the joiner had no way to learn what to match against (Principle VI)

### Added after the review of PR #54 and PR #63

Found by reviewing the built system, not by a gate. The first group is
`packages/cli` (@shreyk2, issues #67–#73). The second group is the boundary
and the artifacts that describe it (@aaudemarspiguet, issues #74–#77).

- [ ] T061 Make the relay the only source of the post verdict in `packages/cli/src/daemon/local-api.ts`: the `/api/post` route calls `daemon.post()` even when the local `validatePost` fails, so a payload the relay accepts still reaches the peer, the local room cache, and the web page while the caller is told 422 rejected; answer from the local check alone and never send, and cover the split verdict with a test (FR-006, FR-006a, Principle II — review of PR #54)
- [ ] T062 [US3] Key the run context by Claude Code session id: `packages/cli/src/daemon/run-context.ts` keeps one daemon-global `startedAt`/`whyTrigger` pair and `packages/cli/src/hooks/stop.ts` drops the session id that contracts/hooks-adapter.md §4 says it reads, so with two sessions in one repo the first Stop consumes the trigger and the second logs "run with no recorded trigger" with a wrong `started_at`; thread `session_id` through `packages/cli/src/hooks/inject.ts`, `/api/inject` and `/api/run/stop` in `packages/cli/src/daemon/local-api.ts`, and expire idle contexts (FR-015, FR-016, SC-003, Principle IV — review of PR #54)
- [ ] T063 Stop the daemon reporting itself alive when it is not, in `packages/cli/src/daemon/client.ts` and `packages/cli/src/config.ts`: settle pending post/append/query promises on an `error` frame instead of stalling the caller for the full 10 s `REQUEST_TIMEOUT_MS`; make `auth_failed` loud — wire `onServerError` in `packages/cli/src/daemon/daemon.ts`, report it through `/api/health` and `saw up`, and stop `packages/cli/src/commands/up.ts` printing "retrying in the background" when nothing will retry; and check the recorded pid is alive in `readDaemonInfo` so a stale `.saw/daemon.json` cannot point hooks and MCP tools at whatever process now owns the port (FR-012, FR-013, SC-006, SC-007 — review of PR #54)
- [ ] T064 Validate query parameters and report the true failure in `packages/cli/src/daemon/local-api.ts`: `Number()` on a non-numeric `limit` or `since_seq` yields NaN and returns an empty list instead of 400, and every `/api/log` and `/api/peer-activity` failure is reported as `not_connected`, which hides timeouts and relay errors from `work_log` and `peer_activity`; reject bad numbers with `invalid_input` and map the real error code through (contracts/mcp-tools.md error shape — review of PR #54)
- [ ] T065 Write the hook entries into the git-ignored `.claude/settings.local.json` instead of the tracked `.claude/settings.json` in `packages/cli/src/hooks/install.ts`, so one member's `saw up` does not produce a diff that pushes hook config at the other; amend `specs/001-saw-shared-workspace/contracts/hooks-adapter.md` (the contract names `settings.json` in two places), keep the ignore lines in `packages/cli/src/config.ts` consistent, and update `packages/cli/tests/install.test.ts` (Principle II rationale, FR-009/FR-010 intent — review of PR #54)
- [ ] T066 Filter the room by work item: a selector in `packages/cli/src/web/static/app.js` + `index.html` over the existing snapshot, an optional `work_item` query parameter on `/api/messages` in `packages/cli/src/daemon/local-api.ts`, and an optional `work_item` input on `room_read` in `packages/cli/src/mcp/tools/room.ts`; `work_item` is already carried on `MessagePostSchema` and `StoredMessage`, so frozen `packages/shared` does not change (FR-016 feature filtering, FR-011a — product direction: a work item you can watch and talk to)
- [ ] T067 Teach the agent to raise a conflicting steer with its own human instead of complying silently or ignoring it: add a "when a message conflicts with your plan" section to `packages/cli/src/templates/agent-md.ts` and one framing line on the prompt-submit path in `packages/cli/src/hooks/inject.ts` (which today injects the message list with no preamble), and update `packages/cli/tests/agent-md.test.ts` (Principle III human accountability, FR-012 — product direction: stakeholders steer through the other member's agent)

- [ ] T070 [P] Content-check every free-text field that still crosses the boundary unchecked: the keys of `what.tools_used` and `work_item` on a log entry in `validateLogEntry`, `work_item` and `target` on a post in `validatePost`, and set a `maxPayload` on the relay WebSocket server; write a BoundaryRejection for each removal and add adversarial cases to `packages/shared/tests/boundary.test.ts`. T054 closed `why_trigger` only, so the SC-005 "100%" claim and the plan.md Constitution Check row II do not hold until this lands or the claim is qualified (FR-008, SC-005, Principle II — review of PR #63)
- [ ] T071 Sync the boundary artifacts to scrub-don't-refuse semantics: `spec.md` FR-008 (line 212) and SC-005 (line 318) still say "reject", and `data-model.md` §Boundary rules (line 169) still describes reject-only, `body`-only validation "applied identically at daemon (outbound) and relay (inbound)", which makes the "rules mirrored in data-model.md" line in `contracts/relay-protocol.md` (line 65) false after T054 (FR-008, SC-005, Principle II — review of PR #63)
- [ ] T072 [P] Correct the `log_ok` row of the Relay → client frame table in `specs/001-saw-shared-workspace/contracts/relay-protocol.md` (line 46): the payload is `{ id, redacted? }`, and each `redacted` entry carries `field`, `reason`, and `summary`, not `{ id }` as the table says and not field-and-reason as the prose below says (review of PR #63)
- [ ] T073 [US3] Keep the run when a `log_append` fails the schema: `validateLogEntry` runs only after `ClientFrameSchema` parse (`packages/relay/src/boundary.ts:32-52`), so an over-limit `why_trigger` (1000 chars) or `work_item` (100 chars) refuses the whole entry — `post_rejected` is sent and a BoundaryRejection is logged, but the run is never stored, against the FR-015 reasoning that T054 wrote into the code and the contract; salvage or truncate the entry, report `payload_too_large` instead of `not_json`, and cover it in `packages/relay/tests/relay.test.ts` and `packages/shared/tests/boundary.test.ts` (FR-015, SC-003, Principle IV — review of PR #63)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none — start immediately
- **Foundational (Phase 2)**: needs Phase 1 — BLOCKS all user stories
- **US1 (Phase 3)**: needs Phase 2
- **US2 (Phase 4)**: needs Phase 2; delivery/queue tests reuse US1 message flow (T022) — implementable in parallel with US1 after T022 lands
- **US3 (Phase 5)**: needs Phase 2; `why_trigger` capture (T040) touches the injection path from T029
- **US4 (Phase 6)**: needs T041 (log storage/query) from US3
- **Polish (Phase 7)**: needs all desired stories complete
- **T054**: needs T013 (relay boundary) and T010 (contract tests) — extends both
- **T055**: needs T039/T040 (the Stop-hook path it makes durable)
- **T056**: needs T015 (`.saw/` credential write path it hardens)
- **T057**: needs T020/T030 (the local API and web server it authenticates)
- **T058, T059**: need T013 (the relay server and join path they correct) — both done

### Within Phase 2

- T006–T009 [P] → T010 (tests need schemas)
- T011 → T012 → T013/T014 (store before server before enforcement/join)
- T015/T016 [P] → T017 → T018
- T019 → T020 → T021

### Within stories

- US1: T022 → T023/T024; T025 → T026/T027; T028 → T029; T030 after T022; T031 last
- US2: T032 → T034 → T035; T036 → T037; T038 last
- US3: T040 before T039 completes the "why"; T041 → T042/T043; T044 last
- US4: T045 → T046 → T047

### Parallel Opportunities

- Phase 1: T002–T005 together
- Phase 2: T006–T009 together; T015/T016 alongside relay work (different packages)
- After Phase 2: US1 relay tasks (T022–T024) and US1 MCP tasks (T025–T027) are different packages — two workers can split them
- US2: T033 parallel to T032; US3: web (T043) parallel to MCP (T042)

---

## Parallel Example: Foundational schemas

```bash
# Launch T006–T009 together (independent files in packages/shared):
Task: "Message + GitRef zod schemas in packages/shared/src/messages.ts"
Task: "Relay frame schemas in packages/shared/src/frames.ts"
Task: "RunLogEntry + BoundaryRejection schemas in packages/shared/src/log.ts"
Task: "Invite mint/verify helpers in packages/shared/src/invite.ts"
```

## Parallel Example: User Story 1

```bash
# After Phase 2, split by package:
Worker A (relay): T022 → T023 → T024
Worker B (cli):   T025 → T026 → T027, then T028 → T029
# Converge on T030 (web view) and T031 (integration test)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 → Phase 2 (foundation, including boundary tests T010)
2. Phase 3 (US1) → run quickstart Scenario 1
3. **STOP and VALIDATE**: two agents coordinating through the room is the
   demoable MVP

### Incremental Delivery

1. + US2 → humans steer and pause (Scenario 2)
2. + US3 → automatic log (Scenario 3)
3. + US4 → offline teammate answers (Scenario 4)
4. Polish → reconnect ordering, timings, hardening, full quickstart run

Each story lands without breaking the previous ones; checkpoints map 1:1 to
quickstart scenarios.

---

## Notes

- Total: 71 tasks (Setup 5, Foundational 16, US1 10, US2 7, US3 6, US4 3, Polish 24)
- The constitution's boundary gate is enforced twice: schema tests (T010) and relay enforcement (T013), both before any story ships. T054 closes the gap both left: they check `post` frames only, so `log_append` crosses the boundary unchecked
- The Constitution Check in plan.md records the honest post-implementation state. Row II returned to PASS when T054 landed, but T070 shows free text still crosses unchecked, so re-check row II when T070 lands. Row IV stays FAIL until T055 and T073 land; row III stays PARTIAL until T057 lands
- Commit after each task or logical group; keep relay changes verifiable against a self-hosted run (Principle VII)
