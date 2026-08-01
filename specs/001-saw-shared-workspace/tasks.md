# Tasks: SAW Shared Workspace

**Input**: Design documents from `/specs/001-saw-shared-workspace/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included where the constitution mandates them (boundary-rejection
contract tests, automatic-log verification) and as one integration test per
user story mapped to quickstart.md scenarios. No full TDD.

**Organization**: Tasks are grouped by user story so each story is an
independently testable increment.

## Ownership

Work is split by package. Assignments live on the GitHub issues (#1–#53,
numbers match task IDs); this table mirrors them for `/speckit-implement`.

| Owner | Tasks | Scope |
|-------|-------|-------|
| @aaudemarspiguet | T001–T003, T005–T014, T022–T024, T032–T033, T041, T045 | Repo setup, `packages/shared`, `packages/relay` |
| partner (friend's GitHub handle TBD) | T004, T015–T021, T025–T030, T034–T040, T042–T043, T046 | `packages/cli` (daemon, MCP, hooks, web). T004 moved here: it creates the `packages/cli` scaffold, which only the cli owner may write. Reassign issue #4. |
| joint (pair or split at the time) | T031, T038, T044, T047, T048–T053 | Integration tests + polish |

**Rule for `/speckit-implement` runs**: execute only the invoking member's
tasks. Do not create or modify files in the other member's package.
`packages/shared` is frozen after T010 lands on `main`; change it only via
a PR both members approve.

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
- [ ] T004 [P] Initialize `packages/cli/` package: `package.json` (bin `saw`, deps: `commander`, `ws`, `@modelcontextprotocol/sdk`), `tsconfig.json`, `src/index.ts`
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
- [ ] T015 [P] `.saw/` config + credential read/write in `packages/cli/src/config.ts`
- [ ] T016 [P] STE-written `AGENT.md` template (five tools, five message types, claim/handoff conventions, own-branch rule, messages-and-refs-only rule, missing-ref handling: when a received ref is not on the remote, post a `status` message that reports "ref not found" instead of failing silently) in `packages/cli/src/templates/agent-md.ts`
- [ ] T017 `saw init` + `saw invite` commands in `packages/cli/src/commands/init.ts` (git repo precondition, writes `.saw/config.json`, `.saw/credential`, `.saw/AGENT.md`, appends `.gitignore`) per contracts/cli.md
- [ ] T018 `saw join` command in `packages/cli/src/commands/join.ts` (remote-URL match check, invite redemption, same three files written, STE failure messages)
- [ ] T019 Daemon relay client with reconnect/backoff + `sync` replay handling in `packages/cli/src/daemon/client.ts`
- [ ] T020 Daemon localhost HTTP API for hooks + in-memory state cache (pause, cursor, presence) in `packages/cli/src/daemon/local-api.ts`
- [ ] T021 `saw up` command skeleton in `packages/cli/src/commands/up.ts`: start daemon, connect relay, register MCP server (`claude mcp add saw -- saw mcp`), install hook entries in `.claude/settings.json`, print status

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
- [ ] T025 [P] [US1] MCP stdio server scaffold (`saw mcp` entry) in `packages/cli/src/mcp/server.ts`
- [ ] T026 [US1] `room_read` + `room_post` tools (schemas + error shape from contracts/mcp-tools.md) in `packages/cli/src/mcp/tools/room.ts`
- [ ] T027 [US1] `workspace_status` tool in `packages/cli/src/mcp/tools/status.ts`
- [ ] T028 [US1] ReadCursor tracking (last_injected_seq, unread computation) in `packages/cli/src/daemon/cursor.ts`
- [ ] T029 [US1] `SessionStart` + `UserPromptSubmit` hook entries: inject unread messages + claim/pause state as additionalContext, advance cursor, no-op cleanly when daemon is down in `packages/cli/src/hooks/inject.ts`
- [ ] T030 [US1] Read-only web room view: daemon web server in `packages/cli/src/web/server.ts` + `packages/cli/src/web/static/index.html`, `app.js`, `style.css` (live message list over daemon WebSocket)
- [ ] T031 [US1] Integration test in `tests/integration/room.test.ts`: two simulated members — intent/claim/handoff with ref; duplicate claim rejected with visible notice; smuggling body rejected and logged (SC-002, SC-005)

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
- [ ] T034 [US2] Daemon pause mirror + ordered queued delivery on resume in `packages/cli/src/daemon/pause.ts`
- [ ] T035 [US2] `PreToolUse` hook: deny with STE reason while paused, silent pass otherwise, matcher `*` in `packages/cli/src/hooks/pre-tool.ts`
- [ ] T036 [US2] Web human message box: post as `sender_kind:"human"` with optional target member (redirect) via daemon local API, in `packages/cli/src/web/static/app.js` + endpoint in `packages/cli/src/web/server.ts`
- [ ] T037 [US2] Web pause control (own member only) + presence indicators for both members in `packages/cli/src/web/static/app.js`
- [ ] T038 [US2] Integration test in `tests/integration/steering.test.ts`: redirect reaches the target daemon <5 s and injects at next turn boundary, pause blocks, resume replays queue in seq order, relay rejects `pause_set` naming the peer (FR-013/014, SC-006)

**Checkpoint**: Room + human steering both work independently.

---

## Phase 5: User Story 3 - Every agent run is logged automatically (Priority: P3)

**Goal**: Stop hook posts mechanical run summaries (what/when/why/feature)
with zero agent cooperation; humans browse and filter the log.

**Independent Test**: quickstart.md Scenario 3 — finish any agent run;
entry appears with all four fields and no manual step; log browser filters
by feature tag.

### Implementation for User Story 3

- [ ] T039 [US3] `Stop` hook run-summary composer: tool counts from transcript, branch name + head SHA + changed-file count from git (counts and git refs only — no file paths), always exit 0, in `packages/cli/src/hooks/stop.ts`
- [ ] T040 [US3] Daemon run context: record `why_trigger` at prompt-submit/injection, attach active claimed work item (or `unassigned`) in `packages/cli/src/daemon/run-context.ts`
- [X] T041 [US3] Relay `log_append` + `log_query` (filters: member, work_item, since, limit) in `packages/relay/src/log.ts`
- [ ] T042 [US3] `work_log` MCP tool in `packages/cli/src/mcp/tools/work-log.ts`
- [ ] T043 [US3] Web log browser with feature-tag filter in `packages/cli/src/web/static/app.js` + daemon endpoint in `packages/cli/src/web/server.ts`
- [ ] T044 [US3] Integration test in `tests/integration/log.test.ts`: a simulated run produces a complete entry automatically; boundary rejections appear in the log; filter by feature works (SC-003)

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
- [ ] T046 [US4] `peer_activity` MCP tool (requires `since`; returns empty arrays + honesty note when no activity) in `packages/cli/src/mcp/tools/peer-activity.ts`
- [ ] T047 [US4] Integration test in `tests/integration/peer-activity.test.ts`: peer disconnected, query answered from store; empty-window case (SC-004, FR-019)

**Checkpoint**: All four user stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T048 [P] STE documentation pass: root `README.md`, `packages/*/README.md`, code comments — short sentences, active voice, simple words (constitution)
- [ ] T049 [P] Relay self-hosting: `packages/relay/Dockerfile` + run instructions in `packages/relay/README.md` (Principle VII)
- [ ] T050 Reconnect-ordering integration test (24 h-offline replay, 100% in order) in `tests/integration/reconnect.test.ts` (SC-007, quickstart Scenario 5)
- [ ] T051 Timing assertions in existing integration tests: redirect to target daemon <5 s, peer answer <30 s (SC-004, SC-006)
- [ ] T052 Security hardening: credential file permissions, hashed-token verification path, web server binds 127.0.0.1 only, in `packages/cli/src/config.ts`, `packages/relay/src/server.ts`, `packages/cli/src/web/server.ts`
- [ ] T053 Run full quickstart.md validation with two real clones + Claude Code; record results in `specs/001-saw-shared-workspace/quickstart-results.md`

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

- Total: 53 tasks (Setup 5, Foundational 16, US1 10, US2 7, US3 6, US4 3, Polish 6)
- The constitution's boundary gate is enforced twice: schema tests (T010) and relay enforcement (T013), both before any story ships
- Commit after each task or logical group; keep relay changes verifiable against a self-hosted run (Principle VII)
