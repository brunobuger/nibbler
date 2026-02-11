<div align="center">

<img src="./docs/nibbler-icon.png" alt="Nibbler" width="200"/>

# Nibbler

**AI-Powered Software Development with Guardrails**

*Small but mighty, just like the character from Futurama that inspired this project*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)

</div>

---

## What is Nibbler?

Nibbler is a **supervisor for AI-powered software development**. Think of it as a project manager that coordinates multiple AI agents (using Cursor CLI) to build software — with built-in guardrails to keep everything on track.

Instead of manually directing AI coding sessions, Nibbler:
- 🎯 **Guides AI agents** through defined roles (architect, backend dev, frontend dev, tester, etc.)
- 🛡️ **Enforces boundaries** so each agent only works on what they're supposed to
- 📝 **Tracks everything** in an append-only audit log
- ✅ **Verifies work** at each step before moving forward
- 🚦 **Asks you** for approval at key decision points (gates)

**The result?** You describe what you want to build, and Nibbler orchestrates AI agents to plan, implement, test, and document it — all while maintaining code quality and traceability.

---

## Why Nibbler?

AI coding assistants are powerful, but when building real software, you need:

- **Structure**: Clear phases from planning to shipping
- **Accountability**: Who did what, when, and why
- **Safety**: Prevent AI from making changes outside its scope
- **Quality**: Automated verification at every step
- **Control**: Human approval at critical points

Nibbler provides all of this by treating AI agents like a governed engineering team, complete with roles, permissions, and code review.

---

## How It Works: Building a Web App

Here's what happens when you ask Nibbler to build a web application:

```mermaid
flowchart TD
    Start([You: 'nibbler init']) --> Init[Setup Governance Contract]
    Init --> InitArch[AI Architect proposes team structure<br/>roles, phases, verification methods]
    InitArch --> InitApprove{You approve<br/>contract?}
    InitApprove -->|No| InitArch
    InitApprove -->|Yes| InitCommit[Contract saved to .nibbler/]
    
    InitCommit --> Build([You: 'nibbler build "Create a task manager app"'])
    
    Build --> Discovery[Discovery Phase]
    Discovery --> DiscAI[AI asks questions about your app<br/>users, features, tech stack]
    DiscAI --> DiscDocs[Generates vision.md & architecture.md]
    
    DiscDocs --> Planning[Planning Phase]
    Planning --> PlanArch[AI Architect creates plan<br/>acceptance criteria, task breakdown]
    PlanArch --> PlanGate{You approve<br/>plan?}
    PlanGate -->|No| Planning
    PlanGate -->|Yes| Execution
    
    Execution[Execution Phase] --> ExecRoles[AI agents work in sequence<br/>each in their defined scope]
    ExecRoles --> Backend[Backend Role<br/>implements API & database]
    Backend --> BackendTest{Tests pass?<br/>Scope OK?}
    BackendTest -->|No| Backend
    BackendTest -->|Yes| Frontend[Frontend Role<br/>builds UI components]
    Frontend --> FrontendTest{Tests pass?<br/>Scope OK?}
    FrontendTest -->|No| Frontend
    FrontendTest -->|Yes| SDET[Testing Role<br/>adds integration tests]
    SDET --> SDETTest{Tests pass?<br/>Scope OK?}
    SDETTest -->|No| SDET
    SDETTest -->|Yes| Ship
    
    Ship[Ship Phase] --> Docs[Docs Role<br/>writes README & documentation]
    Docs --> ShipGate{You approve<br/>to ship?}
    ShipGate -->|No| Ship
    ShipGate -->|Yes| Done([Complete!<br/>Code merged to your branch])
    
    style Start fill:#e1f5ff
    style Build fill:#e1f5ff
    style Done fill:#d4edda
    style InitApprove fill:#fff3cd
    style PlanGate fill:#fff3cd
    style ShipGate fill:#fff3cd
    style BackendTest fill:#f8d7da
    style FrontendTest fill:#f8d7da
    style SDETTest fill:#f8d7da
```

### Key Points:

1. **Init once per project** — Nibbler creates a governance contract defining roles, workflows, and checkpoints
2. **Discovery** — AI interviews you to understand what you're building
3. **Planning** — AI architect breaks down the work and you approve the plan
4. **Execution** — Multiple specialized AI agents work sequentially, each verified before the next starts
5. **Ship** — Final approval before code is merged to your branch

All work happens in isolated git worktrees, so your working directory stays clean. Every decision and change is logged for full auditability.

---

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- Git repository (initialized)
- [Cursor CLI](https://cursor.com) installed and authenticated

### Installation

```bash
# Clone and build
git clone https://github.com/yourusername/nibbler.git
cd nibbler
npm install
npm run build
```

### Your First Project

```bash
# 1. Initialize Nibbler in your project (optionally provide discovery inputs)
cd /path/to/your/project
nibbler init --file requirements.md

# The AI will propose a governance structure for your project
# Review and approve it

# 2. Build something!
nibbler build "Create a REST API for managing tasks"
```

That's it! Nibbler will guide AI agents through discovery, planning, implementation, testing, and documentation.

---

## Commands

### `nibbler init`

Sets up governance for your project (and runs discovery to produce `vision.md` + `architecture.md` if they're missing). The AI Architect proposes:
- **Roles** (e.g., backend, frontend, testing, docs)
- **Phases** (planning → execution → ship)
- **Gates** (where you approve or reject)
- **Verification methods** (tests, lints, scope checks)

After you approve the contract, Nibbler also generates and commits:
- **Workflow rules**: `.cursor/rules/10-nibbler-workflow.mdc` (AI-generated, contract-aware, regenerated by `nibbler init --review`)

**Options:**
- `--file <path>` — Input document for discovery (repeatable)
- `--review` — Update an existing contract
- `--skip-discovery` — Skip discovery (requires existing `vision.md` + `architecture.md`)
- `--dry-run` — Preview without committing

**Example:**
```bash
nibbler init
nibbler init --file requirements.md
nibbler init --review  # Update contract as project evolves
```

---

### `nibbler build "<requirement>"`

Run a complete development job from planning to shipping.

During a job, agents are encouraged (best-effort) to write a **handoff** after each session:
- **Write (agent)**: `.nibbler-staging/<jobId>/handoffs/<roleId>-<phaseId>.md`
- **Read (downstream roles)**: `.nibbler/jobs/<jobId>/plan/handoffs/`

**Options:**
- `--file <path>` — Accepted (repeatable). Currently reserved; discovery inputs are handled by `nibbler init --file`.
- `--dry-run` — Print the contract-defined execution plan summary (no agent sessions run)
- `--skip-scaffold` — Accepted. Currently a hint; scaffolding is controlled by the contract phases.

**Examples:**
```bash
# Simple requirement
nibbler build "Add password reset feature"

# See what would happen without executing
nibbler build --dry-run "Refactor authentication module"
```

---

### `nibbler fix [instructions]`

Apply a targeted fix on top of an existing job. This is useful when you want to improve or correct the output of a prior run without starting from scratch.

By default, Nibbler will prompt you to select a job to fix (interactive mode). It then creates a new job/worktree based on the selected job branch, runs the contract-driven fix flow, and merges back when safe.

**Options:**
- `--job <id>` — Job ID to fix (skips interactive selection)
- `--file <path>` — Read fix instructions from a file

**Examples:**

```bash
# Interactive: pick a job, then type instructions
nibbler fix

# Fix a specific job with a short instruction
nibbler fix --job j-20260209-001 "Update the API error format to match the spec"

# Use a longer fix description from a file
nibbler fix --job j-20260209-001 --file fix-notes.md
```

---

### `nibbler status [job-id]`

Check the current state of a running job.

Tip: `status` is the fastest way to diagnose stalled jobs. Recent entries usually show whether a session completed, was reverted, timed out, or exited unexpectedly.

**Options:**
- `--tail <n>` — Show last N ledger entries (default: 10)

**Example:**
```bash
nibbler status
nibbler status job-abc123 --tail 20
```

---

### `nibbler list`

List all active or paused jobs.

```bash
nibbler list
```

---

### `nibbler history`

View completed jobs and their outcomes.

**Options:**
- `--detail <job-id>` — Show full ledger for a specific job

**Example:**
```bash
nibbler history
nibbler history --detail job-abc123
```

---

### `nibbler resume <job-id>`

Resume a paused or interrupted job.

```bash
nibbler resume job-abc123
```

---

## Understanding the Governance Model

Nibbler uses a **contract-based governance system** to ensure AI agents work safely and effectively.

### Roles

Each role has:
- **Scope** — Files/directories they can modify
- **Authority** — Commands they can run
- **Budget** — Iteration limits before escalation
- **Verification** — How their work is checked

Example roles: architect, backend, frontend, sdet (testing), docs

### Phases

Work flows through phases:
1. **Discovery** — Understand what to build
2. **Planning** — Break down into tasks
3. **Execution** — Implement with verification
4. **Ship** — Finalize and document

### Gates

Gates are approval checkpoints where you decide:
- ✅ **Approve** — Continue to next phase
- ❌ **Reject** — Loop back with feedback
- ⚠️ **Exception** — Handle edge case

Common gates:
- **PLAN gate** — After planning, before execution
- **SHIP gate** — Before final merge

At a gate prompt, you’ll typically see:
- **Team** — roles + scopes (who is responsible for what)
- **Transition + outcomes** — what “approve” and “reject” will do
- **Acceptance criteria** — the phase’s deterministic checks
- **Artifacts** — required inputs with previews (and a “View artifact” drill-down)

### Evidence & Audit Trail

Every job creates:
- **Ledger** (`.nibbler/jobs/<id>/ledger.jsonl`) — Append-only log of all decisions
- **Evidence** (`.nibbler/jobs/<id>/evidence/`) — Diffs, test results, verification outputs
- **Status** (`.nibbler/jobs/<id>/status.json`) — Current job state

This gives you full traceability: who did what, when, and why.

---

## Configuration

### Environment Variables

```bash
# Cursor binary location (if not in PATH)
export NIBBLER_CURSOR_BINARY=cursor

# Model selection
export NIBBLER_CURSOR_MODEL="gpt-5.2-high"              # All sessions
export NIBBLER_CURSOR_MODEL_PLAN="gpt-5.2-codex-xhigh"  # Planning only
export NIBBLER_CURSOR_MODEL_EXECUTE="gpt-5.2-high"      # Execution only

# Debugging
export NIBBLER_VERBOSE=1                                # Detailed error output
export NIBBLER_QUIET=1                                  # Minimal output for scripts
export NIBBLER_FORCE_EXIT_GRACE_MS=6500                 # Ctrl+C force-exit cleanup grace window (ms)
```

### Contract Files

After `nibbler init`, you'll find:

```
.nibbler/
├── contract/
│   ├── team.yaml          # Role definitions
│   ├── phases.yaml        # Phase graph and gates
│   └── project-profile.yaml  # Detected project metadata
├── config/
│   └── cursor-profiles/   # Per-role Cursor CLI permission profiles
└── jobs/
    └── <job-id>/          # Per-job artifacts

.cursor/
└── rules/
    ├── 00-nibbler-protocol.mdc  # Base protocol
    └── 20-role-*.mdc            # Role overlays (swapped per session; gitignored)
```

You can edit these files to customize governance, then run `nibbler init --review` to validate changes.

---

## Artifacts Generated

### Discovery Outputs

- `vision.md` — Product vision, users, core workflows (generated during `nibbler init` if missing)
- `architecture.md` — Technical architecture, stack choices, structure (generated during `nibbler init` if missing)

### Job Outputs

For each job in `.nibbler/jobs/<job-id>/`:

- `plan/` — Planning artifacts
  - `delegation.yaml` — Validated delegation plan (when planning produces one)
  - `<role>-impl-plan.md` — Per-role implementation plan (delegation-driven execution)
  - `resolutions/<role>.md` — Architect guidance for escalations
- `evidence/` — Verification results
  - `diffs/` — Code changes per session
  - `checks/` — Scope and test results
  - `gates/` — Gate decisions
  - `commands/` — Command outputs captured by deterministic checks
- `ledger.jsonl` — Append-only event log
- `status.json` — Current state

---

## Troubleshooting

### "Working tree is not clean"

Nibbler runs builds in an isolated git worktree, so your local changes no longer block starting a build.
If Nibbler needs to merge the result back into your current branch, it will **auto-stash** your local changes
for the merge and then restore them.

If restoring local changes results in conflicts, Nibbler will stop with instructions and your stash entry will remain.

### "Cursor agent binary not found"

Make sure Cursor CLI is installed and in your PATH, or set:

```bash
export NIBBLER_CURSOR_BINARY=/path/to/cursor
```

### Canceling a run (Ctrl+C)

- Press **Ctrl+C once** to request graceful cancellation.
- Press **Ctrl+C again** to force exit if shutdown is stuck (Nibbler still performs bounded cleanup first).
- If a run was interrupted, use `nibbler status <job-id>` and `nibbler resume <job-id>` as needed.

### Job gets stuck or makes no progress

Check the status and ledger:

```bash
nibbler status <job-id> --tail 50
```

If an agent is stuck in a loop, you can cancel and manually intervene:
1. Press Ctrl+C once to stop gracefully (press again to force exit if needed)
2. Inspect `.nibbler/jobs/<job-id>/evidence/`
3. Fix issues manually or adjust the contract
4. Resume with `nibbler resume <job-id>`

### Job fails with `process_exit` or inactivity timeout

This means the session ended unexpectedly (process exit) or produced no activity before timeout.

Recommended checks:
1. Run `nibbler status <job-id> --tail 50` to inspect the latest session outcome
2. Re-run with `NIBBLER_VERBOSE=1` for richer runner/prompt diagnostics
3. Retry with `nibbler resume <job-id>` after fixing obvious environment issues (dependencies, dev server startup, CLI auth)

### Job shows `budget_exceeded`

If a job exceeded its **global lifetime budget**, resuming it will usually fail immediately (the budget is still exhausted).

Recommended options:
1. **Start a new job** (fresh job lifetime budget)
2. **Increase `globalLifetime.maxTimeMs`** in your contract, then re-run
3. Inspect the **ledger tail** and evidence to see what happened:

```bash
nibbler status <job-id> --tail 50
```

### Tests fail during execution

Nibbler will automatically retry within budget limits. If persistent:
1. Check `.nibbler/jobs/<job-id>/evidence/checks/`
2. Look at the actual test failures
3. The Architect agent will escalate if it can't resolve
4. You'll get an EXCEPTION gate to provide guidance

---

## Examples

### Example 1: New API Service

```bash
cd my-new-api
nibbler init
nibbler build "Create a REST API for a book library with CRUD operations"
```

Nibbler will:
1. Ask about authentication, database, API style
2. Generate vision.md and architecture.md
3. Create a plan with backend + testing roles
4. Implement the API with tests
5. Generate API documentation

### Example 2: Add Feature to Existing App

```bash
cd my-app
nibbler init  # If not already initialized
nibbler build --file feature-spec.md "Add real-time notifications"
```

Nibbler will:
1. Read your existing codebase
2. Understand the feature from the spec
3. Plan integration points
4. Implement across relevant roles (backend, frontend)
5. Add tests for the new feature
6. Update documentation

### Example 3: Refactoring

```bash
nibbler build "Refactor authentication to use JWT instead of sessions"
```

Nibbler will:
1. Analyze current auth implementation
2. Plan the migration strategy
3. Update backend code with tests
4. Update frontend code with tests
5. Verify all tests pass
6. Document the changes

---

## Contract Examples

See `docs/contracts/` for example governance structures:

- **Web Application** — Backend, frontend, testing, docs roles
- **API Service** — Backend, testing, docs roles
- **CLI Tool** — Core, testing, docs roles

Each example shows how to define roles, phases, gates, and verification methods.

---

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev -- --help

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint
npm run lint:fix

# Format
npm run format
npm run format:fix
```

---

## Philosophy

Nibbler is built on three core principles:

1. **File-based truth** — Everything lives in git, not in memory. Artifacts are the source of truth.

2. **Deterministic governance** — The system behavior is predictable even when AI is not. Enforcement happens through verification, not trust.

3. **Constitutional framework** — A small set of immutable rules (the "constitution") guarantees structural properties. Everything else is contract-level and can evolve.

---

## Roadmap

- [ ] Support for more AI backends (OpenAI API, Anthropic, local models)
- [ ] Web UI for job monitoring and gate approvals
- [ ] Integration with CI/CD pipelines
- [ ] Team collaboration features (shared contracts, role assignments)
- [ ] Advanced verification methods (security scans, performance tests)
- [ ] Template contracts for common project types

---

## Contributing

Contributions are welcome! Please read our contributing guidelines and submit PRs.

---

## License

MIT License - see LICENSE file for details.

---

## Acknowledgments

Inspired by **Nibbler** from Futurama — small, seemingly simple, but surprisingly powerful and intelligent. Just like this tool aims to be for AI-powered development.

---

<div align="center">

**Built with ❤️ for developers who want AI assistance with guardrails**

[Documentation](./docs) • [Examples](./docs/contracts) • [Issues](https://github.com/yourusername/nibbler/issues)

</div>
