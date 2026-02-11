# Vision — Nibbler

*Structured product brief for Nibbler: a constitutional orchestration engine for AI-powered software development.*

---

## 1. Problem & Context

### What problem are we solving?

AI coding assistants (Cursor, Copilot, Claude Code) are powerful individually, but building real software with them lacks structure, accountability, and safety. A developer manually directing AI sessions has no:

- **Scope enforcement** — the AI modifies whatever it wants, wherever it wants.
- **Verification pipeline** — there is no systematic check that work meets criteria before proceeding.
- **Audit trail** — no record of what was done, why, or by which agent.
- **Role separation** — no way to decompose work across specialized AI sessions with clear boundaries.
- **Human control points** — no structured gates where a product owner approves or redirects.

The result is ad-hoc, untrackable, fragile development that works for scripts and prototypes but breaks down for production software.

### Who is affected?

Software developers and small teams who want to use AI coding agents for non-trivial projects but need governance, traceability, and quality assurance.

### Current workaround

Developers manually prompt AI assistants one session at a time, mentally tracking context, scope, and progress. There is no systematic enforcement — quality depends entirely on the developer's vigilance and the model's compliance.

### Why now?

Cursor Agent CLI, Claude Code, and similar tools have matured to the point where multi-step, multi-role AI-driven development is feasible. What is missing is the orchestration layer that makes it reliable and governed.

---

## 2. Solution Concept

### One-sentence description

Nibbler is a CLI-based supervisor that orchestrates sequential AI coding agent sessions through a governed pipeline of roles, phases, and human approval gates — producing verified, traceable, production-ready code from natural language requirements.

### Product type

**CLI Tool** — a developer/ops tool that runs in the terminal, orchestrating Cursor Agent CLI sessions behind the scenes.

### Core interaction loop

1. **PO describes** what to build (natural language requirement).
2. **Nibbler plans** — an AI Architect session decomposes the work into scoped tasks.
3. **PO approves** the plan at a gate.
4. **Nibbler executes** — specialized AI agent sessions (backend, frontend, testing, docs) work sequentially, each verified before the next starts.
5. **PO approves** the final output at a ship gate.
6. **Code merges** to the user's branch with a linear commit history and full audit trail.

Between gates, the system operates autonomously. The PO is prompted only at declared checkpoints.

---

## 3. Personas & Access

### Product Owner (PO) — Human

- The developer or team lead who describes what to build.
- Active at: discovery (answers questions), declared gates (PLAN, SHIP, EXCEPTION).
- Authority: product decisions — what to build, priorities, scope boundaries, success criteria.
- Cannot: make technical decisions, bypass gates, modify the contract directly.

### Architect — AI Agent

- Proposes project governance (team structure, phases, verification methods) during init.
- Plans work decomposition, delegates to worker roles, resolves technical escalations.
- Authority: technical decisions — architecture, task breakdown, delegation, verification, code review.
- Has broad write access to avoid scope-violation retries during scaffold/triage.

### Worker Roles — AI Agents

- Specialized sessions (backend, frontend, sdet, docs, etc.) that implement within declared scope.
- Authority: implementation within their assigned scope — how to write code, structure it, satisfy verification.
- Cannot: work outside scope, modify governance artifacts, bypass Architect review, interact with PO directly.

### Access model

- **No authentication** — Nibbler is a local CLI tool; the PO is whoever runs it.
- **Role hierarchy** — PO > Architect > Workers. Escalations flow upward; delegations flow downward.
- **Gate enforcement** — PO gates cannot be bypassed by any agent or automated process.

---

## 4. Core Workflows (MVP)

### Workflow 1: Initialize a Project (`nibbler init`)

**Trigger:** Developer runs `nibbler init` in a git repository.

**Steps:**
1. Scan workspace for existing code, docs, and governance artifacts.
2. If `vision.md` or `architecture.md` is missing, run **discovery**: an AI Architect session reads available materials, asks the PO targeted questions (max 3 per batch), and writes both artifacts.
3. Validate artifact quality; optionally propose improvements.
4. Run an Architect session with constitutional meta-rules + project context to propose a governance contract (roles, phases, gates, budgets).
5. Engine validates the contract against 17 meta-rules; loops the Architect on errors.
6. Present the validated contract to the PO for confirmation.
7. Commit contract, Cursor permission profiles, and protocol rules to the repository.

**Output:** `vision.md`, `architecture.md` (if created), `.nibbler/contract/*`, `.nibbler/config/cursor-profiles/*`, `.cursor/rules/00-nibbler-protocol.mdc`.

### Workflow 2: Build a Feature (`nibbler build`)

**Trigger:** Developer runs `nibbler build "requirement"`.

**Steps:**
1. Pre-flight: verify contract exists, discovery artifacts exist.
2. Create a job branch + git worktree (user's working directory stays untouched).
3. **Planning phase** — Architect session produces planning artifacts (acceptance criteria, delegation plan, risk assessment). Engine validates delegation against the contract.
4. **PLAN gate** — PO reviews and approves the plan.
5. **Execution phase** — For each worker role in delegation order:
   - Swap `.cursor/rules/` overlay and permissions config.
   - Run Cursor agent session.
   - Post-hoc verify: git diff scope check + completion criteria + evidence capture.
   - If valid: commit. If invalid: revert, provide feedback, retry within budget or escalate to Architect.
6. **SHIP gate** — PO reviews final output and approves.
7. Merge job branch back into user's branch (when safe); clean up worktree.

**Output:** A branch with linear commit history, full evidence directory, and append-only ledger.

### Workflow 3: Fix a Prior Job (`nibbler fix`)

**Trigger:** Developer runs `nibbler fix` to correct or improve a previous job's output.

**Steps:**
1. Select a completed/failed job (interactive or via `--job <id>`).
2. Collect fix instructions (positional arg, `--file`, or interactive prompt).
3. Create a new job + worktree based on the selected job's branch.
4. Run the contract-driven fix flow (subset of the full build pipeline).
5. Merge back when safe.

**Output:** A corrected branch with fix commits and evidence.

### Workflow 4: Monitor & Resume (`nibbler status`, `nibbler resume`)

**Trigger:** Developer checks on or reattaches to a running/paused job.

**Steps:**
- `nibbler status [job-id]` — reads `status.json` and ledger tail to show current phase, active role, budget consumption, and recent events.
- `nibbler resume <job-id>` — reattaches to a paused job (re-presents gate if paused there, or resumes from last committed state).

### Single most important workflow

**Workflow 2 (Build)** is the core value proposition — turning a natural language requirement into verified, production-ready code through a governed AI pipeline.

---

## 5. Scope Boundaries

### Explicitly NOT in v1

- **Alternative AI backends** — v1 targets Cursor Agent CLI only. The Runner Adapter Interface is ready for Claude Code, Aider, etc., but no adapters are shipped.
- **Web UI** — gate interaction and monitoring are CLI-only.
- **Parallel session execution** — sequential is the deliberate design choice.
- **Remote/distributed execution** — Nibbler is local-first.
- **Plugin/hooks system** — future integration with CI, notifications, PM tools.
- **Cost tracking as a budget dimension** — depends on Cursor CLI exposing token/cost data.
- **Contract format alternatives** — YAML is sufficient; reader abstraction allows future formats.
- **Multi-project template marketplace** — ships with examples, not a marketplace.

### Features to defer

- Team collaboration features (shared contracts, role assignments across people).
- Integration with CI/CD pipelines as automated gate resolvers.
- Advanced verification methods (security scans, performance benchmarks).

### Hard constraints

- **Requires Cursor CLI** (or compatible agent CLI) installed and authenticated.
- **Requires git** — all work happens on git branches with worktree isolation.
- **Node.js 18+** runtime.
- **Local execution only** — no cloud service, no remote API.

---

## 6. Non-Functional Requirements

### Performance

- Engine overhead between sessions: under 2 seconds (swap overlay, permissions, spawn process).
- Verification overhead: milliseconds for diff/scope checks; variable for test suite execution.
- Ledger writes: effectively O(1) (append-only JSONL).

### Availability

- Single-process, local CLI tool. No uptime requirements.
- Graceful shutdown on SIGINT/SIGTERM with evidence preservation.
- Jobs can be resumed after interruption (`nibbler resume`).

### Security

- Never print secrets; redact sensitive data in logs and evidence.
- Per-role Cursor permissions sandboxing via `CURSOR_CONFIG_DIR`.
- Protected paths (`.nibbler/`, `.cursor/rules/00-nibbler-protocol.mdc`, `.git/`) excluded from all role scopes at the meta-rule level.
- No project-local security configuration that could be influenced by repository content.

### Reliability

- Post-hoc enforcement via git diff (simpler and more reliable than pre-emptive filesystem isolation).
- Timeout-based fallback for session completion detection (if NIBBLER_EVENT protocol fails).
- Budget enforcement prevents runaway sessions and jobs.
- Evidence preservation on all failure paths (no silent data loss).

---

## 7. Technical Constraints & Stack

### Implementation language

TypeScript on Node.js (ESM). Rationale: ecosystem alignment with Cursor, strong CLI tooling, fast iteration for v1.

### Key dependencies

| Dependency | Purpose |
|---|---|
| `commander` | CLI argument parsing |
| `yaml` | Contract parsing (YAML format) |
| `chalk` | Terminal styling |
| `@inquirer/prompts` | Interactive gate prompts and PO interview |
| `execa` | Subprocess management (Cursor CLI sessions) |
| `picomatch` | Glob pattern matching for scope verification |
| `zod` | Runtime validation for contracts and ledger entries |
| `nanoid` | Job ID generation |
| `ora` | Terminal spinners |
| `vitest` | Testing framework |
| `tsup` | Build/bundling |
| `tsx` | Development runner |

### Deployment target

- Distributed as an npm package (`npm install -g nibbler` or local).
- Runs wherever Node.js and Cursor CLI are available.
- No containerization, no cloud deployment.

### Integrations

- **Cursor Agent CLI** — the execution engine (via Runner Adapter Interface).
- **Git** — branch management, worktree isolation, diff analysis, scope enforcement.
- No external services, databases, or APIs in v1.

---

## 8. Data Model (Conceptual)

### Key entities

- **Contract** — the project-specific governance structure. Contains roles, phases, gates, budgets, shared scopes. Stored as YAML in `.nibbler/contract/`.
- **Job** — a unit of work from a single `nibbler build` or `nibbler fix` invocation. Has a state machine (created → executing → paused → completed/failed/cancelled/budget_exceeded). Stored as `status.json` + ledger + evidence under `.nibbler/jobs/<id>/`.
- **Session** — a single Cursor agent process execution for a specific role within a job. Produces a git diff that is verified post-hoc.
- **Ledger Entry** — an immutable event record (seq, timestamp, type, data). Types include job lifecycle, phase transitions, session events, verification results, gate resolutions, escalations.
- **Evidence** — captured verification outputs: git diffs, scope check results, completion check results, command outputs, gate presentations and resolutions.
- **Role** — a contract-defined identity with scope, authority, budget, verification method, and behavioral guidance.
- **Phase** — a contract-defined workflow stage with preconditions, actors, input/output boundaries, completion criteria, and successors.
- **Gate** — a contract-defined approval checkpoint with trigger, audience, required inputs, approval scope, and outcome mapping.

### Key relationships

- A **Contract** defines many **Roles**, **Phases**, and **Gates**.
- A **Job** executes the contract's phase graph and contains many **Sessions**.
- Each **Session** belongs to one **Role** and produces **Evidence**.
- **Gates** sit on phase transitions and require resolution before proceeding.
- **Ledger Entries** record all decisions, events, and state transitions for a **Job**.
- **Phases** form a DAG; **Sessions** execute sequentially within phases.

---

## 9. Success Metrics

### What makes v1 a success

- `nibbler init` reliably produces a validated governance contract via Architect session.
- `nibbler build` runs the full pipeline end-to-end: planning → execution → ship.
- All 17 constitutional meta-rules are enforced at contract validation and runtime.
- PO gates (PLAN, SHIP, EXCEPTION) work interactively via CLI.
- Scope enforcement catches and reverts out-of-scope changes with feedback + retry.
- Budget enforcement prevents runaway sessions with escalation.
- Evidence and ledger provide a complete, verifiable audit trail for every job.
- Error recovery handles scope violations, budget exhaustion, session crashes, and gate rejections.

### How we will know it is working

- A developer can describe a feature in natural language and get verified, committed code with an audit trail.
- The audit trail (ledger + evidence) allows full reconstruction of every decision.
- Scope violations are caught and corrected autonomously within budget.
- The PO is prompted only at declared gates — not bombarded with questions during execution.

---

## 10. Roadmap Awareness (Post-v1)

- **Additional AI backends** — Runner adapters for Claude Code, Aider, OpenAI API, local models.
- **Web UI** — browser-based job monitoring, gate approvals, evidence browsing.
- **CI/CD integration** — automated gate resolution, pipeline triggers on job completion.
- **Team collaboration** — shared contracts, role assignments, multi-user gate resolution.
- **Advanced verification** — security scans, performance benchmarks, coverage thresholds.
- **Template contracts** — curated governance templates for common project types.
- **Plugin system** — external scripts observe engine events and extend behavior.
- **Parallel execution** — explore safe parallelism for independent role sessions (longer term).
