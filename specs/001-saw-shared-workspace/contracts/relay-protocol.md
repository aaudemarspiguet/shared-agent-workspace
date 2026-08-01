# Contract: Relay WebSocket Protocol

One WebSocket endpoint: `wss://<relay-host>/ws`. Text frames, JSON only.
Every frame is validated against shared zod schemas before processing.
Anything that is not a valid frame is rejected and logged
(BoundaryRejection). The relay carries only messages and refs — it has no
frame for files, code, diffs, or execution.

## Connection and auth

Client (daemon) connects and must send `hello` first:

```json
{ "kind": "hello", "workspace_id": "01H...", "token": "<bearer>", "client": "saw-daemon/0.1" }
```

Relay replies:

```json
{ "kind": "hello_ok", "member": "alice", "latest_seq": 124, "paused": false }
```

or closes with `{ "kind": "error", "code": "auth_failed" }`.

Sender identity is always taken from the authenticated connection. A frame
may not name another member as its sender.

## Client → relay frames

| kind | Purpose | Payload |
|------|---------|---------|
| `post` | Post a room message | `{ type, body, refs?, work_item?, target? }` (Message rules in data-model.md) |
| `sync` | Request messages after a seq | `{ since_seq }` — used on reconnect; relay streams `message` frames in order (SC-007) |
| `log_append` | Append a RunLogEntry (from Stop hook) | RunLogEntry fields minus id/workspace |
| `log_query` | Query log / peer activity | `{ member?, work_item?, since?, limit? }` |
| `pause_set` | Set own pause state | `{ paused: true\|false }` — only affects the sender's member |
| `ping` | Keepalive | `{}` |

## Relay → client frames

| kind | Purpose | Payload |
|------|---------|---------|
| `message` | New or synced room message | Full Message (with `seq`) |
| `post_ok` / `post_rejected` | Result of `post` | `{ seq }` / `{ reason, summary }` |
| `claim_result` | Claim outcome on intent posts | `{ work_item, granted: bool, claimed_by }` — rejections broadcast to both members |
| `log_ok` | Log append accepted | `{ id }` |
| `log_result` | Answer to `log_query` | `{ entries: [...] }` |
| `presence` | Member online/offline change | `{ member, online, last_seen_at }` |
| `pause_state` | Pause change (own or after reconnect) | `{ member, paused }` |
| `error` | Protocol/auth error | `{ code, message }` |

## Ordering and delivery rules

1. The relay assigns a gapless per-workspace `seq` to every accepted
   message; all delivery is in `seq` order.
2. Claims resolve strictly in `seq` order: first claim wins (FR-006a).
3. Messages for an offline or paused member are stored; `sync` after
   reconnect/unpause replays 100% of missed messages in order (FR-014,
   SC-007).
4. `log_query` is answered from SQLite regardless of any member's
   connection state (FR-019).

## Boundary enforcement (relay side)

Applied to `post` bodies and all frames (rules mirrored in
data-model.md §Boundary rules):

- Unknown frame kind, unknown message type, invalid ref format, body
  >4000 chars, non-JSON frame, or smuggling heuristics (long fenced code,
  diff markers, long base64) → reject frame, send `post_rejected`/`error`,
  write BoundaryRejection log entry. The rejected body is never stored or
  echoed.
- Target for SC-005: 100% of such payloads rejected and logged.

## Availability behavior (deferred item from clarify)

The relay is a single small process. If it is down, daemons retry with
backoff; agents see `relay_connected: false` in `workspace_status` and
continue local work; nothing is lost because posts fail fast (no local
outbox in v1). Durable relay-side storage plus `sync` covers recovery.
