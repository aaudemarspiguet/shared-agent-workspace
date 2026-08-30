# Phase 0 Research: Threads and collaboration modes

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Date**: 2026-08-27

Pre-spec research is in [research-notes.md](./research-notes.md) — connectivity,
landscape, context sharing, connectors, surfaces, and the repo constraint audit.
This file resolves the unknowns that the plan and the
[collab-modes checklist](./checklists/collab-modes.md) raised.

---

## R1. Where is a collaboration mode enforced?

**Decision**: A mode is enforced on the member's own machine, at the member's
own agent gate. The relay does **not** enforce it. The relay **does** enforce
that no member can write another member's mode.

**Rationale**: The checklist raised this as its only conflict (CHK022): FR-039
enforces locally, while SC-015 and SC-016 promised results "in adversarial
tests", which implies resistance to a modified client. Working through the
threat model shows the premise was wrong, not the requirement.

A mode is **self-granted**. A member sets it on their own agent. So the party a
mode restrains and the party who could bypass it are the same person. A member
who edits their own client to escape their own `view` setting has not attacked
anyone — they have changed their mind by an inconvenient route. There is no
attacker in that picture, and relay enforcement would buy nothing.

What genuinely crosses a trust boundary is different, and it is real: **one
member must never be able to set another member's mode.** That is a cross-member
authorization rule, so the relay MUST enforce it, exactly as it enforces FR-008
scopes.

The distinction also matches Principle III. A member is accountable for their
own agent. The mode is the instrument of that accountability, not a wall between
members.

**Consequence for the spec**: SC-015 must state the honest scope — the member's
own agent through the supported client — while SC-016 keeps its adversarial
framing, because it is a real boundary. Recorded as a spec correction below.

**Alternatives considered**:
- *Relay-side mode enforcement.* Rejected: it protects a member from themselves,
  costs a round trip on every action, and would make an offline member unable to
  act inside their own permitted mode.
- *No enforcement, advisory only.* Rejected: the local gate is what makes a mode
  real to the agent, and it already exists for pause.

---

## R2. What does the agent gate reuse?

**Decision**: Extend the existing `agentGate()` in
`packages/cli/src/mcp/call.ts:76-90` from a pause check to a pause-and-mode
check. Pause keeps precedence.

**Rationale**: The gate already sits on every MCP tool except
`workspace_status`, already returns a structured refusal, and already
distinguishes the one tool that must answer while blocked. Mode enforcement has
the same shape and the same call sites, so nothing new is introduced and the
precedence rule (FR-039: pause outranks mode) is one ordered check.

**Alternatives considered**: a separate mode middleware. Rejected — two gates on
one call path invites drift between them.

---

## R3. How do v0 work-item tags become threads?

**Decision**: One thread per distinct historic tag, created by the store
migration, running exactly once when the hosting member upgrades (FR-009(a)).
Messages carrying no tag go to one `general` thread per workspace. Tags that
differ only by case or surrounding space map to a single thread, and the merge
is recorded.

**Migrated threads start at `edit` for every member**, not at the `comment`
default. This is the correction the checklist caught (CHK018): in v0 an agent
claims a work item by posting an `intent` that carries the tag, so a migration
to `comment` would silently remove a capability every member's agent already
had. New threads created after the upgrade still start at `comment`.

**Alternatives considered**:
- *One thread per workspace, tags kept as labels.* Rejected: FR-009(a) requires
  every historic tag to be queryable as a thread, and SC-008 tests it.
- *Ask the member to map tags at upgrade time.* Rejected: the migration must run
  automatically and exactly once, with no interactive step.

---

## R4. How does force sit on the message envelope?

**Decision**: `force` is a field on the message envelope in
`packages/shared/src/messages.ts`, with values `advisory` and `binding`.
`advisory` is the default when the author states none. Authority is checked
where the message is accepted, not where it is rendered.

**Rationale**: Putting force on the envelope rather than inventing a new message
type keeps the five types intact (`MESSAGE_TYPES` in
`packages/shared/src/messages.ts:6-13`) and keeps the boundary schema in one
place. It also expresses the design directly: a decision is a comment made with
authority, so the content and the force are separate fields.

Defaulting to `advisory` is the safe direction — a member who forgets the flag
says something non-binding rather than accidentally settling a matter.

**Open for the tasks phase**: whether force also applies to journal entries.
The spec does not say (checklist CHK009). Recommendation: it does not. A journal
entry is a distilled record of what happened, not a speech act, so binding force
has no meaning there.

---

## R5. Does the relay need per-thread streams?

**Decision**: Yes. Delivery, cursors, and sequence numbers become per thread
stream rather than per workspace.

**Rationale**: FR-008 requires that sequence numbers, cursors, and sync metadata
never reveal the existence or count of out-of-scope content. A single global
sequence leaks exactly that through its gaps, which is why the v0 shape cannot
carry scoped threads. Project scope alone would survive a global sequence, but
building it that way now guarantees a second rewrite when FR-008 scopes arrive
in phase 3.

This interacts with a known defect: the read cursor is currently one per repo
clone (`packages/cli/src/daemon/cursor.ts`, `daemon.ts:122`), so two Claude
sessions in one repo consume each other's messages. Moving to per-thread cursors
is the moment to key them by session as well. It shares a root cause with T062
(issue #68), where the run context is daemon-global for the same reason.

---

## R6. What does "surface it to its member" require?

**Decision**: Deferred to the tasks phase, recorded here so it is not lost.

A receiving agent MUST surface a binding decision and MUST NOT silently ignore
it (FR-043), but the spec gives that no form, timing, or acknowledgement
(checklist CHK016). The existing injection path already has the shape: addressed
messages get their own block and an imperative line in `renderContext`
(`packages/cli/src/hooks/inject.ts:36-90`).

Recommendation: a binding decision renders in its own block with an explicit
obligation, and it persists across cursor advance until the receiving member's
agent posts into that thread. The current cursor advances once
(`daemon.ts:349` → `cursor.ts:26`), so an unanswered decision would otherwise be
shown once and never again.

---

## Spec corrections arising from this research

1. **SC-015** — narrow to the member's own agent through the supported client.
   The mode is a self-granted control, so an adversarial framing misstates the
   threat model. (R1)
2. **SC-016** — keep the adversarial framing. It is a genuine cross-member
   boundary and the relay enforces it. (R1)
3. **Assumptions** — record that mode enforcement is trusted to the member's own
   machine, which the checklist noted was never written down (CHK039). (R1)
