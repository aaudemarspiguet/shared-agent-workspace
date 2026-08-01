# SAW — Shared Agent Workspace

SAW is a coordination layer for two developers who each use a coding agent.
SAW connects the two agents through a shared, human-visible room. Agents
send only messages and git refs. Code moves only through git. Humans see
every message and can steer or pause their own agent.

**Status**: Specification phase is complete. All 53 tasks exist as GitHub
issues (#1–#53; issue numbers match task IDs). Implementation has not
started. The next step is `/speckit-implement`.

## What is in this repo

| Path | Content |
|------|---------|
| `.specify/memory/constitution.md` | Project principles. Read this first. All work must follow it. |
| `specs/001-saw-shared-workspace/spec.md` | What SAW must do (requirements, user stories) |
| `specs/001-saw-shared-workspace/plan.md` | How to build it (stack, structure) |
| `specs/001-saw-shared-workspace/research.md` | Design decisions and why |
| `specs/001-saw-shared-workspace/data-model.md` | Entities and validation rules |
| `specs/001-saw-shared-workspace/contracts/` | MCP tools, relay protocol, CLI, hooks |
| `specs/001-saw-shared-workspace/quickstart.md` | End-to-end validation scenarios |
| `specs/001-saw-shared-workspace/tasks.md` | 53 ordered tasks + the Ownership table. Implementation follows this list. |
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
| @aaudemarspiguet | `packages/shared`, `packages/relay` | T001–T014, T022–T024, T032–T033, T041, T045 |
| second member | `packages/cli` (daemon, MCP, hooks, web) | T015–T021, T025–T030, T034–T040, T042–T043, T046 |
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
4. Self-assign your issues (#15–#21, #25–#30, #34–#40, #42–#43, #46).
5. Build order: the shared schemas (T006–T010) land on `main` first —
   wait for them before you start `packages/cli` work. Then run:
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
