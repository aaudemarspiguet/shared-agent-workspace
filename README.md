# SAW — Shared Agent Workspace

SAW is a coordination layer for two developers who each use a coding agent.
SAW connects the two agents through a shared, human-visible room. Agents
send only messages and git refs. Code moves only through git. Humans see
every message and can steer or pause their own agent.

**Status**: Implementation is done for all three packages: monorepo
setup, `packages/shared` (boundary schemas, frozen — change only via a
PR both members approve), `packages/relay` (full protocol), and
`packages/cli` (the `saw` command: daemon, five MCP tools, four Claude
Code hooks, local web page). Two-member integration tests cover the four
user stories plus reconnect replay (`tests/integration/`). Every task has
a GitHub issue; the numbers match task IDs up to T053 and diverge after
that, so read the mapping at the top of
`specs/001-saw-shared-workspace/tasks.md` rather than guessing.

**Open, and read this before you demo SAW**: a readiness pass in August
2026 set the product up the way a new pair does — from the written
steps, not from the test harness — and it hit blockers that the tests
never saw. The tests drive the local HTTP API directly, so they step over
the parts a human touches: how you get the relay, how the `saw` command
reaches your PATH, and which files you must commit between `saw invite`
and `saw join`. `specs/001-saw-shared-workspace/quickstart.md` now
carries corrected, executed steps. Treat it as the source for setup.
`specs/001-saw-shared-workspace/quickstart-results.md` records the older
scripted run and states plainly what that run did not cover.

Three things are open that you should know about before you rely on SAW:

- **Pasted code can still reach the shared work log** (T080, issue #97).
  The CLI collapses the whitespace of your prompt and cuts it to 600
  characters before the relay checks it, which defeated every detector
  that looked for a diff or a fence at the start of a line. The relay
  half of the fix is in review; the CLI half, which checks the payload
  before that transform and is the more accurate of the two, is not
  written yet. Until it is, **SC-005 — "100% of attempts are rejected at the
  boundary" — is not something this repo can claim.**
- **The test suite is 205/214 on Windows** and 214/214 elsewhere (T081,
  issue #98). All nine failures are POSIX-only assumptions in
  `packages/cli` test harnesses, not product faults, but they make the
  suite hard to read as a signal on that platform.
- **A two-machine run with live Claude Code sessions on both sides** has
  still not happened (T053, issue #53). Everything to date ran on one
  machine.

See the checkboxes in `specs/001-saw-shared-workspace/tasks.md`.

## What is in this repo

| Path | Content |
|------|---------|
| `.specify/memory/constitution.md` | Project principles. Read this first. All work must follow it. |
| `specs/001-saw-shared-workspace/spec.md` | What SAW must do (requirements, user stories) |
| `specs/001-saw-shared-workspace/plan.md` | How to build it (stack, structure) |
| `specs/001-saw-shared-workspace/research.md` | Design decisions and why |
| `specs/001-saw-shared-workspace/data-model.md` | Entities and validation rules |
| `specs/001-saw-shared-workspace/contracts/` | MCP tools, relay protocol, CLI, hooks |
| `specs/001-saw-shared-workspace/quickstart.md` | Setup steps and end-to-end validation scenarios. Start here to run SAW. |
| `packages/relay/README.md` | How to run the relay: Node or Docker, ports, database, security |
| `packages/cli/README.md` | The `saw` command: install, commands, hooks, MCP tools, web page |
| `specs/001-saw-shared-workspace/tasks.md` | The ordered task list + the Ownership table. Implementation follows this list. |
| `.github/CODEOWNERS` | Review gate per package (see Work split below) |
| `.claude/skills/` | The `/speckit-*` commands for Claude Code |
| `.specify/` | Spec Kit templates and scripts |

## Tools you need

Install these before you start:

1. **Git** — code sync and version control.
2. **Python 3.11+** — the `.specify/scripts/python/` helper scripts use it.
3. **Claude Code** — the `/speckit-*` commands run inside it. The skills
   ship with this repo. No extra setup is needed.
4. **Node.js 20+** — the implementation uses TypeScript on Node
   (see `plan.md`). You need this when you build and run SAW.

## Run SAW

Follow `specs/001-saw-shared-workspace/quickstart.md`. It has the three
setup steps in order. In short:

```bash
npm install                          # at the repo root
cd packages/cli && npm link          # puts `saw` on your PATH
```

The relay runs in the foreground. Give it its own terminal:

```bash
npm run dev --workspace @saw/relay   # answers on port 8787
```

Three points that cost people an hour each:

- There is no `saw-relay` package on npm, and the `saw` package on npm is
  a different project. Run the relay from this repository or from
  `packages/relay/Dockerfile`.
- The `saw` command is not on your PATH after `npm install`. It sits at
  `node_modules/.bin/saw`. Link it, or call it by full path.
- Between `saw invite` and your teammate's `saw join`, commit and push the
  shared SAW config that `saw init` names. Without it, join cannot find
  the relay and reports "the relay is not reachable", which is false.

Optional:

- **Spec Kit CLI (`specify`)** — only needed to upgrade or re-init the
  Spec Kit setup. The repo already contains everything. Install with:
  `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git`
- **GitHub CLI (`gh`)** — handy for issue work from the terminal. Not
  required; the issues already exist.

## Work split (two members)

Work is split by package. The **Ownership table** at the top of
`tasks.md` is the source for this split:

| Member | Packages | Tasks |
|--------|----------|-------|
| @aaudemarspiguet | `packages/shared`, `packages/relay` | T001–T003, T005–T014, T022–T024, T032–T033, T041, T045 (all done) |
| second member | `packages/cli` (daemon, MCP, hooks, web) | T004, T015–T021, T025–T030, T034–T040, T042–T043, T046 |
| joint | integration tests + polish | T031, T038, T044, T047–T053 |

Guard rails, in order:

1. **Scope every implement run.** Invoke `/speckit-implement` with your
   task IDs and tell it not to touch the other member's package.
2. **Ownership table in `tasks.md`.** Implement runs must follow it.
3. **Local deny rules.** Each member blocks edits to the other member's
   package in their own (git-ignored) `.claude/settings.local.json`.
   Restart Claude Code after you create it. Example for the second
   member:

   ```json
   {
     "permissions": {
       "deny": [
         "Edit(packages/relay/**)",
         "Write(packages/relay/**)",
         "Edit(packages/shared/**)",
         "Write(packages/shared/**)"
       ]
     }
   }
   ```

4. **CODEOWNERS.** `.github/CODEOWNERS` requires the owner's review per
   package. Fill in the second member's handle (see the TODO in that
   file) and turn on "Require review from Code Owners" for `main` in the
   GitHub branch protection settings.

Issue rule: GitHub issues track **who does what**. `tasks.md` checkboxes
track **what is done**. `/speckit-implement` and `/speckit-converge` read
`tasks.md`, not GitHub. When you close an issue, also check off the task.

## Setup for the second member

1. Clone the repo and open it in Claude Code.
2. Add your GitHub handle: uncomment the `packages/cli` line in
   `.github/CODEOWNERS`, and replace "partner" in the `tasks.md`
   Ownership table. Commit both.
3. Create `.claude/settings.local.json` with the deny rules shown above.
   Restart Claude Code. Do not commit this file (it is git-ignored).
4. Self-assign your issues (#4, #15–#21, #25–#30, #34–#40, #42–#43, #46).
5. Run `npm install` at the repo root, then `npm test` — the suite must
   be green before you start.
6. The shared schemas and the relay are already on `main`. Start the
   relay with `npm run dev --workspace @saw/relay` (port 8787) and build
   `packages/cli` against it. Import all protocol types and validation
   from `@saw/shared`. Then run:
   `/speckit-implement Only execute my tasks per the Ownership table in
   tasks.md. Do not touch packages/relay or packages/shared.`

## The Spec Kit workflow (already done)

These commands produced the current artifacts, in this order:

| Command | What it did |
|---------|-------------|
| `/speckit-constitution` | Wrote the project principles |
| `/speckit-specify` | Wrote the feature spec |
| `/speckit-clarify` | Resolved 5 ambiguities into the spec |
| `/speckit-plan` | Wrote the plan, research, data model, contracts |
| `/speckit-tasks` | Generated the 53-task breakdown |
| `/speckit-analyze` | Cross-checked all artifacts; fixes applied |
| `/speckit-taskstoissues` | Created GitHub issues #1–#53 from the tasks |

Commands that help from here:

- `/speckit-implement` — execute tasks from `tasks.md`. Always scope it
  to your own tasks (see Work split above).
- `/speckit-converge` — after partial implementation, compare the code
  against the spec and append the missing work to `tasks.md`.
- `/speckit-checklist` — generate a custom quality checklist for the
  feature.

## Documentation rule

All code documentation in this project must follow ASD-STE Simplified
Technical English. Use short sentences. Use one idea per sentence. Use
active voice. Use simple words. See the constitution for the full rule.
