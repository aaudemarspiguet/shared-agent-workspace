# Phase 1 Data Model: Threads and collaboration modes

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Date**: 2026-08-27

Entities are grouped by the phase that introduces them, so phase 1 can ship
without phase 3. Types are given as intent, not as SQL.

---

## Phase 1 — threads at project scope (US7)

### Thread

The unit of collaboration. Replaces the flat room.

| Field | Type | Rules |
|---|---|---|
| `id` | ULID | Immutable. |
| `workspace_id` | ULID | The workspace the thread was opened in. |
| `type` | `work_item` \| `brainstorm` \| `general` | FR-010. Epics are modelled as `work_item` (Assumptions). |
| `title` | text, ≤ 200 | Required. |
| `scope` | `project` | FR-008 adds `team`, `group`, `private` in phase 3. Phase 1 stores the column and permits one value, so widening is data, not schema. |
| `state` | `open` \| `done` \| `archived` | FR-010. |
| `created_by` | member id | |
| `created_at` | ISO-8601 UTC | |
| `migrated_from_tag` | text, nullable | The v0 work-item tag this thread came from (FR-009(a)). Null for threads created after the upgrade. |

**Open for tasks**: state transitions are not specified — who may move a thread
between `open`, `done`, and `archived`, and on what condition (checklist CHK005).
Archiving is an administration power in FR-005; closing a work item is a
work-authority power in FR-005. The transition table must respect both.

### Thread participant

A member becomes a participant by creating, joining, claiming, or being
addressed in a thread (FR-012). Project-scope threads deliver to all members by
default.

| Field | Type | Rules |
|---|---|---|
| `thread_id` | ULID | |
| `member_id` | member id | |
| `joined_at` | ISO-8601 UTC | |
| `muted` | boolean | Adjusts delivery, never access (FR-012). Distinct from mode. |

Primary key `(thread_id, member_id)`.

### Message (extended)

The existing envelope in `packages/shared/src/messages.ts` gains two fields. The
five message types are unchanged.

| Field | Type | Rules |
|---|---|---|
| `thread_id` | ULID, nullable | Null means a project broadcast (FR-011). |
| `force` | `advisory` \| `binding` | Default `advisory`. Phase 2 enforces authority; phase 1 stores and defaults it. |

All existing boundary checks apply to both new fields and to every new free-text
field this spec introduces (FR-025).

### Claim (rekeyed)

Claims move from a workspace key to a thread key (FR-013). First-claim-wins is
preserved.

| Field | Type | Rules |
|---|---|---|
| `thread_id` | ULID | Was the workspace's `work_item` tag. |
| `holder` | member id, nullable | Null when released. |
| `claimed_at` | ISO-8601 UTC | |

**Migration**: a v0 claim on tag `X` becomes a claim on the thread migrated from
tag `X`.

### Ref binding

Many-to-many, and every bound ref states its workspace (FR-014).

| Field | Type | Rules |
|---|---|---|
| `thread_id` | ULID | |
| `workspace_id` | ULID | Required — a ref is meaningless without it. |
| `ref_kind` | `branch` \| `commit` | Reuses `GitRef` in `packages/shared/src/messages.ts:28-32`. |
| `ref_value` | text | Validated by the existing `isValidBranchName` / `isValidCommitSha`. |

**Open for tasks**: who may bind and unbind a ref, and whether that is a
work-authority power (checklist CHK007).

### Stream position

Delivery, cursors, and sequence numbers become per thread (research R5), so no
sequence gap can reveal out-of-scope content when FR-008 scopes arrive.

| Field | Type | Rules |
|---|---|---|
| `thread_id` | ULID | |
| `member_id` | member id | |
| `session_id` | text | Keyed by coding-tool session, not by repo clone. Fixes the current one-cursor-per-clone defect where two sessions in one repo consume each other's messages. |
| `last_injected_seq` | integer | Advances only on a completed injection ack, as today. |

---

## Phase 2 — collaboration modes (US8)

### Collaboration mode

| Field | Type | Rules |
|---|---|---|
| `thread_id` | ULID | |
| `member_id` | member id | The member the mode applies to. |
| `mode` | `view` \| `comment` \| `edit` | FR-037. |
| `set_at` | ISO-8601 UTC | |

Primary key `(thread_id, member_id)`.

**Rules**

- Absent row means `comment` (FR-038). The default is not stored.
- A row is writable **only** by the member it names. The relay MUST refuse a
  write whose author differs from `member_id` (SC-016). This is the one part of
  the mode system that is a cross-member boundary.
- Threads created by the FR-009(a) migration are written at `edit` for every
  member, because v0 agents could already claim (research R3).
- Ordering for comparison: `view` < `comment` < `edit`.

### Handoff

A claim transfer with a lifecycle (FR-044), not a message.

| Field | Type | Rules |
|---|---|---|
| `id` | ULID | |
| `thread_id` | ULID | |
| `from_member` | member id | |
| `to_member` | member id | Exactly one recipient. |
| `state` | `proposed` \| `accepted` \| `declined` \| `withdrawn` | |
| `tip_ref` | GitRef | The sender's current tip (FR-028). |
| `directed` | boolean | True when an owner directed it with `binding` force. |
| `created_at` / `resolved_at` | ISO-8601 UTC | |

**State transitions**

```text
proposed ──accept──▶ accepted     claim moves to to_member
   │
   ├────decline────▶ declined     claim stays with from_member
   │
   ├───withdraw────▶ withdrawn    by from_member only
   │
   └───member removed / scope lost ──▶ withdrawn, recorded
```

**Rules**

- The claim moves **only** on `accepted`. Until then it stays with `from_member`.
- A recipient whose mode is `view` or `comment` cannot accept. Their agent
  surfaces it; the member raises their mode or declines.
- A recipient outside the thread's scope is refused with a plain reason.
- Every transition is attributable and visible to the thread's scope.

**Open for tasks**: expiry for a handoff that is never answered (checklist
CHK010).

---

## Phase 3 and later

Introduced by US1 and US2; listed so phase 1 does not foreclose them.

- **Profile** — display name plus a keypair store, one or more device keys.
- **Project** / **Team** — the container and a named subset of members.
- **Journal entry** — a message subtype, scope-inheriting, revocable.
- **Run record** — gains the pending-assignment state of FR-015.
- **Ticket binding** — `(thread, provider, locator, url)`.
- **Invite**, **Tombstone** — as specified.

When FR-008 scopes arrive, `Thread.scope` widens from one permitted value to
four and a scope-membership table joins it. Nothing in phase 1 changes.

---

## Validation rules carried from the spec

| Rule | Source |
|---|---|
| Reading a thread returns that thread's messages only | FR-011, SC-014 |
| A claim on one thread does not affect another | FR-013, US7 scenario 4 |
| No member may write another member's mode | FR-037, SC-016 |
| An action above the current mode is denied, with a reason, and recorded | FR-039, SC-015 |
| Pause outranks mode | FR-039, US8 scenario 8 |
| `binding` requires authority; it is never silently downgraded | FR-043, SC-020 |
| A binding message causes zero runs on another member's machine | FR-043, SC-021 |
| A claim moves only on accept | FR-044, SC-022 |
| No code, file content, or diff crosses the relay | FR-025, FR-040, SC-017 |
