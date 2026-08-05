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

Logged whenever the boundary refuses a payload **or removes a field from
one** (FR-008, SC-005). One entry per removal, not one per frame. Stored as
a RunLogEntry with `source = boundary_rejection` plus:

| Field | Type | Rules |
|-------|------|-------|
| reason | enum | `unknown_type` \| `invalid_ref` \| `payload_too_large` \| `content_smuggling` \| `not_json` |
| summary | string | Short description; MUST NOT echo the rejected payload body. For a removal it names the field and what went, by count or kind — never the removed text and never a member-supplied key |

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

The rules live in shared zod schemas and validators, so both packages can
apply them. The **relay** is the enforcement point: it applies every rule
below to every inbound frame, and it is the only place that must be trusted
to. The daemon applies the same message rules outbound as a fast local
verdict, but it does **not** call `validateLogEntry`; a log entry is checked
at the relay only. The relay never assumes the sender checked anything.

Two outcomes, per FR-008:

- **Refuse** — the whole frame is dropped and nothing is stored. Used when
  the payload has nothing worth keeping.
- **Scrub** — the offending field is removed or trimmed and the rest of the
  record is stored. Used for a work log entry, which FR-015 requires to
  exist for every run.

**Frame level (refuse)**

1. Frame ≤256 KiB. A larger frame is refused at the socket →
   `payload_too_large`.
2. Frame must be valid JSON matching a known frame kind → `not_json`.

**Message `post` (refuse)**

3. `type` must be one of the five values → `unknown_type`.
4. `body` ≤4000 chars; `work_item` and `target` ≤100 chars each →
   `payload_too_large`.
5. `refs` must each pass GitRef validation, ≤10 refs → `invalid_ref`.
6. Smuggling check on `body`, `work_item`, and `target`: fenced code blocks
   over 20 lines, unified-diff headers (`--- a/`, `+++ b/`, `@@`), and
   base64 runs over 512 chars → `content_smuggling`. (Refs are the intended
   channel for sharing code locations.)

**Work log `log_append` (scrub)**

Only `started_at` and `ended_at` are required: without them there is no run
to keep, so a frame missing either is refused. Every other field is checked
after the parse and repaired in place. Content is judged before length, so a
long pasted diff is replaced rather than trimmed into a shorter diff.

| Field | Rule | On failure |
|-------|------|------------|
| `why_trigger` | smuggling check | replaced with a fixed placeholder → `content_smuggling` |
| `why_trigger` | ≤1000 chars | trimmed → `payload_too_large` |
| `why_trigger` | non-empty | replaced with a fixed placeholder; nothing was removed, so no entry is logged |
| `work_item` | smuggling check | dropped → `content_smuggling` |
| `work_item` | ≤100 chars | trimmed → `payload_too_large` |
| `what.branch` | valid branch name, ≤250 chars | dropped → `invalid_ref` |
| `what.head` | valid commit SHA, ≤40 chars | dropped → `invalid_ref` |
| `what.tools_used` keys | ≤100 chars, single line, smuggling check | dropped → `content_smuggling` |
| `what.tools_used` keys | ≤100 entries | surplus dropped → `payload_too_large` |
| `what.tools_used` values | non-negative integer | dropped → `not_json` |
| `what` unknown keys | not carried | dropped → `not_json` |

A `tools_used` key is not safe by construction: it is copied from the tool
names on the sending member's own machine, and a member controls the names
of their own MCP tools.

**Both outcomes**

7. Every refusal and every removal creates a BoundaryRejection entry
   (SC-005). A scrubbed `log_append` also returns the removals to the
   sender in the `log_ok` `redacted` list, so the member learns what went.
