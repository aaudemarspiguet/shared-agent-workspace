<!--
Sync Impact Report (2.0.0)
- Version change: 1.2.0 -> 2.0.0 (MAJOR: two principles redefined in
  backward-incompatible ways)
- Modified principles:
  - Preamble - "one codebase" becomes "one or more codebases". SAW v1
    (spec 002) groups workspaces into projects that span repositories.
  - II. Messages and Refs Only -> II. Messages, Refs, and Journal Entries
    Only. A third payload kind may cross: the journal entry, a distilled
    record of one agent run. Why MAJOR: 1.x commands the relay to reject
    any payload that is not a message or a ref, so a 2.0-compliant relay
    that accepts journal entries violates the 1.x letter. The protections
    move into the definition: an entry is distilled by the member's own
    tooling, bounded, visible to its author, scope-bound, and revocable.
    Raw transcripts, code, file contents, file access, and execution
    control stay banned by name. The ref definition widens to include
    ticket locators (spec 002 connectors replicate thread-ticket
    bindings), and scope-crossing is permitted only through deliberate,
    recorded, participant-enabled export mechanisms.
  - IV. Automatic, Explained, Traceable Logging - one clause added
    reconciling IV with II's author control: capture is automatic on the
    member's machine; withheld/revoked entries keep tombstones, so the
    record stays complete while content stays under author control.
  - III. Human Visibility and Steering - "visible to both humans" becomes
    "visible to every human in the message's scope". Why MAJOR: 1.x made
    workspace-wide visibility the definition of no-hidden-channels; 2.0
    permits group and private thread scopes, which 1.x would read as
    hidden channels. The invariant is restated scope-relative: within a
    scope, nothing is hidden from any human in it, and agents can never
    see more than their humans. Scopes are project, team, group, and
    private thread. Pause/stop is pinned to one's own agent, and the
    relay host's read access plus recorded cross-scope powers are named.
- Added sections: none
- Removed sections: none
- Downstream sync: specs/002-saw-v1/spec.md is written against this text
  (FR-015..021 journals, FR-008/FR-017 scopes) and is gated on this
  amendment. spec 001 statements ("exactly two members", room-wide
  visibility) are superseded by spec 002, not edited. No shipped code
  changes with this amendment; the 002 schema rewrite implements it.
- Deferred TODOs: none

Sync Impact Report (1.2.0)
- Version change: 1.1.0 → 1.2.0 (MINOR: guidance materially changed)
- Modified principles: III. Human Visibility and Steering — the 1.1.0 pause
  definition demanded an outcome the same paragraph then ruled out. "It
  blocks every tool call ... including work already in flight" requires
  control of the coding tool's process lifecycle, which Principle I and
  Principle V forbid, and which the rationale of Principle III itself already
  concedes is out of scope. The mandated control is restated as what a
  hook-based integration can deliver and does deliver: every subsequent tool
  call is denied, including the rest of a run already in progress. The
  strength the 1.1.0 amendment was reaching for is kept — a pause that lets
  the current run finish is still not a pause.
- Added sections: none
- Removed sections: none
- Why MINOR: nothing is removed from the mandated control set, and no spec,
  plan, or code that complied with 1.1.0 stops complying under 1.2.0, so this
  is not backward-incompatible under the Versioning rule below. It is not
  PATCH, because the meaning does change. A maintainer who reads narrowing a
  MUST as redefining a principle should make this 2.0.0; nothing else in the
  change would differ.
- Downstream sync: spec.md SC-006 promised the weaker "before the next
  coordinated action" and is corrected in the same change. FR-014 already
  matched and gains one clause. The built PreToolUse hook already implements
  the amended text; no code change follows from this.
- Deferred TODOs: none

Sync Impact Report (1.1.0)
- Version change: 1.0.0 → 1.1.0 (MINOR: guidance materially expanded)
- Modified principles: III. Human Visibility and Steering — "stop" was listed
  as a separate mandated control but was never defined, and no requirement or
  task in specs/001-saw-shared-workspace covered it. Pause and stop are now
  stated as one control, and the pause definition is made explicit: it blocks
  every tool call including work already in flight. Rationale adds that
  lifecycle control of the coding tool stays out of scope (Principles I, V).
- Added sections: none
- Removed sections: none
- Nothing is removed from the mandated control set, so this is MINOR, not
  MAJOR under the Versioning rule below.
- Downstream sync: spec.md FR-014 already matched this definition;
  spec.md edge case "pause mid-run" corrected in the same change.
- Deferred TODOs: none

Sync Impact Report (1.0.0)
- Version change: [template] → 1.0.0
- Modified principles: n/a (initial ratification; all placeholders filled)
- Added sections:
  - Core Principles (7): I. Coordination Layer, Not a Coding Agent;
    II. Messages and Refs Only; III. Human Visibility and Steering;
    IV. Automatic, Explained, Traceable Logging; V. Standards, Not Forks;
    VI. Git Is the Only Code Sync; VII. Open Core, Small Relay
  - Additional Constraints: Documentation Language (ASD-STE)
  - Development Workflow & Quality Gates
  - Governance
- Removed sections: none (template slots SECTION_2 / SECTION_3 filled with
  concrete content)
- Deferred TODOs: none
-->

# SAW Constitution

SAW is a multiplayer coordination layer for agentic coding tools. It lets two
or more people, each running their own coding agent, work together on one or
more codebases. SAW coordinates. It does not code.

## Core Principles

### I. Coordination Layer, Not a Coding Agent

SAW MUST NOT build a coding agent. SAW MUST NOT replace a coding agent. SAW
MUST NOT compete with existing coding agents. SAW MUST connect to existing
tools such as Claude Code, Codex, and Cursor. SAW MUST use MCP as the
connection mechanism. Any feature that generates, edits, or executes code on
behalf of a member violates this principle and MUST be rejected.

**Rationale**: The value of SAW is coordination between agents that already
exist. Building or wrapping an agent duplicates mature tools and couples SAW
to their release cycles.

### II. Messages, Refs, and Journal Entries Only

Only three kinds of data may cross between members: messages, refs, and
journal entries. A ref is a branch name, a commit SHA, or a ticket locator
(provider, ticket id, URL). A journal entry is
a distilled record of one agent run — what was done, what was decided, what
is open, and refs. A journal entry MUST be produced by the member's own
tooling on the member's own machine. It MUST be bounded in size. It MUST be
visible to its author before or as it crosses, and the author MUST be able
to withhold it, exclude source stretches of the conversation from its
distillation, strike parts of it, and revoke it after it crossed. It MUST
carry the scope of its thread and MUST NOT be served at a wider scope,
except through a deliberate, recorded export mechanism that the thread's
participants enabled. SAW
MUST NEVER send raw transcripts between members. SAW MUST NEVER send code
between members. SAW MUST NEVER send file contents between members. SAW
MUST NEVER send file access between members. SAW MUST NEVER send execution
control between members. Any payload that is not a message, a ref, or a
journal entry MUST be rejected at the protocol boundary.

**Rationale**: A narrow channel keeps the trust model simple. Each member's
machine, files, and agent stay under that member's sole control. Journal
entries widen what the channel says, not what it can take: they carry
distilled, human-inspectable text under the author's control, so the
member — not the agent, not the peer — decides what the team learns. Code
moves only through git (Principle VI), never through SAW.

### III. Human Visibility and Steering

Every agent-to-agent message MUST be visible to every human in the
message's scope. A scope is the project, a named team or group of members,
or the participants of a private thread. Within a scope, no hidden
channels, side
channels, or agent-only exchanges are permitted: an agent MUST NOT be able
to read anything its human cannot read. Any human in a scope MUST be able
to steer the conversation there at any time. Steering controls (inject a
message, pause/stop their own agent, redirect) MUST be available to each
human at every point in a session. The member who hosts the relay can read
every scope it relays; any power that serves content across a scope
boundary MUST be recorded and visible to that scope's participants. A pause MUST stop the agent, not only its next
coordinated action. From the moment a pause takes effect, SAW MUST deny
every later tool call of that member's coding tool — SAW tool calls and all
others alike — including the remaining tool calls of a run already in
progress. A pause MUST NOT wait for the current run to end. One tool call
that is already executing when the pause arrives may complete; the pause
MUST take effect no later than that call.

**Rationale**: Humans stay accountable for what their agents do. Visibility
and interruptibility are the mechanisms that make that accountability real.
Scopes narrow the audience, never the symmetry: everyone inside a scope
sees everything inside it, and nobody's agent outruns its human.
Pause and stop are one control, not two. A pause that lets the current run
finish is not a pause, so the block must cover the rest of that run.
Lifecycle control of the coding tool itself stays out of scope: to terminate
a member's tool, or to interrupt a tool call already executing, SAW would
have to wrap it, against Principles I and V. Denying every later tool call
is the strongest control the documented hook surface offers, so it is what
this principle demands. Demanding more would demand a violation of two other
principles.

### IV. Automatic, Explained, Traceable Logging

The system MUST log every action. Each log entry MUST state what happened.
Each log entry MUST state why it happened. Each log entry MUST be tagged to a
feature or story. Log capture MUST be automatic — SAW MUST NOT rely on agents
to log manually. A code path that performs an action without emitting a log
entry is a defect.

**Rationale**: Multiplayer agent work is hard to reconstruct after the fact.
Manual logging fails silently; only automatic capture at the system level
produces a trustworthy record. Author control (Principle II) governs
content, not existence: capture stays automatic on the member's own
machine even when nothing crosses, and a withheld or revoked entry keeps a
tombstone — author, timestamps, and the fact of withholding — so the
record stays complete while content stays under the author's control.

### V. Standards, Not Forks

SAW MUST NOT fork the underlying tool. SAW MUST NOT wrap the underlying tool.
SAW MUST NOT build a custom agent runtime. SAW MUST use existing standards:
MCP for agent connection, git for code movement, and hooks for tool
integration. When a need arises, the first question is "which existing
standard covers this?" — building a bespoke mechanism requires a documented
finding that no standard fits.

**Rationale**: Forks and wrappers rot as upstream tools evolve. Standards
keep SAW compatible with every tool that speaks them, including tools that do
not exist yet.

### VI. Git Is the Only Code Sync

Code sync between members MUST use git. Each agent MUST work on its own
branch. Each agent MUST push to the existing remote. SAW MUST NOT allow live
file editing between agents. SAW MUST NOT introduce its own file transfer,
sync, or collaborative-editing mechanism.

**Rationale**: Git already provides durable history, review points, and
conflict resolution. Branch-per-agent isolation means members integrate work
deliberately through refs (Principle II), never accidentally through shared
files.

### VII. Open Core, Small Relay

The core system MUST be open source. The hosted relay MUST stay small. The
relay MUST be self-hostable. Features MUST land in the open core by default;
a feature may live only in the hosted relay when it is strictly about
operating the hosted service. Any relay change that would break self-hosting
MUST be rejected.

**Rationale**: Members route their coordination traffic through the relay.
Trust in that path requires that anyone can read the code and run their own
relay.

## Additional Constraints

### Documentation Language (ASD-STE)

All code documentation in this project MUST follow ASD-STE Simplified
Technical English:

- Use short sentences.
- Use one idea per sentence.
- Use active voice.
- Use approved simple words.
- Do not use a complex word when a simple word exists.

This applies to README files, code comments, API documentation, and user
guides. Reviewers MUST flag documentation that does not comply.

## Development Workflow & Quality Gates

- Every feature spec, plan, and PR MUST be checked against the Core
  Principles before approval. A reviewer who finds a violation MUST block the
  change until it is removed or the constitution is amended first.
- Protocol changes MUST show that only messages, refs, and journal entries
  cross the member boundary (Principle II). Tests MUST cover rejection of
  non-conforming payloads, and MUST cover that journal entries honor
  author control (withhold, strike, revoke) and scope.
- New integrations MUST connect through MCP, git, or hooks (Principle V). An
  integration that requires forking or wrapping a tool MUST NOT be merged.
- Every merged change MUST keep automatic log capture intact (Principle IV).
  A change that adds an action without a corresponding automatic log entry
  MUST NOT be merged.
- Relay changes MUST be verified against a self-hosted deployment before
  release (Principle VII).

## Governance

This constitution supersedes all other project practices. When a practice
conflicts with a principle, the principle wins.

**Amendments**: Any contributor may propose an amendment as a PR against this
file. The PR MUST state the motivation, the exact text change, and the
migration impact on existing specs, plans, and code. Amendments require
maintainer approval before merge.

**Versioning**: This document follows semantic versioning. MAJOR for removing
or redefining a principle in a backward-incompatible way. MINOR for adding a
principle or materially expanding guidance. PATCH for clarifications and
wording fixes that do not change meaning.

**Compliance review**: All PRs and reviews MUST verify compliance with this
constitution. Complexity MUST be justified against the principles; when in
doubt, choose the option that keeps SAW smaller.

**Version**: 2.0.0 | **Ratified**: 2026-07-31 | **Last Amended**: 2026-08-24
