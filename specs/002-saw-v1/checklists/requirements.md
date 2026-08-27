# Specification Quality Checklist: SAW v1 — Projects, Threads, and Shared Context

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-24
**Updated**: 2026-08-24 — founder answered all clarifications; spec re-scoped
**Updated**: 2026-08-27 — US7 threads and US8 collaboration modes added;
re-validated against the enlarged spec
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — all three resolved in the
      2026-08-24 clarification session (identity → local portable profile;
      async answering → ask-the-thread, pull-only; agent-less stakeholders →
      status projection only, paid/hosted candidate later)
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Re-scope of 2026-08-24 is folded in: projects span multiple repos with
  project/team/group/one-on-one access scopes (US3, FR-008, SC-006);
  portable multi-key profile identity (US1, FR-001..003, SC-002); all
  three connectors (FR-030, SC-012); open integration contract with three
  validated tools (FR-031, SC-011).
- A four-lens adversarial review (fidelity to founder answers, internal
  consistency, constitutional compliance, buildability vs the repo) ran on
  2026-08-24; all 46 findings were resolved in this revision, including
  the ghost-mode/logging reconciliation (FR-022), the seq-leak rule
  (FR-008/FR-036), the owner-powers scope carve-outs (FR-005/FR-024/
  SC-006), and the two-part migration (FR-009).
- Remaining approval gate is external to this spec: the constitution
  amendment PR (Principles II, III, IV, preamble). Per the founder,
  building proceeds in parallel; the frozen shared-schema rewrite is its
  own joint-PR gate before relay/CLI implementation.
- Least-proven area: Cursor/Codex journaling surfaces (FR-031 validated
  tier), flagged in Assumptions with the Principle V documented-finding
  gate for any beyond-standard adapter.

### 2026-08-27 re-validation

- Every box above still holds against the enlarged spec. Three markers were
  opened and all three closed inside the same session, so the marker count
  is zero again: the `view`/`comment` rungs (FR-037), owner claim override
  against scoped-thread invisibility (FR-005), and unassigned run records
  against Principle IV (FR-015).
- The constitution-amendment gate named above is closed. It merged as PR
  #105 and `main` carries 2.0.0. Note this branch predates that merge and
  still shows 1.2.0 on disk; it picks 2.0.0 up on merge, which is why no
  constitution edit belongs on this branch.
- One companion amendment follows from the 2026-08-27 session and is filed
  separately against `main`: Principle IV gains a pending-assignment clause
  for FR-015 (2.0.0 to 2.1.0, MINOR).
- The remaining gate is unchanged: the frozen `packages/shared` rewrite as
  one jointly-approved PR. US7 is a schema change, so that gate is now the
  first piece of implementation work.
- See `collab-modes.md` for the requirements-quality checklist covering the
  new threads and collaboration-modes material.
