# Contract: Threads and Collaboration Modes

This contract covers the surfaces that change for User Story 7 (threads at
project scope) and User Story 8 (collaboration modes). It extends the v0
contracts in `specs/001-saw-shared-workspace/contracts/`; anything not named
here is unchanged.

Common error shape is unchanged:

```json
{ "error": { "code": "paused|not_connected|invalid_input|rejected", "message": "..." } }
```

One code is added to the closed set: `mode_denied`. It is returned when an
action sits above the caller's mode on the thread.

---

## 1. MCP tools

### 1.1 Changes to existing tools

`room_read` and `room_post` become thread-aware. Both keep their names, so an
already-connected agent keeps working.

`room_read` input gains:

```json
{ "thread_id": "01J...", "limit": 50, "since_seq": 0 }
```

Omitting `thread_id` reads project broadcasts plus the threads the member takes
part in — the v0 shape. Passing it reads exactly one thread. Reading a thread
MUST NOT require filtering a global feed (FR-011).

`room_post` input gains:

```json
{ "thread_id": "01J...", "type": "status", "body": "...", "force": "advisory" }
```

- `thread_id` omitted means a project broadcast.
- `force` defaults to `advisory`. `binding` requires authority (FR-043).
- The relay is the only source of the verdict, as in v0.
- At the agent's tool (not on the wire), `body` is composed from two
  fields: `summary`, written for the humans in plain words, and `details`,
  written for the other agent. They are stored as one body, summary first,
  then a blank line, then the details (FR-048). A bare `body` still passes
  through for older callers.

Refusals:

| Condition | Code | Note |
|---|---|---|
| Caller's mode on the thread is `view` | `mode_denied` | Names the mode. Recorded. |
| `force: "binding"` from a member without authority | `rejected` | Never silently downgraded (SC-020). |
| Caller is paused | `paused` | Pause outranks mode (FR-039). |

### 1.2 `thread_open`

Open a thread.

```json
{ "type": "work_item", "title": "auth refactor", "workspace_id": "01J..." }
```

Returns the thread. `scope` is `project` in v1.

### 1.3 `thread_mode`

Read or set **the caller's own** mode on a thread.

```json
{ "thread_id": "01J...", "mode": "edit" }
```

Omitting `mode` reads the current value. Setting it writes only the caller's
own row.

**The relay MUST refuse any write whose author differs from the target member**
(SC-016). There is no input field for another member's id — the authorisation is
structural, not a parameter to be checked. This is the one part of the mode
system that is a boundary between members; the rest restrains only the caller's
own agent (research R1).

### 1.4 `thread_claim` and `thread_handoff`

Claims are thread-scoped and first-claim-wins is preserved (FR-013).

`thread_handoff` proposes a transfer:

```json
{ "thread_id": "01J...", "to": "shreyk2", "tip_ref": { "kind": "branch", "value": "aaudemarspiguet/auth" } }
```

The claim moves **only** when the recipient accepts. A recipient in `view` or
`comment` cannot accept; their agent surfaces the handoff instead (FR-044).

### 1.5 `workspace_status`

Gains `threads`, each with the caller's own mode and the thread's claim state.
Still answers while paused.

---

## 2. Relay protocol

### 2.1 Versioning

Every frame carries a protocol version from the first frame. A frame without one
is treated as pre-versioning v0 (FR-035). On mismatch the newer party produces
the plain instruction — a new relay refuses an old client with an upgrade
message; a new client reaching a pre-versioning relay tells its member the relay
host must upgrade first. No store is corrupted either way.

### 2.2 Per-thread streams

Delivery, cursors, and sequence numbers are per thread, not per workspace
(research R5).

A member's sequence numbers, cursors, and sync metadata MUST NOT reveal the
existence or the count of content outside their access (FR-008). In v1 every
thread is project scope, so nothing is out of access yet — but the streams are
built per thread now so that phase 3 adds scopes without a second rewrite.

### 2.3 Mode writes

The relay stores modes and enforces exactly one rule about them: the author of a
mode write must be the member the mode applies to. It does **not** enforce the
mode itself — see §3.

### 2.4 Authority

The relay checks authority when it accepts a `binding` message. In v1 the
authority source is the owner role (FR-005). A `binding` message from a member
without authority is rejected with a reason and recorded.

A `binding` message MUST NOT cause any run, redirect, or stop on another
member's machine (FR-043). The relay delivers it; it never acts on it.

---

## 3. Agent gate

Mode is enforced on the member's own machine, in the existing `agentGate()`
(`packages/cli/src/mcp/call.ts:76-90`), which today checks pause. It becomes an
ordered check:

```text
1. paused?              -> "paused"        (pause outranks mode)
2. action above mode?   -> "mode_denied"   (names the mode, recorded)
3. proceed
```

The relay does not duplicate this check. A mode is self-granted, so the party it
restrains and the party who could bypass it are the same member (research R1).

---

## 4. Hooks

`renderContext` (`packages/cli/src/hooks/inject.ts:36-90`) gains a block for
binding decisions addressed to this member. A receiving agent MUST surface such
a decision and MUST NOT silently ignore it (FR-043).

The block MUST state plainly that the decision settles the matter on the record
and does not direct this agent — the member decides what happens next, and may
dispute it in the thread. This preserves the existing "an input, not an order"
contract rather than contradicting it.

**Open for tasks**: a binding decision needs to persist across cursor advance
until answered, otherwise it is shown once and never again (research R6,
checklist CHK016).

---

## 5. CLI and web parity

Every member operation is available on both surfaces (FR-041):

| Operation | CLI | Web |
|---|---|---|
| open / join / mute a thread | yes | yes |
| read and set own mode | yes | yes |
| claim, release, handoff, accept, decline | yes | yes |
| post with `advisory` or `binding` force | yes | yes |
| see every member's mode on a thread | yes | yes |

Setting another member's mode appears on neither surface, in any form.
