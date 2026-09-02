# Tasks: SAW v1 — Threads first, then collaboration modes

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Date**: 2026-08-27

## Task numbering

Task IDs continue the repository's **global** sequence. Spec 001 used
**T001–T083**, so this file starts at **T084**. Do not renumber.

The reason is mechanical, not cosmetic. `/speckit-taskstoissues` de-duplicates
by matching `\bT\d{3}\b` against every existing issue, open and closed. A 002
file restarting at T001 would match spec 001's issues and be skipped silently,
and a `002-` prefix does not help because the word boundary still matches
`T001`. Issue titles therefore use the plain `T0NN: <description>` form.

As in 001: GitHub issues track who does what, and the checkboxes here track what
is done. When you close an issue, check off the task.

## Scope of this file

**This file covers User Story 7 and User Story 8 only**, plus the foundational
`packages/shared` rewrite they need. It is a deliberate slice, not the whole of
spec 002.

Twenty-six of the spec's forty-four functional requirements therefore have no
task here — every requirement belonging to US1 to US6. That matters because
`/speckit-implement` reads this file and would otherwise report the feature
finished with two of eight stories built. When US7 and US8 are done, run
`/speckit-converge` to append the remaining work rather than assuming this file
is complete.

## Ownership

Settled by the room `decision` at seq 12 (2026-08-30, work item
002-threads-modes), directed by shreyk2: shreyk2's agent drafts Phase 2
(the joint shared PR — aaudemarspiguet must approve as frozen-package
owner before merge), drafts the relay tasks for aaudemarspiguet's owner
review (his to reclaim on request), and owns the CLI, web, and
integration-test tasks. T141 is a joint live run. Any line is open to
dispute in the room.

**Amended 2026-09-01 (reopened by shreyk2 in the room, seq 47; claimed by
aaudemarspiguet).** The original split gave shreyk2 the CLI and web tasks
for one reason: aaudemarspiguet could not run the CLI package on his own
machine. PR #179 fixed that — `saw up` now starts an npm-installed
Claude Code on Windows, and the suite is green on both machines — so the
reason is gone and shreyk2 reopened the split. The surface and
spec-integrity tasks move:

| Owner | Tasks |
|---|---|
| aaudemarspiguet | T145, T146, T147 (phase 4b surfaces), T154 (session controls), T138 (the seven unanswered checklist questions), T161 (worktrees), T160 (readability check) |
| shreyk2 | T148–T153, T155–T159 |

The cuts fall there for three reasons rather than by halving the list:

- **T145, T146, T147 and T154 are the same file.** All four rewrite
  `packages/cli/src/web/static/` — 92 lines of HTML and 584 of JS. Split
  between two people they are merge conflicts; split across two phases
  they are rework, because T154 hangs session controls on the navigation
  T145 replaces. Phase 4b therefore lands *before* T154, not after it.
- **T138 and T160 are better done by the other side of the table.** T160
  measures the readability of the posting rules T156 rewrites, and T138
  answers questions raised in review. An author grading their own output
  is the weaker arrangement in both cases.
- **T161 is where the two machines differ.** Git worktrees are the most
  platform-sensitive work left in this spec, and the Windows half has no
  coverage. It belongs on the Windows machine.

Unchanged: the frozen-package rule. `packages/shared` still needs
aaudemarspiguet's explicit approval, which is why the phase 6 schema is a
second joint gate and not an ordinary PR.

## Tests

Test tasks are included rather than optional. The constitution's Development
Workflow gates require that tests cover rejection of non-conforming payloads,
and this spec's success criteria include adversarial ones (SC-016, SC-020).

---

## Phase 1: Setup

- [x] T084 Add a `npm test` job on `windows-latest` and `ubuntu-latest` to `.github/workflows/`, reporting but not gating, so the 205/214 Windows baseline stops being unverified (issue #108)
- [x] T085 [P] Record the pre-change test baseline in `specs/002-saw-v1/quickstart-results.md` — 218/227 on Windows as measured on this branch on 2026-08-27, with the nine known failures split as seven T081 and two T056 (issue #109)
- [x] T086 [P] Agree ownership of Phase 2 to Phase 5 in the room and record it as a `decision`, then write the agreed owner into each issue (issue #110)

> **Note**: no task in Phase 1 may edit `packages/shared`. Every change to that
> package belongs to the single joint pull request in Phase 2.

---

## Phase 2: Foundational — the `packages/shared` rewrite

**⚠ GATE: this phase lands as ONE jointly-approved pull request. No work that
depends on the `packages/shared` schema begins until it merges.** A Phase 3+
task with no schema dependency may land early — the constraint was always the
schema, not the phase number (narrowed per room seq 16, confirmed by shreyk2
on 2026-08-30; T106 and T139 landed under this reading). This is the last open
merge gate on spec 002, and User Story 7 is a schema change, so it is the
first work.

- [x] T087 Add the `Thread` entity — id, workspace_id, type, title, scope, state, created_by, created_at, migrated_from_tag — in `packages/shared/src/threads.ts` per data-model.md (issue #111)
- [x] T088 [P] Add the mode ladder — `view` < `comment` < `edit` — with its comparison helper in `packages/shared/src/modes.ts` (issue #112)
- [x] T089 Extend the message envelope in `packages/shared/src/messages.ts` with nullable `thread_id` and `force`, defaulting `force` to `advisory`; leave `MESSAGE_TYPES` unchanged (issue #113)
- [x] T090 Extend the zod boundary schemas in `packages/shared/src/messages.ts` so FR-025's checks — size caps, diff and fence detection, encoded-payload detection — apply to every new free-text field (issue #114)
- [x] T091 [P] Add the `Handoff` entity with its four states and transition rules in `packages/shared/src/threads.ts` per data-model.md (issue #115)
- [x] T092 [P] Add the pending-assignment state to the run record in `packages/shared/src/log.ts` per FR-015 (issue #116)
- [x] T093 Add the protocol version and its `NEEDS_UPGRADE` error text to every frame in `packages/shared/src/frames.ts`, treating a version-less first frame as v0, per FR-035 and contracts §2.1 (issue #117)
- [x] T094 [P] Unit tests for the thread and handoff schemas in `packages/shared/tests/` (issue #118)
- [x] T095 [P] Unit tests asserting the boundary rejects code, diffs, and encoded payloads in `thread_id`, `force`, and every new free-text field, in `packages/shared/tests/` (issue #119)
- [x] T096 Export the new surface from `packages/shared/src/index.ts` and confirm `npm run build` passes across all three packages (issue #120)

---

## Phase 3: User Story 7 — Threads replace the flat room (P1)

**Goal**: The room stops being flat. Threads are real containers at project
scope, and the v0 upgrade loses nothing.

**Independent test**: Every acceptance scenario of US7 passes with **no**
profile, invite, or FR-008 scope work done. If one needs identity, the slice
boundary is wrong.

### Store and migration

- [x] T097 [US7] Add `threads`, `thread_participants`, and `thread_refs` tables to the relay store schema in `packages/relay/src/store.ts` (issue #121)
- [x] T098 [US7] Rekey claims from workspace to thread in `packages/relay/src/claims.ts`, preserving first-claim-wins (issue #122)
- [x] T099 [US7] Write the FR-009(a) store migration in `packages/relay/src/store.ts` — one thread per historic tag, a `general` thread per workspace for untagged messages, running exactly once (issue #123)
- [x] T100 [US7] Make the migration fold tags differing only by case or surrounding space into one thread, and record the merge (issue #124)
- [x] T101 [US7] Set every migrated thread to mode `edit` for every member, and record why — v0 agents could already claim, so `comment` would remove a capability (research R3) (issue #125)
- [x] T102 [P] [US7] Integration test in `tests/integration/` asserting the migration loses zero messages and zero log entries, and that every historic tag is queryable as a thread (SC-008) (issue #126)
- [x] T103 [P] [US7] Integration test asserting the migration runs exactly once when re-invoked (issue #127)

### Routing and delivery

- [x] T104 [US7] Route messages by `thread_id` in `packages/relay/src/messages.ts`, with a null `thread_id` meaning a project broadcast (issue #128)
- [x] T105 [US7] Move delivery, cursors, and sequence numbers to per-thread streams in `packages/relay/src/sync.ts` per contracts §2.2 (issue #129)
- [x] T106 [US7] Key the read cursor by coding-tool session id, not repo clone, in `packages/cli/src/daemon/cursor.ts` and `packages/cli/src/daemon/daemon.ts` — today two Claude sessions in one repo consume each other's messages; shares a root cause with T062 (#68) (issue #130)
- [x] T107 [US7] Make `RoomState` thread-aware in `packages/cli/src/daemon/state.ts` (issue #131)
- [ ] T108 [P] [US7] Integration test asserting a message posted to one thread never appears in another, and delivery covers only participated threads plus broadcasts (SC-014) (issue #132)
- [ ] T109 [P] [US7] Integration test asserting a claim on one thread leaves another thread's claim state unchanged, and that a contested claim still resolves first-claim-wins (issue #133)

### Surfaces

- [x] T110 [US7] Add the `thread_open` MCP tool in `packages/cli/src/mcp/tools/` per contracts §1.2 (issue #134)
- [x] T111 [US7] Extend `room_read` and `room_post` with `thread_id` in `packages/cli/src/mcp/tools/room.ts`, keeping the v0 shape when it is omitted (issue #135)
- [x] T112 [US7] Add `threads` with claim state to `workspace_status` in `packages/cli/src/mcp/tools/status.ts` (issue #136)
- [x] T113 [US7] Add thread commands to the CLI, and the matching thread list to the web app in `packages/cli/src/web/`, at parity (issue #137)
- [x] T114 [US7] Deliver per thread in `packages/cli/src/hooks/inject.ts`, so an agent receives its participated threads plus broadcasts (issue #138)
- [x] T115 [US7] Bind refs to threads many-to-many in `packages/relay/src/store.ts`, each ref naming its workspace, per FR-014 (issue #139)

---

## Phase 4: User Story 8 — Collaboration modes on a thread (P1)

**Goal**: A member controls what their own agent may do in a thread, and a
member with authority can settle a matter without commanding anyone's agent.

**Independent test**: Needs Phase 3 and nothing else. The two axes must be
testable separately — a member in `edit` with no authority can post and work but
cannot bind; a member with authority in `comment` can bind but cannot claim.

### Capability

- [x] T116 [US8] Add the `thread_modes` table in `packages/relay/src/store.ts`, absent row meaning `comment` (issue #140)
- [x] T117 [US8] Enforce in `packages/relay/src/messages.ts` that a mode write's author equals the member it names, refusing otherwise and recording it (SC-016) (issue #141)
- [x] T118 [US8] Add the `thread_mode` MCP tool in `packages/cli/src/mcp/tools/` with **no input field for another member's id**, so the authorisation is structural (contracts §1.3) (issue #142)
- [x] T119 [US8] Extend `agentGate()` in `packages/cli/src/mcp/call.ts` from a pause check to an ordered pause-then-mode check, adding the `mode_denied` code (issue #143)
- [x] T120 [US8] Make every denial name the mode and be recorded, per FR-039 (issue #144)
- [x] T121 [US8] Show every member's mode on a thread, and let a member set their own, on the CLI and the web app at parity (FR-041) (issue #145)
- [x] T122 [P] [US8] Integration test asserting an agent performs zero actions above its mode through the supported client, and that `view` still receives delivery (SC-015) (issue #146)
- [x] T123 [P] [US8] **Adversarial** integration test asserting no member can set another member's mode by any route, including a hand-crafted relay frame (SC-016) (issue #147)
- [x] T124 [P] [US8] Integration test asserting pause outranks mode (issue #148)

### Authority

- [x] T125 [US8] Check authority where a `binding` message is accepted in `packages/relay/src/messages.ts`, with the owner role as the v1 source (issue #149)
- [x] T126 [US8] Reject a `binding` message from a member without authority with a plain reason, recorded, and never silently downgraded (issue #150)
- [x] T127 [US8] Make a `binding` message settle the matter on the thread record, attributable and visible to the scope (issue #151)
- [x] T128 [US8] Surface a binding decision in `packages/cli/src/hooks/inject.ts`, stating plainly that it settles the record and does not direct this agent (issue #152)
- [x] T129 [US8] Persist an unanswered binding decision across cursor advance until the member's agent posts into that thread (research R6) (issue #153)
- [x] T130 [P] [US8] **Adversarial** integration test asserting zero binding messages from unauthorised members are accepted and zero are downgraded (SC-020) (issue #154)
- [x] T131 [P] [US8] Integration test asserting a binding decision causes zero runs and zero course changes on the receiving machine (SC-021) (issue #155)

### Handoff

- [x] T132 [US8] Implement the handoff lifecycle in `packages/relay/src/claims.ts`, with the claim moving only on accept (issue #156)
- [x] T133 [US8] Add `thread_handoff`, accept, decline, and withdraw to the MCP tools and both surfaces (issue #157)
- [x] T134 [US8] Refuse acceptance by a recipient whose mode is `view` or `comment`, and by a recipient outside the thread's scope (issue #158)
- [x] T135 [P] [US8] Integration test covering all four handoff states and asserting every transition is attributable and visible (SC-022) (issue #159)

### Integration topology

- [x] T143 [US8] Enforce in `packages/relay/src/boundary.ts` that a ref bound to a thread names a branch under its author's own member prefix, per FR-040 (issue #160)
- [x] T144 [P] [US8] Integration test asserting two members in `edit` on one thread land two pushed refs bound to that thread, and that **zero** bytes of code, file content, or diff crossed the relay (FR-040, SC-017) (issue #161)

---

## Phase 4b: Interface identity (FR-045..047, session 2026-08-30)

Added after the founders locked the interface identity: thread-based
navigation as the primary structure, chat inside a thread, the ticket link
as one use case. These bind the surface tasks above to that identity.

- [x] T145 [P] Make the web app's primary navigation the thread list with visible states and claims-as-assignees, per FR-045; the flat feed becomes a view over threads (extends T113) (issue #201)
- [x] T146 [P] Inside a thread, render the message pane newest-last with presence and addressed messages as mentions, per FR-045 (extends T113) (issue #202)
- [x] T147 Frame the web app's non-thread pages as the developer console per FR-047: connection and tunnel state, hook and integration health per repository, modes, member directory (issue #203)

> Sequencing (2026-09-01): phase 4b runs before T154. T154 attaches the
> auto-mode toggle, readiness control, budget box and approve control to
> a thread surface; building them on the navigation T145 replaces would
> mean building them twice.

> FR-046 (bound-ticket deep links) belongs to the connector slice with
> FR-030 and is not in this task set. SC-023's first-use loop is measured
> when T145-T147 land.

## Phase 6: US9 — auto mode, companions, plain speech (session 2026-08-31)

**Gate**: the schema pieces (T148) land through the joint `packages/shared`
rule, after the #175–#177 stack merges. Everything here queues behind that
stack.

- [x] T148 Add the session vocabulary to `packages/shared`: auto-mode state per (member, thread), session (task statement, readiness per member, per-member turn budget default 50, turn counts, state forming/live/suspended/converged/concluded/ended with ended_by), convergence proposal (summary, refs), and the wake-eligibility rule as a pure function — a member's own message wakes their own agent; inside a live session, a participating agent's session message wakes the other participating agent; nothing else wakes anybody (issue #184)
- [x] T149 Relay: session lifecycle — readiness handshake in either order, session start on the second ready, turn counting per member, budget suspension, end-by-either-human recorded, convergence proposal storage, conclusion only on a human approval frame (issue #185)
- [x] T150 Relay: wake routing per the T148 eligibility rule; deliver a wake as a distinct frame carrying the thread context pointer, never as a normal message (issue #186)
- [x] T151 CLI daemon: the wake adapter contract — one documented interface, start one run with thread context in the member's coding tool; per-tool support declared at setup; Claude Code implementation first (issue #187)
- [x] T152 CLI daemon: honor wakes — own-member message wake outside sessions, session wakes inside; pause outranks auto mode at once; budget enforcement on the member's own side as well; enforce the one-active-thread cap until T161 lands (FR-028) (issue #188)
- [x] T153 Companion service in the CLI: thread-scoped responder with read access to thread, work log, and bound refs in scope; answers as its own identity attributed to the member; no code, no claims, no bindings, no binding force; one work-log entry per companion session; works with the coding tool closed. If it runs as SAW's own runtime rather than riding the member's existing tool, the plan MUST include the Principle V documented finding saying why no standard surface fits (raised in #178 review) (issue #189)
- [ ] T154 Surfaces: auto-mode toggle, readiness control, turn-budget box (default 50), convergence approve control, session status and who-ended-it, companion chat — web and CLI at parity (issue #190)
- [x] T155 Done-ness by author (FR-052): gate the claim machine on who authored the decision — a human's decision concludes on the post, an agent's is a proposal carrying summary and refs that concludes only on its own member's approval. `relay/src/claims.ts` currently flips a claim to done on any decision from the claim holder regardless of `sender_kind`, which is the live defect; approval is self-directed, so no member may approve another's proposal. Update the claim machine and the mirrors, and put the approve control where the proposal is shown (SC-029). Also correct the AGENT.md template, which today tells agents at lines 38 and 48 that their own decision closes the work item — true now, false the moment this lands; ships to members via the T139 refresh (issue #191)
- [x] T156 Plain speech: rewrite the agent posting rules in the AGENT.md template — lead with the point, plain words, define a term on first use, no shorthand or identifier dumps; refresh ships via T139 (issue #192)
- [x] T157 [P] Integration: SC-025 adversarial wake tests and SC-027 one-sided auto mode (issue #193)
- [x] T158 [P] Integration: SC-026 full session round trip with budgets and human-approved convergence (issue #194)
- [x] T159 [P] Integration: SC-028 companion answers with the coding tool closed, and performs zero privileged actions in adversarial tests (issue #195)
- [ ] T161 Worktree per (member, thread): automate a working copy per active thread on the member's machine per FR-028, with the interim one-active-thread cap enforced in T152 until this lands; the binding is per member per thread, since threads bind refs many-to-many while a worktree is one-to-one with a branch (raised in #178 review) (issue #196)
- [ ] T160 [P] SC-024 readability check: a scripted first-use pass over live agent posts, recorded in quickstart-results (issue #197)

---

## Phase 5: Polish & cross-cutting

- [x] T136 Assert the Principle III ceiling — an agent's readable set never exceeds its member's — in `tests/integration/` (SC-018) (issue #162)
- [x] T137 Assert the v1 boundary in `tests/integration/`: zero runs start from another member's action, and zero start without the member's own prompt (SC-019) (issue #163)
- [x] T138 [P] Resolve the open questions the checklist recorded: thread state transitions (CHK005), broadcast permission (CHK006), ref-binding permission (CHK007), default force (CHK008), force on journal entries (CHK009), handoff expiry (CHK010), and mode change mid-run (CHK011) (issue #164). All seven had founder answers from 2026-08-31 that were never tied to their IDs or written into the requirements; they are now, in FR-010, FR-011, FR-014, FR-043, FR-044 and FR-055, with a mapping table in the Clarifications section. Two were being contradicted by the code and are now enforced: CHK005 had no authority check on `thread_state_set` at all, and CHK007's mode half sat unused in `packages/shared/src/modes.ts` while the CLI kept a hand-written copy. CHK021 closed alongside them, since it is one sentence in FR-043
- [x] T139 [P] Refresh `.saw/AGENT.md` from its template on `saw up` in `packages/cli/src/commands/up.ts` — it is written only by init and join today, so new room rules never reach an already-joined member (issue #165)
- [x] T140 [P] Document threads and modes in `README.md` and `packages/*/README.md`, in ASD-STE (issue #166)
- [ ] T141 Run the nine quickstart scenarios on two machines and record the outcome in `specs/002-saw-v1/quickstart-results.md` (issue #167). Scenario I was added on 2026-09-02: Scenarios A-H all predate User Story 9, so the eight as recorded validate threads, modes, authority and handoff and exercise no part of auto mode, sessions, wakes, budgets, convergence or the companion. Running the eight alone would have left the whole phase 6 stack unchecked by any live two-machine scenario
- [x] T142 Confirm `npm test` has not moved from its recorded baseline (issue #168)

---

## Dependencies

```text
Phase 1 Setup
      │
      ▼
Phase 2 packages/shared  ◀── JOINT PR GATE, blocks everything below
      │
      ▼
Phase 3 US7 Threads      ◀── first shippable slice; no identity work needed
      │
      ▼
Phase 4 US8 Modes        ◀── needs Phase 3 only
      │
      ▼
Phase 4b Interface identity ◀── FR-045, FR-047; gates T154
      │
      ▼
Phase 5 Polish
      │
      ▼
Phase 6 US9 auto mode    ◀── SECOND JOINT PR GATE on packages/shared

Later, not in this file: US1 identity and FR-008 scopes, then US2 journals,
then US3–US6 in their stated priority.
```

Within Phase 3, the store and migration tasks (T097–T103) precede routing
(T104–T109), which precedes surfaces (T110–T115).

Within Phase 4, capability (T116–T124) and authority (T125–T131) are independent
of each other and may run in parallel. Handoff (T132–T135) needs both.

## Parallel opportunities

- **Phase 2**: T088, T091, T092, T094, T095 are all `[P]` — separate files.
- **Phase 3**: the test tasks T102, T103, T108, T109 run alongside the
  implementation they cover.
- **Phase 4**: the two axes are genuinely independent, so one member can take
  capability while the other takes authority — after ownership is agreed in the
  room.
- **Phase 5**: T138, T139, T140 touch different files.

## Implementation strategy

**MVP is Phase 2 plus Phase 3.** That is the `packages/shared` rewrite and US7
threads at project scope. It delivers a real improvement on its own — the room
stops being flat and no history is lost — and it unblocks everything else in the
spec.

Phase 4 follows immediately: modes are thin, depend only on threads, and are
what makes shared threads safe to open widely.

Identity, scopes, and journals come after, in the spec's stated priority.

---

## Phase 7: Convergence

Appended by `/speckit-converge` on 2026-09-02, after User Story 7, User Story
8, phase 4b and phase 6 were built. This is the work the "Scope of this file"
section above said would be left: every requirement belonging to User Stories 1
to 6. Nothing here was found by comparing branches — it is the present state of
the code read against `spec.md`, `plan.md` and this file.

Zero constitution violations were found. All seven principles were checked,
including Principle III against the auto-mode work: pause outranks auto mode,
consent is per member, and both are enforced and tested.

**Numbering note.** This phase starts at **T162** and not at the next unused id
in this file. `T162` already exists as GitHub issue #206, opened on 2026-09-01
with no matching line here. Leaving it out and starting the new work at T162
would have produced two different tasks with one id — and per the numbering
rule at the top of this file, `/speckit-taskstoissues` de-duplicates by
matching `\bT\d{3}\b` against every existing issue, so the second T162 would
have been skipped in silence. T162 below is therefore issue #206's task,
written down at last, and the convergence work starts at T163.

- [ ] T162 Resolve the five checklist items T138 does not cover: CHK016, CHK022, CHK026 and CHK039, and confirm CHK021 which T138 closed in passing (issue #206) (partial)

### User Story 1 — A profile, an invite, a project (P1)

- [ ] T163 Replace the username-only member identity with a local profile per FR-001: a display name plus a keypair store, one or more device keys, the profile being the stable identity rather than any single key. Today `.saw/member.json` holds `github_username` and `branch_prefix` and nothing else (missing)
- [ ] T164 Make a profile portable per FR-002: moving the profile store to a new machine carries the identity, with a device key added rather than an identity recreated (missing)
- [ ] T165 Authenticate every connection by proof of a profile key per FR-003. `packages/shared/src/invite.ts` signs with one shared HMAC secret today, which proves possession of the invite, not of a member's key (partial)
- [ ] T166 Add the project as a container of one or more repo-bound workspaces per FR-004. `packages/relay/src/store.ts` has no `projects` table; the workspace is the top-level unit (missing)
- [ ] T167 Store and enforce the two independent authority axes of FR-005. `owner` exists only as an inline check in `packages/shared/src/threads.ts` for directed handoffs; there is no role storage and no administration axis (partial)
- [ ] T168 Serve the member directory from the project relay per FR-007, with each member's roles on both axes (partial)
- [ ] T169 [US1] Widen `THREAD_SCOPES` beyond `project` to team, group and private per FR-008, in `packages/shared/src/threads.ts`. The column and the comment already anticipate this; only the values are missing (missing)
- [ ] T170 [P] [US1] Integration test asserting a member outside a thread's scope receives zero messages from it and cannot name it, and that Principle III's symmetry holds inside every scope (SC-006, missing)

### User Story 2 — Status without pinging (P1)

- [ ] T171 [US2] Add the journal entry per FR-015 and FR-016: every run of a connected tool produces one per claimed thread, sharing defaults to automatic, and an entry crosses at run end. Only the run log exists today — the one `journal` hit in `store.ts` is the SQLite WAL pragma (missing)
- [ ] T172 [US2] Make a journal entry inherit its thread's scope per FR-017, and carry provenance per FR-021: author, origin class, and whether a human approved agent content (missing)
- [ ] T173 [US2] Reconcile ghosted stretches from automatic logging per FR-022 (missing)
- [ ] T174 [US2] Let a member's agent read any thread within the member's access per FR-018, so it can answer about a teammate's work while they are offline. Delivery covers participated threads plus broadcasts today, which is narrower than FR-018 asks (partial)
- [ ] T175 [P] [US2] Integration test asserting an agent's readable set never exceeds its member's while FR-018 widens the read path (Principle III, SC-018 extension, missing)

### Trust and safety

- [ ] T176 Implement redaction as a tombstone per FR-020, over messages and journal entries and the shared run record of the same run: author-unshare and owner-redact as one operation, caches honoring it, the tombstone keeping author, timestamps and the fact of withholding but never content. The `redact` code in `packages/shared/src/log.ts` is boundary redaction of log fields for content smuggling, which is a different thing (missing)
- [ ] T177 [P] Integration test asserting a tombstoned item is served to nobody and reaches no future agent context, and that its author, timestamps and the fact of withholding survive (missing)

### User Story 4 — Code collaboration

- [ ] T178 Warn both agents on their next turn when two members' work on one thread touches the same file inside a configurable window, default 60 minutes, detected from pushed refs and the members' own run records and never from access to the other member's files, per FR-029 (missing)

### User Story 5 — A thread bound to a ticket (P3)

- [ ] T179 [US5] Ship the three tracker connectors of FR-030: GitHub Issues, Linear, Jira, as thin bindings over each provider's official agent-facing interfaces using each member's existing access (missing)
- [ ] T180 [US5] Implement FR-046's bound-ticket deep links once T179 lands: every SAW status comment on the ticket carries a link to its thread, opening it lands in that member's own surface on that thread, and a viewer without SAW gets a plain explanation plus the status projection when one is enabled. Deferred out of phase 4b by the note above T154 and never tasked since (missing)
- [ ] T181 Add the read-only thread status projection of FR-034, which T180 depends on for a viewer without SAW (missing)

### User Story 6 — Every project in one place (P3)

- [ ] T182 [US6] Widen the local web app to cover all of a member's projects per FR-032. `packages/cli/src/web/server.ts` serves one workspace, and the developer console built in T147 is scoped to that one repository (partial)

### Tool integrations

- [ ] T183 [P] Document the tool-agnostic integration surface of FR-031 as a contract, with the Principle V documented finding for any adapter that reaches beyond a standard surface. `specs/002-saw-v1/contracts/` holds only `threads-and-modes.md` today (partial)
