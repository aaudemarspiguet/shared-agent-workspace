# Contract: MCP Tools

The local MCP server (started by `saw up`, stdio transport) exposes exactly
five tools to the member's own coding agent. All inputs and outputs are
JSON. The server talks only to the member's own daemon; it has no access to
the peer's machine.

Common error shape (all tools):

```json
{ "error": { "code": "paused|not_connected|invalid_input|rejected", "message": "..." } }
```

While the member is paused, every tool except `workspace_status` returns
`paused`.

Every tool call presents the run token from `.saw/daemon.json`, because the
local API accepts only software the member started for this workspace (T057,
FR-021; see contracts/cli.md "Local surface authentication"). A refused call
keeps the daemon's own message, which names the repair, and reports the code
`not_connected`: the code set above is closed, and a daemon the tool may not
call is a daemon it cannot reach.

## 1. room_read

Read room messages, newest last, in relay `seq` order.

Input:

```json
{
  "since_seq": 123,        // optional; default: last injected cursor
  "limit": 50,             // optional; 1–200, default 50
  "work_item": "login-form" // optional; only messages for this feature tag
}
```

`work_item` is a view. It narrows the messages of the page. `latest_seq`
still reports the latest `seq` of the whole room, and the read cursor does
not move.

Output:

```json
{
  "messages": [
    {
      "seq": 124,
      "sender": "alice",            // github_username
      "sender_kind": "agent",       // "agent" | "human"
      "type": "handoff",            // intent|question|decision|handoff|status
      "body": "Login form is ready for review.",
      "refs": [ { "kind": "branch", "value": "alice/login-form" } ],
      "target": "bob",              // optional; set on redirects
      "work_item": "login-form",    // optional feature tag
      "sent_at": "2026-07-31T14:02:11Z"
    }
  ],
  "latest_seq": 124
}
```

## 2. room_post

Post one message to the room. This is the only way an agent sends anything
to the peer.

Input:

```json
{
  "type": "intent",                  // required; one of the five types
  "summary": "I will take the login form.",   // for the humans: plain, a few sentences
  "details": "Branch alice/login-form off main; T031 scope.",  // optional; for the other agent
  "body": "...",                     // older callers only; summary + details replace it
  "refs": [ { "kind": "commit", "value": "a1b2c3d" } ],  // optional, ≤10
  "work_item": "login-form"          // optional feature tag; claims use this
}
```

`summary` and `details` are stored as one body — summary first, a blank
line, then the details — and together must fit 4000 characters. Surfaces
that fold a post show the summary; the other agent receives both.

Output (accepted):

```json
{ "seq": 125, "sent_at": "2026-07-31T14:03:00Z" }
```

Output (boundary rejection — also logged at the relay):

```json
{ "error": { "code": "rejected", "message": "content_smuggling: diff detected in body" } }
```

Claim semantics: a `type:"intent"` post with a `work_item` that is `open`
claims it. If the item is already claimed, the post is accepted as a
message but the claim fails with a visible `claim_rejected` notice
(first claim wins).

## 3. work_log

Query the work log (the stored RunLogEntry records).

Input:

```json
{
  "member": "any",                 // "me" | "peer" | "any" (default)
  "work_item": "login-form",       // optional filter by feature tag
  "since": "2026-07-30T00:00:00Z", // optional
  "limit": 50                      // optional; 1–200
}
```

Output:

```json
{
  "entries": [
    {
      "member": "bob",
      "started_at": "2026-07-30T09:00:00Z",
      "ended_at": "2026-07-30T09:14:21Z",
      "what": { "tools_used": { "Edit": 12, "Bash": 4 }, "branch": "bob/api", "head": "d4e5f6a", "files_changed": 7 },
      "why_trigger": "Redirect from alice: switch to the API",
      "work_item": "api-endpoints",   // or "unassigned"
      "source": "hook_stop"
    }
  ]
}
```

## 4. peer_activity

Answer "what did my teammate's agent do since X". Served from relay
storage; works while the peer is offline.

Input:

```json
{ "since": "2026-07-30T00:00:00Z" }   // required
```

Output:

```json
{
  "peer": "bob",
  "peer_online": false,
  "runs": [ /* RunLogEntry summaries, same shape as work_log */ ],
  "messages": [ /* peer's room messages in the window, same shape as room_read */ ],
  "note": "Answer built from stored workspace history only."
}
```

If there is no recorded activity, `runs` and `messages` are empty arrays —
the agent must report "no recorded activity", never guess.

## 5. workspace_status

Snapshot of workspace state. Always available, even while paused.

Input: `{}`

Output:

```json
{
  "workspace": "saw-demo",
  "repo_remote": "git@github.com:acme/app.git",
  "members": [
    { "github_username": "alice", "online": true,  "paused": false },
    { "github_username": "bob",   "online": false, "paused": false }
  ],
  "me": "alice",
  "paused": false,
  "unread_count": 3,
  "work_items": [
    { "feature_tag": "login-form", "state": "claimed", "claimed_by": "alice" }
  ],
  "relay_connected": true
}
```
