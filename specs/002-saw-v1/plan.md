# Implementation Plan: SAW v1 — Threads first, then collaboration modes

**Branch**: `002-saw-v1` | **Date**: 2026-08-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-saw-v1/spec.md`

## Summary

Spec 002 is large. This plan sequences it so the first shippable slice is
**threads at project scope** (US7), followed by **collaboration modes** (US8),
with the remaining stories in their stated priority.

Threads are first because every other part of 002 binds to a thread: modes are
per `(member, thread)`, journal entries take their thread's scope (FR-017),
claims and handoffs are thread-scoped (FR-013, FR-044), and ref bindings are
thread-to-ref (FR-014). Anything built before threads is built against the flat
v0 room and must be built again.

The technical approach is a schema rewrite in `packages/shared`, then the relay
and CLI in turn. The v0 room becomes one thread per historic work-item tag. The
message envelope gains `thread_id` and `force`. Claims move from a workspace
key to a thread key. Two new tables carry thread modes and handoff state.

**Sequencing constraint**: the frozen `packages/shared` rewrite lands as one
jointly-approved PR before any relay or CLI work on 002 begins. It is the last
open merge gate on this spec, and US7 is a schema change, so it is now the first
piece of implementation work rather than a later one.

## Technical Context

**Language/Version**: TypeScript 5.6, Node.js ESM (`"type": "module"`)

**Primary Dependencies**: `zod` (boundary schemas), `better-sqlite3` 12
(relay store), `ws` 8.18 (relay transport), `ulid` (ids), `@modelcontextprotocol/sdk`
(agent connection), iroh (tunnel, already shipped in `packages/cli/src/tunnel.ts`)

**Storage**: SQLite via `better-sqlite3` on the relay host; JSON state files
under `.saw/` on each member's machine

**Testing**: Vitest 3, projects `packages/*` and `tests/*`
(`vitest.config.ts:1-8`). Measured on this branch on 2026-08-27:
**218/227 on Windows**, with nine failures — seven in
`packages/cli/tests/up-resolve.test.ts` (T081, issue #98, a POSIX-only harness)
and two in `packages/cli/tests/config.test.ts` (T056, issue #60, chmod 0600 is
a no-op on Windows). Neither is a product fault.

Note the branch number differs from `README.md`'s 205/214, which is `main`'s.
This branch carries extra tests from PR #103, so it has 227 tests rather than
214. The nine failures are the same nine.

**Target Platform**: Windows, macOS, Linux. Windows is a first-class target and
the current source of every known test failure, so new harnesses must be
cross-platform from the start.

**Project Type**: npm workspaces monorepo — `packages/shared` (boundary and
schemas), `packages/relay` (server and store), `packages/cli` (daemon, MCP
server, hooks, web app)

**Performance Goals**: Reading a 20-run thread costs an agent under 10,000
tokens (SC-007). Delivery stays gapless and totally ordered per stream
(FR-036).

**Constraints**: Only messages, refs, and journal entries may cross between
members (Principle II). Code moves only through git (Principle VI). No fork or
wrapper of any coding tool (Principles I, V). The relay must stay self-hostable
(Principle VII).

**Scale/Scope**: 10 members, 2–3 workspaces, tens of threads per project is the
validated envelope (SC-009). No member cap is encoded anywhere (FR-004).

## Constitution Check

*GATE: passed before Phase 0, re-checked after Phase 1.*

| Principle | Gate | Verdict |
|---|---|---|
| I. Coordination layer, not a coding agent | Does any new requirement generate, edit, or execute code for a member? | **Pass.** Modes gate what an agent may do; SAW never acts for it. FR-019 and FR-042(a) forbid triggering another member's agent or running anything unattended. |
| II. Messages, refs, journal entries only | Does any new payload cross that is not one of the three? | **Pass.** Threads add `thread_id` metadata; modes are member state; force is an envelope field. FR-040 restates that no code, file content, or diff crosses. FR-025's boundary checks extend to every new free-text field. |
| III. Human visibility and steering | Does anything become hidden, or does an agent gain reach its human lacks? | **Pass.** Mode changes and every authority action are attributable and visible to the scope (FR-005, FR-038). SC-018 states the ceiling FR-018 only implied. Authority binds the record and never another member's agent (FR-043). Pause outranks mode (FR-039). |
| IV. Automatic, explained, traceable logging | Does any new action lack an automatic log entry? | **Pass, with one companion amendment.** Mode changes, force decisions, and handoff transitions are all recorded. FR-015's `unassigned` record needs Principle IV to name a pending-assignment state; that amendment is filed separately against `main` (see Complexity Tracking). |
| V. Standards, not forks | Does any integration need a fork or wrapper? | **Pass.** Modes are enforced in SAW's own MCP tool gate, which is already how pause works (`packages/cli/src/mcp/call.ts:76-90`). No tool is wrapped. |
| VI. Git is the only code sync | Does work move outside git? | **Pass.** FR-040 keeps branch-per-agent under each member's own prefix and integrates by merge or PR. Handoff carries refs, never a working tree (FR-044). |
| VII. Open core, small relay | Does the relay grow in a way that breaks self-hosting? | **Pass.** Threads and modes are store schema and routing; nothing requires hosted-only infrastructure. |

**Documentation constraint**: every new document and comment follows ASD-STE —
short sentences, one idea per sentence, active voice, simple words.

### Re-check after Phase 1 design

All seven gates still pass. Two points moved in the right direction:

- **Principle III got stronger, not weaker.** Research R1 found that the design
  had misstated its own threat model: a mode is self-granted, so it restrains
  the member's own agent and is not a boundary against the peer. SC-015 now says
  so, and the one genuine cross-member rule — that nobody may write another
  member's mode — is enforced by the relay and tested adversarially (SC-016).
  The authorisation is structural in the contract: `thread_mode` has no input
  field for another member's id.
- **Principle II is unchanged by the new fields.** `thread_id` and `force` are
  envelope metadata. The five message types are untouched, and FR-025's boundary
  checks extend to both.

No gate needs an entry in Complexity Tracking as a result of the design. The two
entries already there stand.

## Project Structure

### Documentation (this feature)

```text
specs/002-saw-v1/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
├── research-notes.md    # Pre-spec research (already present)
├── spec.md
├── checklists/
│   ├── requirements.md
│   └── collab-modes.md
└── tasks.md             # /speckit-tasks output, not created here
```

### Source Code (repository root)

```text
packages/shared/src/
├── messages.ts          # envelope gains thread_id and force; boundary checks
├── frames.ts            # protocol frames gain a version (FR-035)
├── threads.ts           # NEW - thread entity, states, scope
├── modes.ts             # NEW - the mode ladder and its comparison rules
├── invite.ts
└── log.ts               # run record gains the pending-assignment state

packages/relay/src/
├── store.ts             # schema migration; threads, thread_modes, handoffs
├── messages.ts          # route by thread; reject cross-member mode writes
├── claims.ts            # claims keyed by thread, not workspace
├── sync.ts              # per-thread streams; no cross-thread seq leakage
├── boundary.ts          # extend checks to new free-text fields
└── server.ts

packages/cli/src/
├── daemon/state.ts      # thread-aware room state
├── daemon/cursor.ts     # cursor per thread stream
├── mcp/tools/           # thread_open, thread_mode, and thread-aware room tools
├── mcp/call.ts          # agentGate() extended from pause to pause + mode
├── hooks/inject.ts      # deliver per thread; surface binding decisions
└── web/                 # thread list and mode control, CLI/web parity (FR-041)

tests/integration/       # thread isolation, mode enforcement, migration,
                         # authority, handoff lifecycle
```

**Structure Decision**: the existing three-package workspace is kept. No new
package is added. `packages/shared` changes first and alone, because both other
packages depend on its schemas and the spec gates that rewrite behind one
jointly-approved PR.

## Phase sequencing

| Phase | Content | Gate |
|---|---|---|
| 0 | `packages/shared` rewrite — envelope, thread entity, mode ladder, protocol version | **Joint PR. Both members approve before anything downstream starts.** |
| 1 | US7 threads at project scope — relay store and routing, claims by thread, migration, CLI and MCP surfaces | Independently shippable; US7 acceptance scenarios pass with no identity work |
| 2 | US8 collaboration modes — mode storage, the agent gate, force on the envelope, handoff lifecycle | Needs phase 1 only |
| 3 | US1 identity and FR-008 scopes | Widens threads from project scope to the full scope set |
| 4 | US2 journals, then US3–US6 in stated priority | — |

## Complexity Tracking

| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| Constitution amendment 2.1.0, filed separately against `main` | FR-015 produces a run record tagged `unassigned`, and Principle IV as written requires every entry to be tagged to a feature or story | Wording the spec around it was rejected: it would leave the constitution saying something the system does not do. The amendment is filed against `main` rather than this branch because this branch predates the 2.0.0 merge (#105) and carries 1.2.0 on disk; editing from that base would clobber 2.0.0 on merge. |
| Two authorization axes in FR-005 while v1 still ships two roles | Administration and work authority are different powers with different rules — one never grants scope read access, the other always requires participation | Keeping one undifferentiated `owner` was rejected because it makes FR-005 contradict FR-008 and SC-006: an owner cannot override a claim in a thread they cannot see. Splitting the powers now, while keeping one role, resolves that with no v1 scope growth. |
