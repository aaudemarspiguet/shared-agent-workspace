# Feature Specification: SAW Shared Workspace

**Feature Branch**: `001-saw-shared-workspace`

**Created**: 2026-07-31

**Status**: Implemented, under revision. The four user stories are built and
merged. Sections amended after implementation carry the date in the
Clarifications block. Follow-up work is tracked in tasks.md, not here.

**Input**: User description: "Build SAW. SAW is a shared workspace for two developers. Each developer has a coding agent. SAW connects the agents. A workspace maps to one repo. A workspace includes the repo members and their agents. Agents send messages in a shared room. A message has a type. Message types are intent, question, decision, handoff, and status. Agents use the room to negotiate work. Agents use the room to claim work. Agents use the room to hand off work. Both humans can read every message. Either human can send a message to redirect an agent. Either human can pause their own agent. The system must log every agent run. A log entry must include what the agent did. A log entry must include when the agent did it. A log entry must include why the agent did it. A log entry must link to a feature. A human can ask their own agent about a teammate agent. Example question. What did my teammate's agent do yesterday. The system must answer this question even if the teammate is offline. Agents must not access each other's files. Agents must not access each other's execution environment. Agents may only send messages and git references. A git reference is a branch name or a commit SHA."

## Clarifications

### Session 2026-07-31

- Q: What counts as an "agent run" that the system must log — every run of the connected coding tool in the workspace repo, or only activity that touches SAW? → A: Every run of the connected coding tool inside the workspace repository, captured automatically via the tool's hooks.
- Q: How does a developer join a workspace and prove they are who they claim to be? → A: Workspace creator sends an invite; each member gets their own credential that their agent uses on every connection. Sign-in through the git hosting account is explicitly deferred to a later version.
- Q: When both agents claim the same work item at nearly the same time, how is the conflict resolved? → A: First claim recorded wins; the later claim is automatically rejected with a notice to that agent, visible to both humans.
- Q: Where do the humans read the room and steer the agents? → A: Both surfaces: a minimal dedicated room view for reading, redirecting, and pausing, plus each human's own agent for questions about history and teammate activity.
- Q: Since log capture is automatic, where does the "why the agent did it" in a log entry come from? → A: Both the instruction that triggered the run (human prompt or room message) and the claimed work item / feature the run was serving; neither depends on the agent self-reporting.

### Session 2026-08-01 — amendments after implementation

Found by reviewing the built system against this specification, and by
`/speckit-analyze`. Each names the gap that made the amendment necessary.

- Q: What does a pause do to a run already in progress? → A: It blocks every tool call from that moment, so the agent cannot continue. The edge case said the agent "finishes or aborts its current run", which contradicted FR-014. Constitution amended to 1.1.0 to define pause and stop as one control.
- Q: What protects a member's credential, and what protects the interfaces on their machine? → A: FR-020 and FR-021, new. The specification had no security requirements at all across 22 FRs, so two real defects in the built system traced to no requirement and could not fail a gate.
- Q: When the system captures no triggering instruction, what may the "why" say? → A: FR-016a and SC-010, new. SC-003 counted only that the field was present, so a stand-in reading "run with no recorded trigger" satisfied it. The reader can now tell a real reason from a stand-in.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agents coordinate work in a shared room (Priority: P1)

Two developers share one repository. Each developer runs their own coding
agent. SAW gives the two agents a shared room scoped to the repository. In
the room, agents exchange typed messages to negotiate who does what, to claim
a piece of work, and to hand work off. A message may carry a git reference (a
branch name or a commit SHA) so the other side knows where to look. Both
humans can read every message in the room.

**Why this priority**: This is the core value of SAW. Without the shared
room, the two agents cannot coordinate at all and SAW delivers nothing.

**Independent Test**: Can be fully tested by connecting two agents to one
workspace, having agent A post an intent message and claim a work item,
having agent B acknowledge and later receive a handoff with a branch name,
and confirming both humans see every message.

**Acceptance Scenarios**:

1. **Given** a workspace linked to one repository with two members and their
   agents connected, **When** agent A sends an `intent` message ("I will take
   the login form"), **Then** agent B and both humans see the message with
   its type, sender, and timestamp.
2. **Given** an open work item, **When** agent A sends a message claiming it,
   **Then** the claim is visible in the room and agent B can see the work is
   taken.
3. **Given** agent A has finished part of the work on its own branch,
   **When** agent A sends a `handoff` message that includes the branch name,
   **Then** agent B receives the message and can fetch that branch from the
   shared remote by itself.
4. **Given** any message sent in the room, **When** either human opens the
   room, **Then** the human can read the full message history.
5. **Given** an agent tries to send a payload that is not a message or a git
   reference (for example file contents or a code diff), **When** the payload
   reaches the workspace boundary, **Then** the system rejects it and records
   the rejection.

---

### User Story 2 - Humans steer and pause agents (Priority: P2)

Both humans watch the room. Either human can post a message into the room to
redirect an agent — their own or their teammate's — for example "stop working
on the parser, switch to the API." Each human can pause their own agent, which
stops that agent from taking further SAW-coordinated actions until resumed.

**Why this priority**: Human control is the safety layer on top of the room.
The room is useful alone, but unsupervised agent-to-agent negotiation is not
acceptable for real teams.

**Independent Test**: Can be tested by having a human post a redirect message
and confirming the target agent receives it as the next input, then pausing
an agent and confirming it takes no further room actions until resumed.

**Acceptance Scenarios**:

1. **Given** two agents are exchanging messages, **When** human A posts a
   redirect message addressed to agent B, **Then** the message appears in the
   room for everyone and is delivered to agent B.
2. **Given** human A wants to stop their own agent, **When** human A pauses
   it, **Then** the agent sends no further messages and takes no further
   coordinated actions until human A resumes it.
3. **Given** human A tries to pause agent B (the teammate's agent), **When**
   the pause is requested, **Then** the system refuses and explains that a
   human can pause only their own agent.
4. **Given** agent A is paused, **When** messages arrive for it, **Then** the
   messages are kept and delivered when the agent resumes.

---

### User Story 3 - Every agent run is logged automatically (Priority: P3)

Every agent run in the workspace produces a log entry without any manual
step. Each entry states what the agent did, when it did it, and why it did
it, and links the entry to a feature or story. Humans can browse the log.

**Why this priority**: The log turns agent activity into a record the team
can audit and query. It also feeds User Story 4. It is third because the room
and human controls must exist before there is meaningful activity to log.

**Independent Test**: Can be tested by running an agent through a work
session and confirming that every run appears in the log with all four
fields, with no logging action taken by the agent or the human.

**Acceptance Scenarios**:

1. **Given** an agent completes a run, **When** the run ends, **Then** a log
   entry exists that states what the agent did, when it did it, why it did
   it, and which feature the work belongs to.
2. **Given** the log capture mechanism, **When** an agent "forgets" to report
   anything about its run, **Then** the run is still captured, because the
   system records it automatically rather than trusting the agent.
3. **Given** a stored log, **When** a human filters by feature, **Then** the
   human sees only the entries tagged to that feature.

---

### User Story 4 - Ask about a teammate's agent, even offline (Priority: P4)

A human asks their own agent a question about the teammate's agent, such as
"What did my teammate's agent do yesterday?" The system answers from the
workspace's stored history — messages, refs, and log entries — so the answer
works even when the teammate and the teammate's agent are offline.

**Why this priority**: This is the payoff of the log and the room history.
It depends on User Stories 1 and 3 existing first.

**Independent Test**: Can be tested by generating activity from agent B,
taking member B fully offline, then asking agent A about agent B's activity
and confirming a correct answer built from stored history.

**Acceptance Scenarios**:

1. **Given** agent B did work yesterday and member B is now offline, **When**
   human A asks their own agent what agent B did yesterday, **Then** the
   answer lists agent B's logged runs and messages from yesterday.
2. **Given** the teammate's agent produced no activity in the asked period,
   **When** the question is asked, **Then** the answer states clearly that
   there was no recorded activity, rather than guessing.
3. **Given** the question requires the teammate's machine or files to answer,
   **When** the question is asked, **Then** the answer uses only stored
   workspace history and says so; it never reaches into the teammate's
   environment.

---

### Edge Cases

- What happens when both agents claim the same work item at nearly the same
  time? The first claim the system records wins; the later claim is rejected
  automatically and the rejection notice is visible to both humans, so
  nothing is silently dropped.
- What happens when a message carries a git reference that does not exist on
  the shared remote (a typo'd branch, an unpushed SHA)? The receiving side
  must be able to report "ref not found" without the system crashing or the
  ref being treated as valid.
- What happens when a message has no type or an unknown type? The system
  rejects it; only intent, question, decision, handoff, and status are valid.
- What happens when an agent tries to smuggle code or file contents inside a
  message body? The boundary check must reject payloads that are not
  messages-with-optional-refs, and the rejection must be logged.
- What happens when a human pauses their agent in the middle of a run? Every
  tool call is blocked from that moment, so the agent cannot continue the
  run; incoming messages queue for later delivery (FR-014).
- What happens when a member disconnects mid-conversation? Messages sent
  while offline are stored and delivered on reconnect; history stays intact.
- What happens when a run cannot be linked to a known feature? The entry is
  still captured and tagged as unassigned, and surfaced for a human to
  classify; a missing tag must never mean a missing log entry.
- What happens when a workspace has only one member so far? The room and log
  work for one member; the second member can join later without losing
  history.

## Requirements *(mandatory)*

### Functional Requirements

**Workspace**

- **FR-001**: The system MUST let two developers create a shared workspace
  that maps to exactly one repository.
- **FR-002**: A workspace MUST contain its members and one coding agent per
  member, where each agent is the member's own existing coding tool.
- **FR-002a**: The workspace creator MUST be able to invite the second
  member. Each member MUST receive their own credential, and every
  connection and message from an agent MUST be tied to its member's
  credential so the system always knows which human owns which agent.

**Shared room and messages**

- **FR-003**: The system MUST provide one shared room per workspace in which
  agents exchange messages.
- **FR-004**: Every message MUST have exactly one type, drawn from: intent,
  question, decision, handoff, status. The system MUST reject a message with
  a missing or unknown type.
- **FR-005**: A message MAY carry one or more git references, where a git
  reference is a branch name or a commit SHA.
- **FR-006**: Agents MUST be able to use room messages to negotiate work,
  claim work, and hand off work, and the current claim state MUST be visible
  to both members.
- **FR-006a**: Claims MUST be resolved in the order the system records them:
  the first claim on a work item wins, and a later claim on the same item
  MUST be rejected automatically with a notice to the claiming agent that is
  visible to both humans.
- **FR-007**: Every message MUST record its sender, its type, and the time it
  was sent, and the full message history MUST be readable by both humans.

**Isolation boundary**

- **FR-008**: The system MUST NOT transmit anything between members other
  than messages and git references. It MUST stop file contents, code, file
  access, and execution control at the boundary, by one of two outcomes:
  - A payload that exists only to carry such content MUST be refused whole,
    and MUST NOT be stored or echoed.
  - Such content arriving inside a record the system is separately required
    to keep — a work log entry, which FR-015 says must exist for **every**
    run — MUST have the offending field removed, and the rest of the record
    MUST be kept. Losing the run to protect the boundary trades one
    requirement for another.

  A field that only breaks a size or format rule is trimmed or dropped, not
  a reason to lose the record. Either outcome MUST be logged, and the log
  entry MUST NOT contain the removed content.
- **FR-009**: An agent MUST NOT be able to read or write the other member's
  files through the system.
- **FR-010**: An agent MUST NOT be able to run anything in the other
  member's execution environment through the system.

**Member machine and credentials**

- **FR-020**: The system MUST protect each member's credential on that
  member's machine so that only the member's own account on that machine can
  read it. Where a platform cannot express that restriction through file
  permissions alone, the system MUST apply that platform's equivalent access
  control. If the system cannot protect the credential on the current
  platform, it MUST tell the member plainly instead of reporting success.
- **FR-021**: Every interface the system exposes on a member's machine — the
  room view and any interface the member's own agent or tooling uses — MUST
  accept requests only from software the member started for this workspace.
  It MUST refuse requests that originate from other software on that machine,
  including pages loaded in the member's web browser, and the refusal MUST
  cover reads as well as changes. These interfaces MUST NOT be reachable from
  another machine.

**Human visibility and control**

- **FR-011**: Both humans MUST be able to read every agent-to-agent message;
  no message may be hidden from either human.
- **FR-011a**: The workspace MUST provide a minimal dedicated room view where
  a human can read the full message history, post a redirect message, and
  pause or resume their own agent — available even when that human's agent
  is not running. Questions about history and teammate activity go through
  the human's own agent (FR-018).
- **FR-012**: Either human MUST be able to post a message into the room that
  redirects an agent, and the system MUST deliver that message to the target
  agent.
- **FR-013**: Each human MUST be able to pause and resume their own agent.
  The system MUST refuse a request to pause the teammate's agent.
- **FR-014**: While an agent is paused it MUST take no coordinated actions,
  and messages addressed to it MUST be stored and delivered on resume.
  "No coordinated actions" means the system blocks every tool call of the
  paused member's connected coding tool, not only SAW tool calls.

**Work log**

- **FR-015**: The system MUST create a log entry automatically for every run
  of a member's connected coding tool inside the workspace repository — not
  only runs that touch SAW — captured through the tool's own hook points;
  capture MUST NOT depend on the agent choosing to report.
- **FR-016**: Every log entry MUST state what the agent did, when it did it,
  and why it did it, and MUST link to a feature or story. The "why" MUST be
  captured mechanically from two sources: the instruction that triggered the
  run (a human prompt or a room message) and the claimed work item or
  feature the run was serving. If no feature is known, the entry MUST still
  be captured and marked unassigned.
- **FR-016a**: A reader MUST be able to tell whether an entry's "why" is the
  real triggering instruction or a stand-in. When the system captures no
  triggering instruction, or removes one at the boundary, the entry MUST
  still be kept and MUST record which of those happened. The system MUST NOT
  present a stand-in as if it were the reason for the run.
- **FR-017**: The log MUST be stored durably in the workspace so it remains
  readable when either member is offline.

**Teammate awareness**

- **FR-018**: A human MUST be able to ask their own agent about the teammate
  agent's activity (for example, "What did my teammate's agent do
  yesterday?"), and the system MUST answer from stored workspace history.
- **FR-019**: The answer in FR-018 MUST be available even when the teammate
  and the teammate's agent are offline, and MUST be based only on stored
  messages, refs, and log entries — never on reaching into the teammate's
  environment.

### Key Entities

- **Workspace**: The shared space for one repository. Holds exactly one
  repository link, its members, their agents, the room, and the work log.
- **Member**: A human developer in the workspace. Owns one agent. Can read
  all messages, post messages, and pause only their own agent.
- **Agent**: A member's existing coding tool connected to the workspace. Acts
  only on its own member's machine; talks to the other agent only through
  room messages.
- **Room**: The single shared message channel of a workspace. Preserves full
  ordered history visible to both members.
- **Message**: One unit of communication. Attributes: sender, type (intent |
  question | decision | handoff | status), body, sent time, optional git
  references, optional target agent (for redirects).
- **Git Reference**: A branch name or a commit SHA. The only pointer to code
  that may cross between members; the code itself moves through the shared
  repository remote.
- **Run Log Entry**: The automatic record of one agent run. Attributes: what
  was done, when, why, linked feature (or unassigned), and the agent that
  ran.
- **Feature**: A named unit of work (feature or story) that log entries and
  claims attach to, so activity can be filtered and reported by feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Two developers can go from an empty shared workspace to the
  first successfully delivered agent-to-agent message in under 15 minutes.
- **SC-002**: 100% of agent-to-agent messages are readable by both humans;
  zero hidden or partially visible messages across a full work session.
- **SC-003**: 100% of agent runs in a session appear in the work log with
  all four fields (what, when, why, feature link or unassigned), with zero
  manual logging steps performed by agents or humans. This criterion counts
  presence only. SC-010 covers whether the "why" says anything.
- **SC-004**: A human asking about the teammate agent's activity for a past
  day receives a correct answer within 30 seconds while the teammate is
  offline.
- **SC-005**: In adversarial testing, 100% of attempts to pass file contents,
  code, file access, or execution control between members are prevented at
  the boundary — refused whole, or removed from the record that carried them
  (FR-008) — and 100% appear in the log. Zero attempts reach the other
  member, and zero cost a run its log entry.
- **SC-006**: A pause takes effect before the paused agent's next coordinated
  action. A human redirect message reaches the target member's local
  delivery point in under 5 seconds under normal conditions, and is
  presented to the target agent at the start of that agent's next turn. The
  system MUST NOT force content into an agent mid-turn.
- **SC-007**: After one member has been offline for 24 hours, the returning
  member's agent receives 100% of the messages sent in the interim, in order.
- **SC-008**: On every supported platform, a second account on the same
  machine cannot read a member's credential.
- **SC-009**: On every supported platform, a page loaded in a member's web
  browser cannot read room contents and cannot change that member's pause
  state.
- **SC-010**: In a session where a human prompt or a room message starts
  every run, 100% of log entries carry that instruction as the "why". A
  reader can tell every remaining entry apart from those, and can tell why
  it carries no instruction.

## Assumptions

- A workspace has exactly two members in this version. Larger teams are out
  of scope for now.
- Members join by invite with per-member credentials. Sign-in through the
  git hosting provider is deferred to a later version and is out of scope.
- Both members already have push access to one existing shared git remote.
  SAW never hosts or moves the code itself; code moves only through that
  remote (per the constitution, each agent works on its own branch and
  pushes to the existing remote).
- Each member runs their own existing coding agent (such as Claude Code,
  Codex, or Cursor). SAW connects to these tools through their standard
  integration points; it does not build, fork, or wrap an agent (per the
  constitution).
- "Redirect an agent" means: the human's message is delivered to the target
  agent as an instruction with human authority. SAW guarantees delivery and
  visibility; whether the underlying tool follows the instruction is the
  behavior of that tool. Either human may direct a redirect at either agent;
  pausing remains restricted to one's own agent.
- A "feature" for log-linking purposes is a named work item the team defines
  in the workspace (for example, an item negotiated and claimed in the room).
  Entries that cannot be linked are kept and marked unassigned.
- Messages, refs, and log entries are retained for the lifetime of the
  workspace, so questions about past activity ("yesterday") can be answered
  at any later time.
- Answering teammate-activity questions requires only stored workspace
  history; no live connection to the teammate's machine is ever needed or
  used.
- "Supported platform" in FR-020 and SC-008/SC-009 means the platforms a
  member may run their own coding tool on: Windows, macOS, and Linux. These
  platforms do not express account-level file access the same way, so
  FR-020 is written in terms of the outcome, not a permission value.
