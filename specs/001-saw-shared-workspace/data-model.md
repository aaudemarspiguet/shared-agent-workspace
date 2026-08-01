# Data Model: SAW Shared Workspace

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Date**: 2026-07-31

All entities live in the relay's SQLite database unless marked *local*.
IDs are ULIDs (sortable, collision-free). Times are UTC ISO-8601.

## Workspace

One shared space per repository.

| Field | Type | Rules |
|-------|------|-------|
| id | ULID | Primary key |
| name | string | Non-empty, ≤100 chars |
| repo_remote | string | Git remote URL; exactly one per workspace (FR-001) |
| invite_secret | bytes | HMAC key for invite links; never leaves the relay |
| created_at | timestamp | Set on creation |

Constraints: max 2 members (v1). Deleting a workspace is out of scope.

## Member

A human developer. Owns exactly one agent connection.

| Field | Type | Rules |
|-------|------|-------|
| id | ULID | Primary key |
| workspace_id | ULID | FK → Workspace |
| github_username | string | Declared identity; unique per workspace |
| token_hash | string | SHA-256 of bearer token; token itself never stored |
| role | enum | `creator` \| `joined` |
| joined_at | timestamp | Set on successful join |

## Invite

A signed, single-use join grant. (Payload travels in the link; the relay
stores the issued record for nonce/expiry checks.)

| Field | Type | Rules |
|-------|------|-------|
| nonce | string | Primary key; single use |
| workspace_id | ULID | FK → Workspace |
| invitee_github_username | string | Bound at mint time |
| expires_at | timestamp | Reject after expiry |
| used_at | timestamp? | Null until redeemed; non-null blocks reuse |

## Message

One unit of room communication. Append-only; relay assigns global order.

| Field | Type | Rules |
|-------|------|-------|
| id | ULID | Primary key |
| workspace_id | ULID | FK → Workspace |
| seq | integer | Relay-assigned, gapless per workspace; delivery order (SC-007) |
| sender_member_id | ULID | FK → Member; from connection auth, never client-claimed |
| sender_kind | enum | `agent` \| `human` |
| type | enum | `intent` \| `question` \| `decision` \| `handoff` \| `status` (FR-004) |
| body | string | ≤4000 chars; plain text; validated against smuggling rules (see Boundary rules) |
| refs | GitRef[] | 0–10 refs |
| target_member_id | ULID? | Optional; set on human redirects (FR-012) |
| work_item_id | ULID? | Optional link to a WorkItem |
| sent_at | timestamp | Relay receive time |

State: none (immutable once accepted).

## GitRef (value object, embedded in Message)

| Field | Type | Rules |
|-------|------|-------|
| kind | enum | `branch` \| `commit` |
| value | string | branch: valid git branch name (git check-ref-format rules); commit: 7–40 hex chars |

The only pointer to code that may cross between members (FR-005, FR-008).

## WorkItem

A named unit of work that claims, handoffs, and log entries attach to.

| Field | Type | Rules |
|-------|------|-------|
| id | ULID | Primary key |
| workspace_id | ULID | FK → Workspace |
| title | string | Non-empty, ≤200 chars |
| feature_tag | string | Short slug used in log links (FR-016) |
| state | enum | See transitions below |
| claimed_by | ULID? | FK → Member; null unless claimed |
| created_at / updated_at | timestamp | — |

State transitions (relay enforces, in `seq` order — first claim wins,
FR-006a):

```
open → claimed        (claim message; rejected if already claimed)
claimed → open        (release, or handoff not yet accepted)
claimed → handed_off  (handoff message with refs; reassigns claimed_by)
handed_off → claimed  (receiving agent accepts)
claimed → done        (decision message closes it)
```

A rejected claim produces a `claim_rejected` notice visible to both humans;
it never silently drops (edge case rule).

## RunLogEntry

The automatic record of one agent run. Append-only. The set of RunLogEntry
rows is the **work log** — the canonical name for this store across all
artifacts (the `work_log` MCP tool reads it).

| Field | Type | Rules |
|-------|------|-------|
| id | ULID | Primary key |
| workspace_id | ULID | FK → Workspace |
| member_id | ULID | FK → Member (whose agent ran) |
| started_at / ended_at | timestamp | From hook events (the "when", FR-016) |
| what | object | Mechanical summary: tool-use counts, branch name, head commit SHA, changed-file count. Counts and git refs only — never file paths or file contents |
| why_trigger | string | The instruction that started the run (prompt or room message excerpt) |
| why_work_item_id | ULID? | Active claim at run time; null = `unassigned` (FR-016) |
| source | enum | `hook_stop` \| `boundary_rejection` \| `system` |

## BoundaryRejection

Logged whenever a payload fails validation (FR-008, SC-005). Stored as a
RunLogEntry with `source = boundary_rejection` plus:

| Field | Type | Rules |
|-------|------|-------|
| reason | enum | `unknown_type` \| `invalid_ref` \| `payload_too_large` \| `content_smuggling` \| `not_json` |
| summary | string | Short description; MUST NOT echo the rejected payload body |

## PauseState

One row per member; authoritative at the relay.

| Field | Type | Rules |
|-------|------|-------|
| member_id | ULID | Primary key, FK → Member |
| paused | boolean | Set only by the owning member (FR-013) |
| changed_at | timestamp | — |

Transitions: `active ↔ paused`. While paused: daemon queues inbound
messages (relay marks them undelivered); PreToolUse hook denies tool calls;
delivery resumes in `seq` order on unpause (FR-014).

## Presence (in-memory at relay, not persisted)

| Field | Type | Rules |
|-------|------|-------|
| member_id | ULID | — |
| online | boolean | Derived from live WebSocket + ping/pong |
| last_seen_at | timestamp | Broadcast to both daemons for the UI |

## ReadCursor (*local*, per member daemon)

| Field | Type | Rules |
|-------|------|-------|
| last_injected_seq | integer | Highest message `seq` already injected into the agent context; drives "unread" for SessionStart/UserPromptSubmit injection |

## Local files (*local*, written by `saw init` / `saw join`)

| File | Contents | Rules |
|------|----------|-------|
| `.saw/config.json` | workspace id, relay URL, github_username, repo remote, branch prefix | Committed-shareable |
| `.saw/credential` | bearer token | Git-ignored; created on join; never shared |
| `.saw/AGENT.md` | STE instructions for the connected agent | Regenerated by `saw init`; read by agents at session start |

## Boundary rules (validation summary)

Applied identically at daemon (outbound) and relay (inbound), from shared
zod schemas:

1. Frame must be valid JSON matching a known frame schema.
2. Message `type` must be one of the five values; anything else →
   `unknown_type` rejection.
3. `refs` must each pass GitRef validation; failures → `invalid_ref`.
4. `body` ≤4000 chars; larger → `payload_too_large`.
5. Heuristic smuggling check on `body`: reject fenced code blocks over 20
   lines, unified-diff headers (`--- a/`, `+++ b/`, `@@`), and
   base64 runs >512 chars → `content_smuggling`. (Refs are the intended
   channel for sharing code locations.)
6. Every rejection creates a BoundaryRejection entry (SC-005).
