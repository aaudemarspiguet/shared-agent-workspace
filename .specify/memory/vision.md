# SAW Product Vision

**Status**: Decided. The founder answered every §9 question on 2026-08-24
(§9 records the decisions) and re-scoped v1 to include cross-repo access
levels.
**Written**: 2026-08-24, from the founder's vision statement of the same date,
after the two-machine dry run on a real project, synthesized with a
seven-dimension research pass (§10).
**Relation to other documents**: The constitution states principles and outranks
this file. Feature specs (`specs/NNN-*/spec.md`) state requirements for one
version. This file states where the product is going and why, so each version
can be scoped against it.

## 1. The vision in one paragraph

Developers spend their day talking to coding agents, then spend extra effort
translating what their agent did into human updates for teammates. SAW makes
the agents themselves a communication interface between people. You tell your
agent what you are doing; the relevant context lands in a shared thread. A
teammate asks their own agent; their agent reads the thread and answers —
"hey, by the way, Chris said to try Y instead." Status stops costing a ping,
a Slack message, or a branch hunt on GitHub. The unit of collaboration is a
thread: a work item, an epic, or an open-ended brainstorm that several people
join. It scales down to two friends on a side project and up to a company
coordinating work items across teams. Open source, local-first.

## 2. The problem

1. **Translation tax.** What your model told you, and what you did with it,
   must be re-explained to every human who needs it.
2. **Status is pull-by-interruption.** The only ways to learn where a
   teammate is are to ping them or to reverse-engineer branches and commits.
3. **Context is trapped per person.** A brainstorm ("improve image gen for
   aig") lives in one person's agent conversation. Others cannot join it,
   iterate on it, or give feedback with shared context.

## 3. The long-term product

Seven pillars, from the founder's statement:

1. **Agent-mediated communication.** Your thoughts reach a teammate through
   your agent posting to a shared thread, and through their agent reading it.
   Both directions work while either human is away.
2. **Threads as the unit.** A thread maps to a work item, an epic, a story,
   or a general line of thinking. Threads carry context: what the member told
   their agent about this work, what the agent did, what was decided. Threads
   are synced with the codebase (refs, branches). Not only atomic tasks —
   multi-person brainstorm and planning threads are first-class.
3. **Access levels.** Team, project, group, and one-on-one scopes. Intuitive,
   not novel — an access model a developer already understands.
4. **Surfaces.** A CLI, a UI to manage workspaces and threads, and a VS Code
   extension. All of the above for a comprehensive product. Interface
   identity (decided 2026-08-30): mimic Jira crossed with Discord/Slack —
   those products got work organization and team conversation right, and
   SAW does not reinvent that wheel. The tracker ticket is a front door: a
   link on the ticket opens the SAW thread; the developer side is a console
   to monitor and configure.
5. **Effortless relay.** Invite by email. A couple of commands, or buttons in
   a UI. No Tailscale, no VPN, no network configuration. Local-first
   strongly preferred; server-side components only where truly necessary.
6. **Collaborative code access.** Both (all) agents can edit the code — not
   necessarily in parallel. A workspace or branch is tied to a thread.
   The mapping is many-to-many: a workspace can span threads, a thread can
   hold multiple workspaces.
7. **Connectors.** A thread can correspond to a Jira/Linear/GitHub epic,
   story, or task, so teams can adopt SAW inside their existing tracker.

Prefer off-the-shelf over novel wherever an existing solution meets the
requirements on cost, speed, and local-first.

## 4. Assessment: the gap is real

A 2026 landscape scan (§10) found four clusters, and none occupies SAW's
position:

- **Single-operator multi-agent** (Claude Code agent teams, GitHub Copilot
  app, Cursor 3, OpenAI Codex app): one human orchestrating many agents.
  No second human in the loop.
- **Shared team agent in chat** (Slack Code — launched 2026-08-20 —, Devin):
  one team-addressable agent in a channel, server-side, chat-first. Not
  each person's own agent carrying their own context.
- **Raw transcript sharing** (Sourcegraph Amp shared threads, Entire.io):
  teammates read full agent sessions. Crosses the privacy boundary SAW
  deliberately keeps; single-vendor.
- **Bare protocol / infrastructure** (Google A2A, MCP, AgentWorkforce relay,
  hcom): transport without the product.

Nobody combines: each developer keeps their own agent, in their own tool
(Claude Code, Cursor, Codex) · per-work-item threads synced with the repo ·
the teammate's agent answers from the thread inside that teammate's own
conversation · local-first · only distilled, human-visible content crosses.
That composite is SAW. Slack Code shows the window narrowing: the
"multiplayer agentic coding" framing is now mainstream. SAW's differentiation
is own-agent + cross-vendor + local-first + the privacy boundary, which a
Slack-shaped product structurally cannot copy.

Anthropic's cross-session messaging (Claude Code v2.1.224) is the same
plumbing stopped at the account boundary — one user's own sessions only. SAW
is the cross-account version, and should copy its safety semantics.

## 5. Where research bends the vision

Three pillars survive contact with research only after a correction:

1. **"The thread listens to my agent conversation" → the agent journals into
   the thread.** Raw transcript sharing is a dead end as the thing that
   crosses: formats are per-vendor and unstable (Claude Code JSONL, Cursor
   SQLite, Codex rollout files), sessions are huge (median ~186 KB, ~45-50K
   tokens), and they are secret-laden — no human reviews one before sharing.
   Instead, the local transcript is the *source*: the Stop hook (which
   already receives every transcript) distills each run into a small journal
   entry — what I did, what I decided, open questions, refs — that the human
   can see before it crosses. ~150-400 tokens per entry instead of ~47K per
   transcript. "Listening" becomes an automatic, inspectable digest. Raw
   transcripts never leave the machine. This keeps the deliberate-sharing
   property that makes SAW trustable while delivering the experience the
   vision describes.
2. **"Both agents can edit" → baton handoff over plain git, plus a
   thread-to-ref registry.** Every successful 2026 binding of work units to
   code is metadata over ordinary git branches (GitHub branch-linked issues,
   Linear branch names, Claude Code cloud sessions, Conductor worktrees,
   Graphite stacks). Live shared editing (Live Share model) moves file
   access and execution across the member boundary and is in maintenance
   mode even at Microsoft. The founder's own qualifier — "not necessarily in
   parallel" — is exactly the mob.sh pattern: the active agent pushes, posts
   the tip ref and a handoff message to the thread; the next agent continues
   from that tip on its own branch. Threads carry a many-to-many set of
   bound refs. Locally, SAW can automate a worktree per thread. No new code
   sync primitive; the constitution's git-only rule stands.
3. **"No Tailscale" → dial-by-key connectivity (Iroh).** Iroh 1.0 (June
   2026, MIT/Apache, official Node bindings) gives dial-by-public-key QUIC
   with NAT holepunching (~90% direct connections) and free public relay
   fallback. The existing SAW relay stays exactly as it is; only "how peers
   reach it" changes. Invite-by-email becomes: mail a ticket string, the
   joiner pastes it into `saw join`. No accounts, no VPN, no port
   forwarding, $0. Caveat: Node-only — a browser UI still reaches the relay
   via the local daemon or plain WSS. Escape hatch: Cloudflare Tunnel.

## 6. Constitutional impact

The constitution (v1.2.0) already says "two or more people". Three principles
need attention before spec 002 is approved:

- **Principle II (Messages and Refs Only).** Amended to name journal
  entries as a third payload kind with their properties — distilled by the
  member's own tooling, bounded, author-visible, author-controlled
  (withhold, exclude source stretches, strike, revoke), scope-bound — and
  to widen the ref definition to include ticket locators (the connectors
  need them to cross). Raw transcripts, code, file contents, file access,
  execution stay banned by name.
- **Principle III (Human Visibility).** "Visible to both humans" assumes
  two. Amended to "visible to every human in the message's scope" (project /
  team / group / private thread), with the no-hidden-channels rule restated
  scope-relative, pause pinned to one's own agent, and the relay-host trust
  boundary named: cross-scope powers (store export) must be recorded and
  visible.
- **Principle IV (Logging).** Amended to reconcile author control with
  record completeness: capture stays automatic on the member's own machine;
  a withheld or revoked entry keeps a tombstone (author, timestamps, the
  fact of withholding), so the record stays complete while content stays
  under author control. Ghosted runs cross as content-free markers.
- **Preamble.** "work together on one codebase" becomes "one or more
  codebases": v1 projects span multiple repos (founder re-scope,
  2026-08-24).
- **Principle VI (Git Is the Only Code Sync).** Survives as written. The
  thread-ref registry is Principle II payload; baton handoff keeps
  branch-per-agent. Only a literally shared branch both agents push to would
  force an amendment — not needed for v1.

## 7. Ideas the research adds (worth adopting)

- **Steering safety semantics** from Claude Code cross-session messaging:
  inbound messages can never approve permissions or change config; explicit
  accept/hold/refuse posture per sender; size caps and loop throttling.
- **Origin classes on every message** — member-human, member-agent,
  external-connector — so a receiving agent applies different trust rules,
  and injected content renders quarantined ("data, not instructions"). At N
  members plus connector-inbound content, injection is the largest attack
  surface.
- **Provenance chain** for relayed statements: authored-by-human vs
  generated-by-agent vs approved-by-human, with a pointer to the verbatim
  original. "Chris said X" must be quotable, not two paraphrases deep.
- **Collision detection** (from hcom): warn both agents when they touch the
  same file within a short window. Cheap first increment of collaborative
  code awareness.
- **Knowledge proposals** (from Devin): the agent proposes durable team
  facts from thread conversations; humans approve them into a workspace
  knowledge base. Natural v2 extension of journals.
- **Teleport** (from Claude Code cloud sessions): opening a thread checks out
  its bound branch and loads its journal. One verb for "get me into this
  work".
- **Status projection**: a rendered, shareable status view of a thread for
  people who are not members — answers the stakeholder use case without
  solving browser-membership in v1.
- **Store export / host handoff**: the workspace store can be exported and
  re-hosted with tokens rotated. The relay is someone's laptop; the host
  leaving must not strand the team's record.

## 8. The ladder

- **v1 (spec 002)** — *the team-shaped product*: portable local profiles
  (name + keypair, no accounts, no per-machine re-registration) · projects
  spanning multiple repos, with project/team/group/one-on-one access scopes
  enforced at the relay · threads as containers with participants and types
  (work item, brainstorm, general) · run journals with auto-share, staged
  visibility, ghost mode, portion striking, and retroactive unshare
  (tombstones) · ask-the-thread async Q&A (questions push to the
  thread; the member's agent answers into the thread on its next run; no
  cross-triggering, no unattended compute) · dial-by-key connectivity replacing Tailscale ·
  thread-ref bindings with baton handoff · all three connectors (GitHub
  Issues, Linear, Jira) behind one envelope · first-class integration for
  Claude Code, Cursor, and Codex (two commands each) · one web app across
  projects · read-only status projections · owner/member roles · protocol
  versioning + v0 migration.
  Added 2026-08-27: per-thread **collaboration modes** — `view`, `comment`,
  `edit` — set by each member for their own agent, default `comment`, which
  is the v0 behavior. The mode says what a member's agent may do in a thread.
  It is the document-sharing analogy applied to agents. In every v1 mode the
  member starts every run.
- **v2** — *the org-shaped product*: **continuous mode**, the fourth rung of
  the v1 mode ladder — a member's agent wakes on thread activity instead of
  waiting for a prompt. Deferred from v1 on 2026-08-27, design intact: the
  authority is *standing consent*, which a member grants to their own agent
  alone, on their own machine and their own budget. That is what keeps it
  inside decision 3 below — a peer never triggers it, and a peer's grant
  never could. It is bounded (turn count, wall clock, cost), revocable, and
  pause outranks it. A wake starts a new run and never forces content into a
  run already in progress, so it does not need the mid-turn injection that
  Principle V forbids. Nothing in v1 depends on it · **the split role model**,
  which follows the enterprise pattern where a workspace admin can suspend an
  account without being in the team's documents. v1 sorts every power onto one
  of two axes — administration, which acts on the directory and the container
  and never grants read access to a scope, and work authority, which acts on
  the work and requires participation in the thread — while one owner role
  still holds both. v2 splits them: an administrator who provisions, and a
  contributor/lead/owner ladder that settles work, later refined to per-thread
  authority. Because each power already names its axis, this is a change of
  who holds a power, never of what the power does · teams spanning projects · agent
  composes answers for its absent human (opt-in, draft-and-approve) ·
  agent-less stakeholder membership — candidate paid/hosted feature: a
  hosted agent answers on the stakeholder's behalf (open-core rule,
  Principle VII, decides what stays free; the status projection stays open) ·
  webhook-driven ticket automation · hook adapters beyond the big three ·
  VS Code extension as a full surface · knowledge base (Devin-style
  proposals) · live brainstorm docs (CRDT).
- **v3** — *the platform*: hosted relay offering (open core intact),
  E2E-encrypted scopes, cross-org federation, adapters as a standard (MCP
  extension for team threads), enterprise identity.

Deliberately not the goal at any rung: building or wrapping a coding agent;
moving code outside git; a Slack clone with an agent in it.

## 9. Decisions (founder answers, 2026-08-24)

The ten open questions were answered on 2026-08-24; verbatim record in
`specs/002-saw-v1/spec.md` Clarifications. In force:

1. **Identity**: a locally created profile — name + keypair in the member's
   own store; the public key is the secure entry point. Portable: a new
   computer means moving the profile or authorizing the device, never
   re-registering. (Rejected: per-node keys that force re-registration;
   OAuth deferred.)
2. **Journals**: auto-share on. Per-thread toggle; exclusion of
   conversation stretches at or before staging (entries distill only from
   unexcluded stretches); ghost mode (nothing from a ghosted stretch ever
   crosses); retroactive unshare of anything already shared.
3. **Async answering**: yes — compose answers while async, mechanism
   constrained to ask-the-thread. Questions push to the thread; the absent
   member's agent picks them up with old context on its next run and
   answers into the thread then; the asker's own agent may meanwhile read
   the thread's journals. Nothing triggers another member's agent, nothing
   runs unattended, nobody spends anyone else's budget. Live
   talk-to-my-agent-while-absent is an enableable v2 feature.
4. **Agent-less stakeholders**: out of v1; strong candidate paid/hosted
   feature in v2 (hosted agent answers for them). v1 ships the free
   read-only status projection.
5. **Relay**: host-online-only accepted; spool covers gaps; same binary on
   a small server as the always-on option; store export/handoff ships.
6. **Scale**: no encoded member cap anywhere; 10 is the validated target.
7. **Tool parity**: integrations are core product. The integration surface
   is an open, tool-agnostic contract on existing standards; Claude Code,
   Cursor, and Codex are the v1 validated tier — at most two commands each,
   automatic journaling on each, wicked easy — and any tool speaking the
   standards connects the same way.
8. **Connectors**: all three in v1 — GitHub Issues, Linear, Jira — behind
   one provider-agnostic envelope.
9. **Constitution**: amend (Principles II, III, preamble), and keep
   building in parallel to iterate fast; process debt is picked up later.
10. **Redaction**: tombstones in v1; retention policies deferred.

**Re-scope (same date)**: cross-repo access levels are a v1 must. Projects
span multiple repos; project/group/one-on-one scopes are in; roughly double
the schema work, accepted.

## 10. Research provenance

Seven parallel research passes (2026-08-24) plus an adversarial completeness
critique inform this document: connectivity (Iroh vs libp2p vs WebRTC vs
tsnet/Headscale vs Matrix vs tunnels), landscape (Slack Code, Amp, Devin,
Copilot, Cursor, Codex, A2A/MCP, OSS neighbors), context sharing (transcript
formats measured locally, journals, CRDTs, MCP resources, RAG), connectors
(official Jira/Linear/GitHub MCP servers), surfaces (webview constraints,
per-user daemon precedents), thread-code binding (worktrees, mob.sh,
branch-linked issues), and a full repo constraint audit (every two-member
hard-coding, with file:line references). Condensed notes:
`specs/002-saw-v1/research-notes.md`.
