# Implementation Plan: SAW Shared Workspace

**Branch**: `001-saw-shared-workspace` | **Date**: 2026-07-31 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-saw-shared-workspace/spec.md`

## Summary

SAW connects two developers' coding agents through a shared, human-visible
room. The build has five parts, all coordinated by one CLI (`saw`):

1. A **local MCP server** that exposes five coordination tools to the
   member's own coding agent: `room_read`, `room_post`, `work_log`,
   `peer_activity`, and `workspace_status`.
2. A **Claude Code hooks adapter** that injects unread room messages into
   the agent context (`SessionStart`, `UserPromptSubmit`), blocks tool calls
   while the member is paused (`PreToolUse`), and posts a run summary to the
   log automatically (`Stop`).
3. A small **relay service** (WebSocket + SQLite) that carries only JSON
   messages and git refs, stores the work log, and answers activity
   queries when a peer is offline.
4. A **local web interface** on localhost: live room view, human message
   box, log browser, presence, and a pause control.
5. **Git** remains the only code channel: each agent works on its own
   branch and pushes to the existing remote; merges are negotiated in the
   room. Member identity is a GitHub username bound by a signed invite
   link; no full OAuth flow yet.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 20+ (single language across
relay, CLI, MCP server, hooks adapter, and web UI; decision in
[research.md](./research.md) §1)

**Primary Dependencies**: `@modelcontextprotocol/sdk` (MCP server, stdio
transport), `ws` (WebSocket relay + client), `better-sqlite3` (relay
storage), `zod` (boundary schema validation), `commander` (CLI). Web UI is
framework-free static HTML/JS served by the local daemon.

**Storage**: SQLite at the relay (messages, refs, log, members, claims,
pause state). Local: `.saw/` config folder per member (JSON config +
credential); no local database.

**Testing**: `vitest` for unit and contract tests; integration tests drive
two simulated members against a real relay instance in-process.

**Target Platform**: Developer machines (Windows/macOS/Linux) for CLI,
daemon, MCP server, hooks, and web UI; any small Node-capable host for the
self-hostable relay.

**Project Type**: Monorepo: one service (relay) + one CLI/daemon package +
one shared protocol package + static web UI.

**Performance Goals**: Redirect message delivered to target agent in <5 s
(SC-006); peer-activity answer in <30 s while peer offline (SC-004); 100%
of boundary-violating payloads rejected and logged (SC-005); message
history delivered in order after 24 h offline (SC-007).

**Constraints**: Only JSON messages and git refs cross the relay — never
code, file contents, file access, or execution control. Relay must stay
small and self-hostable. No forking/wrapping of coding tools; integration
only via MCP, hooks, and git. All code documentation in ASD-STE Simplified
Technical English.

**Scale/Scope**: Two members per workspace; one workspace per repository;
message volume in the hundreds per day; log retained for workspace
lifetime.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Gate result | Evidence in this plan |
|---|-----------|-------------|-----------------------|
| I | Coordination layer, not a coding agent | PASS | All five MCP tools coordinate (read/post/query); none generate, edit, or execute code. Connection to agents is via MCP only. |
| II | Messages and refs only | PASS | Relay schema (contracts/relay-protocol.md) admits only typed JSON messages with optional refs (branch name or commit SHA). Zod validation rejects and logs everything else (FR-008). |
| III | Human visibility and steering | PASS | Web UI shows full room history live; human message box posts redirects; pause control for own agent only. No agent-only channels exist in the protocol. |
| IV | Automatic, explained, traceable logging | PASS | Stop hook posts run summaries mechanically; relay records every message, claim, rejection, and run with what/when/why/feature tag. No agent self-reporting required. |
| V | Standards, not forks | PASS | Claude Code is integrated only through its documented hooks and MCP registration. No fork, wrapper, or custom runtime. Git is used as-is. |
| VI | Git is the only code sync | PASS | SAW never moves code. Handoffs carry branch names/SHAs; agents fetch from the existing remote on their own branches. No live file editing paths exist. |
| VII | Open core, small relay | PASS | Relay is one small WS+SQLite service with no hosted-only features; `saw` can point at any self-hosted relay URL. |
| — | ASD-STE documentation | PASS (process) | All READMEs, code comments, and user guides written in STE; checked at review per constitution workflow gates. |

**Post-design re-check (after Phase 1)**: PASS — the data model contains no
entity that stores code or file contents; the relay protocol has no frame
for file transfer or execution; the hooks adapter only reads local state
and posts summaries. No violations to justify.

## Project Structure

### Documentation (this feature)

```text
specs/001-saw-shared-workspace/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── mcp-tools.md     # The five MCP tool schemas
│   ├── relay-protocol.md# WebSocket frames + boundary rules
│   ├── cli.md           # saw init / join / up
│   └── hooks-adapter.md # Claude Code hook contract
└── tasks.md             # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
packages/
├── shared/                  # Protocol types + zod schemas (one source of truth)
│   ├── src/
│   │   ├── messages.ts      # Message, types enum, refs, validation
│   │   ├── frames.ts        # Relay WebSocket frame schemas
│   │   ├── log.ts           # RunLogEntry, rejection entries
│   │   └── invite.ts        # Signed invite payload + verification helpers
│   └── tests/
├── relay/                   # Small self-hostable relay service
│   ├── src/
│   │   ├── server.ts        # WebSocket endpoint + auth
│   │   ├── store.ts         # SQLite schema + queries
│   │   ├── boundary.ts      # Accept messages+refs; reject and log all else
│   │   └── presence.ts      # Member online/offline tracking
│   └── tests/
├── cli/                     # The `saw` command + local daemon
│   ├── src/
│   │   ├── commands/        # init.ts, join.ts, up.ts
│   │   ├── daemon/          # Relay client, pause cache, local state
│   │   ├── mcp/             # MCP server: the five tools (stdio)
│   │   ├── hooks/           # Claude Code hooks adapter entry points
│   │   └── web/             # Localhost UI server + static assets
│   │       └── static/      # index.html, app.js, style.css (no build step)
│   └── tests/
└── tests/
    └── integration/         # Two-member end-to-end scenarios vs real relay
```

**Structure Decision**: Monorepo with three packages. `shared` holds every
schema so the relay and the CLI validate with identical rules — the
messages-and-refs-only boundary is defined once. `relay` stays deliberately
tiny (Principle VII). `cli` bundles daemon, MCP server, hooks adapter, and
static web UI because they ship and run together on the member's machine
via `saw up`.

## Complexity Tracking

No constitution violations; table not needed.
