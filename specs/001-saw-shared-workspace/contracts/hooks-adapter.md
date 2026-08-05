# Contract: Claude Code Hooks Adapter

The adapter is a set of `saw hook <event>` entry points registered in the
workspace's `.claude/settings.json` by `saw up`. Each hook reads the
Claude Code hook JSON on stdin, talks only to the local daemon over
localhost HTTP, and answers with hook JSON on stdout. Hooks never talk to
the relay directly and never read the peer's data.

If the daemon is not running, every hook exits 0 with no output (the agent
works normally, uncoordinated; `workspace_status` is how agents notice SAW
is down). Hook failures must never break the member's coding tool
(Principle V: no wrapping, no interference).

## 1. SessionStart → `saw hook session-start`

Purpose: give the agent its coordination context at session open.

Output (stdout JSON, `hookSpecificOutput.additionalContext`):

- A short STE preamble pointing at `.saw/AGENT.md`.
- All unread room messages (seq > ReadCursor.last_injected_seq), rendered
  compactly with sender, type, body, refs.
- Current claim state and own pause state.

Side effect: the daemon advances the ReadCursor, but only after the hook
acknowledges delivery (see Injection is two-phase, below).

## 2. UserPromptSubmit → `saw hook prompt-submit`

Purpose: inject messages that arrived since the last injection, at the
next turn boundary. (Chosen over PostToolUse — research.md §3.)

Output: `additionalContext` with unread messages only; empty output when
nothing is unread. Side effect: advances the ReadCursor after the
acknowledgement (see Injection is two-phase, below).

Also: the daemon records the submitted prompt as the candidate
`why_trigger` for this run (data-model.md §RunLogEntry).

## Injection is two-phase

The two injection hooks fetch and then acknowledge. The daemon moves the
ReadCursor only on the acknowledgement.

1. The hook asks the daemon for unread messages. The daemon answers with the
   messages and an `ack_seq`. The cursor does not move.
2. The hook writes its `additionalContext` to stdout.
3. The hook sends `ack_seq` back to the daemon. The daemon moves the cursor.

A hook that stops between step 1 and step 3 loses nothing. The same messages
arrive at the next turn boundary. Delivery is at least once.

The first design moved the cursor in step 1. A hook that was killed, or whose
stdout was dropped, marked those messages read and no agent ever saw them.
Duplicate context is cheap. A lost message is not (FR-011, SC-007).

## 3. PreToolUse → `saw hook pre-tool`

Purpose: block coordinated work while the member is paused (FR-013/014).

Behavior:

- Daemon paused → stdout:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny",
  "permissionDecisionReason": "SAW: your workspace member state is paused. Resume from the SAW web page." } }
```

- Not paused → exit 0, no output (tool call proceeds untouched).

Matcher: `*` (all tools) — pause means the agent makes no further tool call
of any kind, not only no further SAW tool call, and the denial continues for
the rest of a run already in progress (Constitution III, FR-014, SC-006).
The hook cannot interrupt a tool call that is already executing; that would
need lifecycle control of the coding tool, against Principles I and V. So
one call in progress may complete, and every call after it is denied.

## 4. Stop → `saw hook stop`

Purpose: post the automatic run summary (FR-015/016).

Behavior:

1. Reads hook input (transcript path, session id).
2. Computes the mechanical summary (research.md §8): tool-use counts from
   the transcript, current branch name, head SHA, changed-file count via
   `git status --porcelain`. Counts and git refs only; file paths and file
   contents never enter the summary.
3. Sends `{ started_at, ended_at, what, why_trigger, work_item }` to the
   daemon; the daemon forwards a `log_append` frame to the relay.
4. Exit 0 always; a logging failure is reported to the daemon's own log,
   never surfaced as an agent error.

## Registration shape (written by `saw up`)

```json
{
  "hooks": {
    "SessionStart":     [ { "hooks": [ { "type": "command", "command": "saw hook session-start" } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "saw hook prompt-submit" } ] } ],
    "PreToolUse":       [ { "matcher": "*", "hooks": [ { "type": "command", "command": "saw hook pre-tool" } ] } ],
    "Stop":             [ { "hooks": [ { "type": "command", "command": "saw hook stop" } ] } ]
  }
}
```

## Other tools (Codex, Cursor)

The MCP server works for any MCP-capable tool today. Hook-equivalent
adapters for Codex/Cursor are separate future adapters behind the same
daemon HTTP endpoints; nothing in this contract is Claude-Code-specific
except the registration shape.
