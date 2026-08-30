# Collaboration Modes Checklist: SAW v1 — Threads and Collaboration Modes

**Purpose**: Validate the quality of the requirements added on 2026-08-27 —
User Story 7 (threads), User Story 8 (collaboration modes), FR-037 to FR-044,
and SC-014 to SC-022. This checklist tests how the requirements are written,
not whether an implementation works.
**Created**: 2026-08-27
**Feature**: [spec.md](../spec.md)

**Depth**: formal — this checklist gates entry to `/speckit-plan`
**Audience**: reviewer, on the pull request into `002-saw-v1`

## Requirement Completeness

- [x] CHK001 - Are the permitted actions of each mode rung stated separately
      rather than implied by the rung's name? [Completeness, Spec §FR-037]
- [x] CHK002 - Is the default mode stated for both a new thread and a thread
      created by migration? [Completeness, Spec §FR-038]
- [x] CHK003 - Are the states of a handoff enumerated, with the point at which
      the claim moves named? [Completeness, Spec §FR-044]
- [x] CHK004 - Is the relationship between mode and pause stated, including
      which one wins? [Completeness, Spec §FR-039]
- [ ] CHK005 - Are the state transitions of a thread defined — who may move it
      between open, done, and archived, and on what condition? The states are
      listed but the transitions are not. [Gap, Spec §FR-010]
- [ ] CHK006 - Is it stated who may post a project broadcast? A broadcast
      reaches every member, so the spec should say whether that is open to all
      members or gated. [Gap, Spec §FR-011]
- [ ] CHK007 - Is it stated who may bind and unbind a ref to a thread, and
      whether that is a work-authority power? [Gap, Spec §FR-014]
- [ ] CHK008 - Is a default force value defined for a message whose author
      states none? [Gap, Spec §FR-043]
- [ ] CHK009 - Is it stated whether force applies to journal entries, or only
      to messages? [Gap, Spec §FR-043]
- [ ] CHK010 - Is a general expiry defined for a handoff that is never
      answered? Expiry on member removal is covered; an unanswered handoff to
      a present member is not. [Gap, Spec §FR-044]
- [ ] CHK011 - Is the effect of a mode change during a run in progress
      defined? The claim case is covered in Edge Cases; an in-flight tool call
      is not. [Gap, Spec §FR-037]

## Requirement Clarity

- [x] CHK012 - Is "self-granted" defined precisely enough to test — that is,
      does the spec name who may and may not set a mode? [Clarity, Spec §FR-037]
- [x] CHK013 - Is the difference between a capability and an authority stated
      explicitly rather than left to inference? [Clarity, Spec §FR-037, §FR-043]
- [x] CHK014 - Is "a decision is a comment made with authority" tied to a
      concrete mechanism rather than left as a slogan? [Clarity, Spec §FR-043]
- [x] CHK015 - Is the limit of authority stated in terms an implementer can
      act on — what a binding message does and does not reach? [Clarity,
      Spec §FR-043]
- [ ] CHK016 - Is "surface it to its member" defined well enough to build and
      test? It is required of a receiving agent but not given a form, a
      timing, or an acknowledgement. [Ambiguity, Spec §FR-043]

## Requirement Consistency

- [x] CHK017 - Does the mode ladder avoid contradicting FR-012, which already
      owns the delivery axis through mute? [Consistency, Spec §FR-037, §FR-012]
- [x] CHK018 - Does the migration rule avoid removing a capability that v0
      agents already have? Resolved on 2026-08-27: v0 agents claim by posting
      an intent with a tag, so migrated threads start at `edit` rather than
      `comment`. [Consistency, Spec §FR-038, §FR-009]
- [x] CHK019 - Do the administration and work-authority axes account for every
      power FR-005 previously granted, with none dropped or duplicated?
      [Consistency, Spec §FR-005]
- [x] CHK020 - Is the owner-override rule consistent with FR-008 and SC-006
      now that the axes are separated? [Consistency, Spec §FR-005, §FR-008]
- [ ] CHK021 - Does FR-043 restate the participation requirement that FR-005
      places on every work-authority power? FR-043 names the owner role as the
      authority source but does not repeat that binding also needs
      participation, so the two must be read together to get the rule right.
      [Consistency, Spec §FR-043, §FR-005]
- [ ] CHK022 - Is local-only enforcement consistent with the adversarial
      criteria? FR-039 enforces mode at the member's own agent gate, while
      SC-015 and SC-016 promise zero violations under adversarial test. A
      member running a modified client is inside the threat model those
      criteria imply, and a local gate cannot hold against one. Either the
      criteria should name the honest-client assumption, or the relay must
      enforce mode the way it enforces FR-008 scopes. [Conflict, Spec §FR-039,
      §SC-015, §SC-016]

## Acceptance Criteria Quality

- [x] CHK023 - Are the two axes measurable independently of each other?
      [Measurability, Spec §SC-015, §SC-020]
- [x] CHK024 - Is the no-cross-triggering property stated as a counting
      criterion rather than a description? [Measurability, Spec §SC-019]
- [x] CHK025 - Is the Principle III ceiling — that an agent never reads more
      than its member — expressed so a test can bind to it? [Measurability,
      Spec §SC-018]
- [ ] CHK026 - Can "zero course changes on the receiving machine that the
      receiving member did not choose" be objectively measured? Intent is not
      observable from outside the session, so this criterion needs an
      observable proxy. [Measurability, Spec §SC-021]

## Scenario Coverage

- [x] CHK027 - Are requirements defined for the primary flow of two members
      working one thread in `edit`? [Coverage, Spec §US8]
- [x] CHK028 - Are requirements defined for the exception flow of an action
      above the current mode? [Coverage, Spec §FR-039]
- [x] CHK029 - Are requirements defined for the recovery flow of a declined or
      withdrawn handoff? [Coverage, Spec §FR-044]
- [x] CHK030 - Are requirements defined for the migration flow from a flat v0
      room, including messages that carry no tag? [Coverage, Spec §FR-009,
      Edge Cases]
- [x] CHK031 - Are contradicting binding decisions on one thread addressed?
      [Coverage, Edge Cases]

## Edge Case Coverage

- [x] CHK032 - Is the case of authority lost after a binding decision was made
      addressed? [Edge Case, Spec §Edge Cases]
- [x] CHK033 - Is the case of a handoff to a member outside the thread's scope
      addressed? [Edge Case, Spec §Edge Cases]
- [x] CHK034 - Is the case of a binding decision arriving for a paused member
      addressed? [Edge Case, Spec §Edge Cases]
- [x] CHK035 - Are v0 tags that differ only by case or spacing addressed in
      the migration? [Edge Case, Spec §Edge Cases]

## Dependencies & Assumptions

- [x] CHK036 - Is the dependency of US7 on project scope only — and its
      independence from the identity work of US1 — stated explicitly?
      [Assumption, Spec §US7]
- [x] CHK037 - Is the deferred v2 material recorded well enough that v1 does
      not foreclose it? [Assumption, Spec §FR-042]
- [x] CHK038 - Is the constitutional dependency of FR-015 named, including
      that the amendment is filed separately? [Dependency, Spec §FR-015]
- [ ] CHK039 - Is the assumption that mode enforcement can be trusted to the
      member's own machine stated anywhere in Assumptions? It follows from
      FR-039 but is never written down as an assumption. [Assumption, Gap]

## Notes

Eleven items are unchecked. None blocks `/speckit-plan`; each is recorded so
the plan phase resolves it rather than discovering it during implementation.

Two deserve attention before implementation starts:

- **CHK022** is the only conflict found. Mode is enforced locally while two
  success criteria promise adversarial resistance. This needs either a
  narrowed criterion or relay-side enforcement, and the choice changes the
  contract between CLI and relay — so it belongs in `/speckit-plan`, not
  later.
- **CHK018** was a real defect and is fixed. The first draft said the default
  mode `comment` preserved v0 behavior, but v0 agents claim work items by
  posting an intent carrying the tag, and `comment` forbids claiming. Left
  alone, the upgrade would have silently removed a capability from every
  existing member. Migrated threads now start at `edit`.

CHK005 to CHK011 are ordinary gaps of the kind the plan phase closes: thread
state transitions, broadcast and ref-binding permissions, the default force
value, handoff expiry, and mode changes mid-run.
