# Research: SAW Shared Workspace

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Date**: 2026-07-31

Each item records: Decision, Rationale, Alternatives considered. All
NEEDS CLARIFICATION items from Technical Context are resolved here.

## 1. Language and runtime

- **Decision**: TypeScript 5.x on Node.js 20+, one language for all
  packages.
- **Rationale**: The official MCP TypeScript SDK is first-class and stdio
  transport is trivial there. Hooks adapters, the WebSocket relay, the CLI,
  and a static web UI all sit naturally in one Node toolchain, which keeps
  the relay small and the contributor surface single-language.
- **Alternatives considered**: Python (official MCP SDK exists, but the
  localhost web UI and WS client story adds more dependencies); Go (fast
  single binary, but MCP SDK maturity and shared-schema reuse with the web
  UI are weaker). Rejected to avoid a two-language core.

## 2. MCP transport between agent and local server

- **Decision**: stdio. `saw up` registers/starts the MCP server so Claude
  Code (and Codex/Cursor, which also speak stdio MCP) launch or attach to
  it as a local stdio server.
- **Rationale**: stdio is the lowest-friction, best-supported MCP transport
  across all three target tools and needs no local port or auth.
- **Alternatives considered**: Streamable HTTP (useful if the daemon must
  outlive the agent process; deferred — the daemon holds state, the MCP
  process is a thin client to the daemon, so stdio restarts are cheap).

## 3. Second injection hook: UserPromptSubmit vs PostToolUse

- **Decision**: `UserPromptSubmit`.
- **Rationale**: It fires at a natural turn boundary, so unread room
  messages arrive exactly when the agent starts new work, with one
  injection per turn. `PostToolUse` fires on every tool call, which floods
  the context with repeated injections and adds token cost with no
  ordering benefit.
- **Alternatives considered**: `PostToolUse` (rejected for noise/cost).
  A forced mid-run injection path was also rejected on principle: it works
  against the tool's own execution loop, which the constitution's
  no-wrapping rule (Principle V) forbids. SC-006 therefore promises
  delivery to the member's local delivery point in <5 s plus presentation
  at the next turn boundary — never mid-turn forcing.

## 4. WebSocket implementation

- **Decision**: `ws` package on the relay; `ws` client in the daemon.
  JSON text frames only; every frame validated with zod schemas from
  `packages/shared` before any processing.
- **Rationale**: `ws` is the standard minimal Node WebSocket library; no
  framework needed for one endpoint. Shared zod schemas make the
  messages-and-refs-only boundary a single definition used on both sides.
- **Alternatives considered**: Socket.IO (adds protocol weight and
  fallbacks we do not need); raw HTTP polling (worse latency for the <5 s
  redirect target).

## 5. Relay storage

- **Decision**: `better-sqlite3`, one database file per relay, WAL mode.
- **Rationale**: Synchronous API keeps the relay code short and ordered
  writes trivial, which matters for "first claim recorded wins."
  Single-file storage keeps self-hosting one-step.
- **Alternatives considered**: `node:sqlite` (attractive zero-dependency
  path, but API stability across Node versions in the support window is
  weaker); Postgres (operationally heavy for a two-member relay —
  violates "keep the relay small" in spirit).

## 6. Member identity and signed invite links

- **Decision**: Member identity is a declared GitHub username. The
  workspace creator mints an invite link: base64url payload (workspace id,
  invitee GitHub username, expiry, nonce) + HMAC-SHA256 signature with a
  per-workspace secret held by the relay. `saw join <link>` presents it;
  the relay verifies the signature and expiry, then issues that member a
  random per-member bearer token (stored hashed) used on every WebSocket
  connection thereafter.
- **Rationale**: Matches the spec clarification (invite + per-member
  credential; git-host sign-in deferred) and the user's direction (GitHub
  identity as the name, signed links, no full OAuth yet). HMAC links are
  verifiable offline by the relay with no third-party dependency.
- **Alternatives considered**: Full GitHub OAuth (explicitly deferred);
  shared workspace secret (rejected — no per-member identity, breaks
  own-agent-only pause and log attribution).

## 7. Local web interface approach

- **Decision**: Static HTML + vanilla JS + CSS served by the daemon on
  localhost; live updates over a WebSocket to the daemon. No build step,
  no framework.
- **Rationale**: The UI is one screen (room, message box, log browser,
  presence, pause). A no-build static page keeps the open-source core
  approachable and the install zero-config. The daemon already holds live
  state, so it is the natural server.
- **Alternatives considered**: React/Vite app (build tooling and
  dependency weight unjustified at this scope); serving the UI from the
  relay (rejected — pause and presence are member-local concerns, and the
  UI must work with a self-hosted remote relay).

## 8. Run capture: "what", "when", "why" mechanics

- **Decision**: The `Stop` hook composes the run summary mechanically:
  - *what*: tools-used counts from the transcript, current branch name,
    latest commit SHA, and changed-file count from `git status --porcelain`
    (counts and git refs only — never file paths or file contents).
  - *when*: run start/end timestamps from hook events.
  - *why*: the triggering instruction (the user prompt or injected room
    message that started the turn) plus the member's active claimed work
    item, per the spec clarification.
  - The daemon posts this to the relay log; the agent takes no logging
    action itself.
- **Rationale**: Every field is captured from hook inputs, git metadata,
  or daemon state — nothing depends on the agent volunteering a report
  (FR-015/FR-016). File names/counts are metadata, not code, so the
  boundary holds.
- **Alternatives considered**: LLM-written summaries (rejected: reopens
  trust in agent self-reporting and adds cost); full transcript upload
  (rejected: would push code/file contents through the relay — forbidden).

## 9. Pause enforcement

- **Decision**: Pause state lives at the relay (authoritative, set from
  the member's own UI), mirrored in the daemon. The `PreToolUse` hook asks
  the daemon over a local HTTP endpoint and returns a deny decision while
  paused; the daemon also stops posting for a paused member and queues
  inbound messages for delivery on resume.
- **Rationale**: Hook-level denial stops coordinated actions before they
  run even mid-turn; the queue satisfies store-and-deliver-on-resume
  (FR-014). Relay authority means the paused state survives daemon
  restarts.
- **Alternatives considered**: Pause enforced only at the MCP tools
  (rejected: would not stop non-SAW tool calls during a paused run, and
  the user's design names PreToolUse blocking explicitly).

## 10. Offline peer-activity answers

- **Decision**: `peer_activity(since)` and the log browser query the relay
  directly; the relay serves them from SQLite regardless of the peer's
  connection state.
- **Rationale**: The relay durably stores every message, ref, claim, and
  run log entry as they happen, so the peer's machine is never needed at
  question time (FR-018/FR-019, SC-004).
- **Alternatives considered**: Peer-to-peer history sync between daemons
  (rejected: fails exactly when the peer is offline — the case the spec
  requires to work).

## 11. CLI framework and `.saw/` layout

- **Decision**: `commander` for `saw init|join|up`. `saw init` writes
  `.saw/config.json` (workspace id, relay URL, GitHub username, repo
  remote, branch prefix), `.saw/credential` (bearer token, git-ignored),
  and `.saw/AGENT.md` — the STE-written instruction file that tells the
  connected agent how to use the five tools and the room conventions.
- **Rationale**: `commander` is the boring standard. A dedicated
  instruction file makes agent onboarding tool-agnostic: any MCP-capable
  agent reads the same contract.
- **Alternatives considered**: `yargs`/`oclif` (heavier); storing the
  credential inside config.json (rejected: config is committed-shareable,
  the credential must never be).

## 12. Documentation language tooling (ASD-STE)

- **Decision**: Write all READMEs, code comments, and `.saw/AGENT.md` in
  STE style (short sentences, one idea per sentence, active voice, simple
  words). Enforce by review checklist; no automated STE checker in v1.
- **Rationale**: Licensed STE checkers are commercial; a review checklist
  gate (already in the constitution's workflow section) is sufficient at
  this scale.
- **Alternatives considered**: Automated linters (textlint terminology
  rules approximate STE poorly; revisit later).
