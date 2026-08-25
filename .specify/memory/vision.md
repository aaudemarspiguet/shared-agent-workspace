# SAW Product Vision

**Status**: Draft for founder review. The open questions in §9 are not settled.
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
   extension. All of the above for a comprehensive product.
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

- **Principle II (Messages and Refs Only).** Journal entries are messages —
  distilled text plus refs — so the boundary's *letter* holds. But the
  *spirit* changes: SAW will now carry summaries of what an agent did, not
  only coordination pings. The principle should be amended to name journal
  entries as a third payload kind with their properties: distilled by the
  member's own tooling, human-visible before crossing, revocable. Raw
  transcripts, code, file access, execution stay banned.
- **Principle III (Human Visibility).** "Visible to both humans" assumes two.
  With access levels it must become "visible to every human in the thread's
  scope". No hidden channels rule stays. Amendment required before 002.
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

- **v1 (spec 002)** — *the team-shaped product*: N members (small teams),
  threads as containers with participants and types (work item, brainstorm,
  general), run journals with human-visible staging, dial-by-key
  connectivity replacing Tailscale, thread-ref bindings with baton handoff,
  one connector (GitHub Issues), one web app across workspaces, minimal
  roles (owner/member), redaction tombstones, protocol versioning +
  migration. Claude Code first-class; Cursor/Codex via MCP.
- **v2** — *the org-shaped product*: access levels beyond one workspace
  (team/project scoping across repos), agent-less stakeholder access
  (browser read/comment via a hosted or always-on node), async answering
  with draft-and-approve, Linear/Jira connectors with webhook automation,
  VS Code extension as a full surface, knowledge base, live brainstorm docs
  (CRDT), workspace-spanning threads.
- **v3** — *the platform*: hosted relay offering (open core intact),
  E2E-encrypted scopes, cross-workspace/cross-org federation, adapters as a
  standard (MCP extension for team threads), enterprise identity.

Deliberately not the goal at any rung: building or wrapping a coding agent;
moving code outside git; a Slack clone with an agent in it.

## 9. Open questions (founder decisions)

Each with the current recommendation. Answers fold into spec 002.

1. **What is a member?** Today: a declared username plus a bearer token from
   an invite. Iroh adds a keypair per node. Options: (a) trusted-invite
   identity as today, (b) keypair-based identity with the invite binding a
   key to a name, (c) verified GitHub identity (OAuth). *Recommendation:
   (b) for v1 — no OAuth server dependency, and possession of the key makes
   attribution real; (c) lands in v2 with hosted features.* Spec-blocking.
2. **Journal consent default.** Auto-share each run's journal entry
   (staged, visible, revocable), or require per-entry human approval?
   *Recommendation: auto-share ON per thread with a visible staging window,
   a per-thread toggle, and redaction tombstones — per-entry approval kills
   the async value that is the point of the product.* Privacy-defining.
3. **Async answering scope.** May my agent compose answers to a teammate's
   question while I sleep? *Recommendation: v1 is pull-only — their agent
   reads my journals; nothing runs on my machine unattended and nothing
   speaks in my name. Draft-and-approve async answering is v2.*
   Spec-blocking.
4. **Agent-less stakeholders.** A PM with no clone, no daemon, no agent —
   in v1? *Recommendation: defer full membership; ship the status
   projection (read-only rendered thread status) as the v1 answer.*
   Spec-blocking.
5. **Relay availability.** Accept host-online-only semantics (spool covers
   gaps) with a documented same-binary-on-a-VPS option, or build
   replication? *Recommendation: accept host-online-only for v1; ship store
   export/handoff; replication is v2+.*
6. **v1 scale target.** *Recommendation: 2-10 members per workspace.* The
   number gates schema and UI choices only mildly, but the spec needs one.
7. **Tool parity.** Claude Code gets hooks (journals, injection, pause).
   Cursor/Codex get MCP tools only — read/post/status but no automatic
   journaling. Acceptable for v1? *Recommendation: yes; hook adapters for
   other tools are v2.*
8. **Connector choice.** *Recommendation: GitHub Issues (repo-scoped like
   SAW, both members already authed, most mature MCP server, gh CLI
   fallback); Linear second, Jira third. Envelope designed
   provider-agnostic.*
9. **Constitution amendments** (§6): Principle III rewording and Principle
   II journal-entry clause. Both need Amogh's approval as maintainer.
   Proceed?
10. **Redaction and retention.** v1 ships tombstones (author or owner can
    redact; propagates to caches and future injections). Retention policies
    deferred. Agreed?

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
