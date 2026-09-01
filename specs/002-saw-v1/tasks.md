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

- [ ] T145 [P] Make the web app's primary navigation the thread list with visible states and claims-as-assignees, per FR-045; the flat feed becomes a view over threads (extends T113) (issue TBD)
- [ ] T146 [P] Inside a thread, render the message pane newest-last with presence and addressed messages as mentions, per FR-045 (extends T113) (issue TBD)
- [ ] T147 Frame the web app's non-thread pages as the developer console per FR-047: connection and tunnel state, hook and integration health per repository, modes, member directory (issue TBD)

> FR-046 (bound-ticket deep links) belongs to the connector slice with
> FR-030 and is not in this task set. SC-023's first-use loop is measured
> when T145-T147 land.

## Phase 5: Polish & cross-cutting

- [x] T136 Assert the Principle III ceiling — an agent's readable set never exceeds its member's — in `tests/integration/` (SC-018) (issue #162)
- [x] T137 Assert the v1 boundary in `tests/integration/`: zero runs start from another member's action, and zero start without the member's own prompt (SC-019) (issue #163)
- [ ] T138 [P] Resolve the open questions the checklist recorded: thread state transitions (CHK005), broadcast permission (CHK006), ref-binding permission (CHK007), default force (CHK008), force on journal entries (CHK009), handoff expiry (CHK010), and mode change mid-run (CHK011) (issue #164)
- [x] T139 [P] Refresh `.saw/AGENT.md` from its template on `saw up` in `packages/cli/src/commands/up.ts` — it is written only by init and join today, so new room rules never reach an already-joined member (issue #165)
- [x] T140 [P] Document threads and modes in `README.md` and `packages/*/README.md`, in ASD-STE (issue #166)
- [ ] T141 Run the eight quickstart scenarios on two machines and record the outcome in `specs/002-saw-v1/quickstart-results.md` (issue #167)
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
Phase 5 Polish

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
