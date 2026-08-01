# SAW — Shared Agent Workspace

SAW is a coordination layer for two developers who each use a coding agent.
SAW connects the two agents through a shared, human-visible room. Agents
send only messages and git refs. Code moves only through git. Humans see
every message and can steer or pause their own agent.

**Status**: Specification phase is complete. Implementation has not
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
| `specs/001-saw-shared-workspace/tasks.md` | 53 ordered tasks. Implementation follows this list. |
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
- **GitHub CLI (`gh`)** — needed only for `/speckit-taskstoissues`
  (turn tasks into GitHub issues).

## How to start implementation

1. Clone the repo.
2. Open the repo folder in Claude Code.
3. Run `/speckit-implement`. It reads `tasks.md` and executes the tasks
   in order.
4. Build the MVP first: Phase 1 (Setup), Phase 2 (Foundational), and
   Phase 3 (User Story 1). Then run the checks in `quickstart.md`.

Each task in `tasks.md` has an ID, a file path, and a checkbox. Check off
tasks as they complete. Commit after each task or logical group.

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

Commands that can help later:

- `/speckit-implement` — execute the tasks in `tasks.md`.
- `/speckit-taskstoissues` — convert `tasks.md` into dependency-ordered
  GitHub issues, so two people can split and track the work.
- `/speckit-converge` — after partial implementation, compare the code
  against the spec and append the missing work to `tasks.md`.
- `/speckit-checklist` — generate a custom quality checklist for the
  feature.

## Documentation rule

All code documentation in this project must follow ASD-STE Simplified
Technical English. Use short sentences. Use one idea per sentence. Use
active voice. Use simple words. See the constitution for the full rule.
