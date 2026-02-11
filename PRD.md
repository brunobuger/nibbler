# Nibbler — Product Requirements Document

*A role-governed, artifact-driven orchestration layer that wraps Cursor Agent CLI sessions with deterministic guardrails, scoped context, and PO-only gates.*

---

## 1. Vision

Nibbler is a **supervisor/orchestrator** for AI-powered software development. It drives code changes by controlling sequential Cursor Agent CLI sessions — each representing a distinct engineering role — while enforcing deterministic governance through a minimal constitutional framework.

The system consumes product specifications and produces production-ready code through a governed pipeline of role-scoped AI agent sessions. Each session operates within clear boundaries, produces durable artifacts, and is verified by deterministic checks before the pipeline advances.

Nibbler enforces **structural invariants** — not specific methodologies. The governance framework is intentionally abstract: it guarantees that work is scoped, verified, traceable, and gated, without prescribing how any of those properties are achieved. The specific team structure, workflow phases, verification methods, and artifact formats are proposed by an Architect agent during initialization and validated against the constitutional meta-rules.

### 1.1. Core Metaphor

Nibbler looks simple but is deeply intelligent. It consumes messy inputs (rough specs, scattered docs, verbal ideas) and produces structured, verified, production-grade outputs. The system behavior is deterministic even though the underlying AI execution is not — determinism is achieved through enforcement and evidence, not by constraining the model.

### 1.2. Design Philosophy

**File-and-git centric.** Durable artifacts are the source of truth. Model memory is never trusted. Every decision, output, and verification result lives on disk, in git, or in an append-only ledger.

**Artifact-driven context.** Agent sessions do not share conversation history. They share artifacts. The output of one session becomes the input of the next, mediated by the file system. Cursor discovers context naturally by reading the workspace.

**Constitutional governance.** Nibbler ships with a small, stable set of meta-rules (the "constitution") that guarantee structural properties. Everything else — roles, phases, verification methods, artifact formats — is contract-level, proposed by the Architect, and validated against the constitution.

**Sequential execution, per-job worktree.** All work happens one role at a time, but each job runs inside its own **git worktree** on a job branch (e.g. `nibbler/job-<id>` or `nibbler/fix-<id>`). The user's working directory and current branch are not modified during execution. Scope enforcement is post-hoc: let the agent work, then verify the diff. On success, Nibbler merges the job branch back into the user's original branch (only when safe) and cleans up the worktree; on failure, it preserves the worktree + branch for inspection/manual merge.

---

## 2. Goals and Non-Goals

### 2.1. Goals

- **Cursor-first execution.** All repository edits and commands are executed through active Cursor CLI agent sessions. Cursor is the execution engine.
- **Minimal PO interaction.** The Product Owner is prompted only at declared gates (e.g., PLAN, EXCEPTION, SHIP). Between gates, the system operates autonomously.
- **Deterministic governance.** Roles, scopes, permissions, checks, and gates are enforced by Nibbler regardless of model behavior. The system behavior is deterministic even when the model's output is not.
- **Session segregation.** Each role runs with its own scoped rules and permissions. Scope violations are detected post-hoc via git diff verification.
- **Auditability.** Every decision, diff, verification output, gate, and approval is logged to an append-only ledger.
- **Future-proof flexibility.** No hardcoded schemas, role names, phase names, or methodologies. The Architect proposes the project's governance structure; Nibbler validates and enforces it.

### 2.2. Non-Goals

- Not a replacement for git hosting, CI, or code review tools. Nibbler produces shippable artifacts and evidence; existing pipelines still run.
- Not trying to make LLM outputs deterministic. Nibbler makes the **system behavior** deterministic through enforcement and evidence.
- Not prescribing specific SDLC methodologies. If TDD is the right approach, the Architect proposes it. If something else is better, the Architect proposes that instead. Nibbler enforces that *a* verification method exists and passes, not *which* method.

---

## 3. Decision Authority Model

Authority is distributed across three actors with clear boundaries:

### 3.1. Product Owner (PO)

- **Authority over:** Product decisions — what to build, why, priorities, scope boundaries, success criteria.
- **Active during:** Discovery phase (answers questions, approves vision), declared gates (PLAN, EXCEPTION, SHIP).
- **Cannot:** Make technical decisions, bypass gates, modify the contract directly.

### 3.2. Architect (AI Agent)

- **Authority over:** Technical decisions — architecture, task decomposition, delegation, verification methods, code review.
- **Active during:** Discovery (as interviewer/advisor — proposes, PO decides), planning (full authority to decompose and delegate), execution (review and technical escalation resolution), init (proposes the governance contract).
- **Cannot:** Bypass PO gates, approve its own SHIP gate, modify meta-rules.
- **Reliability default:** The Architect should typically have **broad write access** via `authority.allowedPaths` to avoid scope-violation retries during scaffold/triage. This must *not* be expressed as `scope: ["**/*"]` (which would violate overlap rules); see Rule 1.3 and Section 8 (Contract).

### 3.3. Worker Roles (AI Agents)

- **Authority over:** Implementation within their declared scope — how to write the code, how to structure it, how to satisfy the verification criteria.
- **Active during:** Execution phase, within their assigned tasks.
- **Cannot:** Work outside their declared scope, modify governance artifacts, bypass Architect review, interact with the PO directly (escalations route through the Architect).

### 3.4. Authority Flow by Phase

| Phase | Proposals come from | Decisions made by | PO involvement |
|-------|-------------------|-------------------|----------------|
| Discovery | Architect | PO | Direct — answers questions, approves vision |
| Init | Architect | PO confirms | Approves governance contract |
| Planning | Architect | Architect (within PO-approved scope) | Approves plan at PLAN gate |
| Execution | Workers | Architect (for technical issues) | Only at EXCEPTION gates |
| Ship | Architect | PO | Approves at SHIP gate |

---

## 4. Constitutional Meta-Rules

These are the invariant rules that Nibbler enforces. They are structural, deterministically enforceable, and cannot be relaxed by the contract. The contract can add constraints on top of these but cannot weaken them.

### 4.1. Design Principles for Meta-Rules

**Structural, not behavioral.** Meta-rules describe the shape of valid states and transitions. They never prescribe specific methodologies — only that verification exists and passes, that scope is declared and respected, that decisions are recorded.

**Enforceable by the engine alone.** Every meta-rule must be checkable by deterministic code: file exists, diff within scope, command exited 0, gate approval recorded. If a rule requires an LLM to judge compliance, it belongs in the contract, not the constitution.

**Immutable at runtime.** Meta-rules are part of Nibbler's source code. The contract cannot override them. They change only through Nibbler version upgrades.

### 4.2. Domain 1 — Identity & Scope

**Rule 1.1 — Every actor must have a declared scope.**
Any entity that performs work must have a scope declaration in the contract that defines what it is allowed to affect. The contract defines what "scope" means for the project (file paths, modules, domains). The declaration must exist.

*Engine enforcement:* At contract validation, reject any role definition without a scope declaration. At session launch, refuse to start a session for a role without a scope.

**Rule 1.2 — Work must not exceed the actor's declared scope.**
After a session produces changes, the actual git diff must fall within that actor's declared scope. The contract defines scope boundaries; the engine verifies compliance post-hoc.

*Engine enforcement:* After every session, diff the working tree against the pre-session commit. Check every changed file path against the role's **effective write set**: `role.scope` + declared `sharedScopes` + `role.authority.allowedPaths`, minus protected paths. Violations trigger rejection, revert, and feedback or escalation per the contract's rules.

**Rule 1.3 — Scope overlaps must be explicitly declared.**
If two roles can affect the same paths, those paths must be declared as shared scope in the contract. Undeclared overlaps are a contract validation error. With sequential execution, no conflict resolution strategy is required — just declaration and awareness.

*Engine enforcement:* At contract validation, compute scope intersections across all roles. Any intersection without a shared-scope declaration is rejected. The engine tracks which shared-scope files were modified by each role and includes that information in subsequent sessions' context.

### 4.3. Domain 2 — Artifact Flow

**Rule 2.1 — Every phase must declare its input and output boundaries.**
A phase definition in the contract must declare what it consumes and what it produces, expressed as folder paths or path patterns relative to the job workspace. This is how the engine knows what to expect at phase start and what to verify at phase completion.

*Engine enforcement:* At phase start, verify declared input folders exist and contain content. At phase completion, verify declared output folders contain new or modified content. Empty output folders when the contract says something should have been produced is a completion failure.

**Rule 2.2 — Downstream sessions must have access to upstream outputs.**
If phase B depends on phase A in the phase graph, and A produces outputs that B's contract declares as inputs, the engine must ensure those outputs are accessible in B's workspace. Since all sessions share the same workspace and branch, this is naturally satisfied — each role sees the full current state of the repo including everything previous roles committed.

*Engine enforcement:* At phase start, verify that every folder the session's phase declares as input exists and is populated.

**Rule 2.3 — The engine controls artifact visibility through workspace structure.**
Each session's workspace is the sole interface between Nibbler and the Cursor agent. The engine controls what the agent focuses on through `.cursor/rules/` overlays and Cursor permissions config. Cursor discovers content naturally through its own file scanning. The file system is the registry.

*Engine enforcement:* Design principle enforced through the swap mechanism — only rules and permissions change between sessions. The workspace itself is shared and continuous.

### 4.4. Domain 3 — Transitions & Gating

**Rule 3.1 — Phase transitions require all completion criteria to be satisfied.**
A phase cannot transition to its successor until the contract's completion criteria for that phase are met. Completion criteria are declared in the contract and must be deterministically verifiable by the engine.

*Engine enforcement:* The engine evaluates each completion criterion after session teardown. All must pass. No partial credit — either criteria are met or the phase loops, escalates, or blocks.

**Rule 3.2 — Gate approvals are required where declared and cannot be bypassed.**
If the contract declares a gate at a transition point, that gate must be presented to its declared audience and an explicit approval recorded before the transition proceeds. No automated process can substitute for a gate approval.

*Engine enforcement:* Gate-bearing transitions block until resolved. Resolution (approve, reject, exception) is recorded in the ledger with timestamp and approver identity. Agent sessions cannot write gate resolutions.

**Rule 3.3 — The phase graph must be acyclic at the macro level.**
The contract's phase definitions must form a directed acyclic graph from start to completion. Individual phases can have internal loops (retry, revision), but the overall job must have a defined forward direction and a reachable terminal state.

*Engine enforcement:* At contract validation, verify the phase graph is a DAG. Internal retry loops within a phase are permitted but governed by budgets (Domain 4).

**Rule 3.4 — Rejected gates must have a defined recovery path.**
If a gate is rejected, the contract must define what happens — loop back to a previous phase, escalate, or terminate the job. No undefined state after a rejection.

*Engine enforcement:* At contract validation, verify every gate has defined outcomes for all possible resolutions (at minimum: approve, reject).

### 4.5. Domain 4 — Budgets & Termination

**Rule 4.1 — Every session must have a budget.**
A session's budget can be defined in whatever units the contract specifies — iterations, time, diff size, files changed, cost, tokens, or a combination. A budget must exist. Unbounded sessions are a contract validation error.

*Engine enforcement:* At contract validation, verify every role definition includes budget parameters. At runtime, track consumption and enforce limits.

**Rule 4.2 — Budget exhaustion must trigger a defined escalation.**
When a session exceeds its budget, the engine follows a declared escalation path — not silent continuation, not silent termination. The contract defines what happens: escalate to Architect, raise an exception gate, or terminate with evidence.

*Engine enforcement:* Budget tracking halts the session on exhaustion and follows the contract's escalation path. The event is recorded in the ledger.

**Rule 4.3 — Every job must have a maximum lifetime.**
Jobs cannot run indefinitely. The contract must declare a global job budget. If exceeded, the job terminates with a full evidence dump.

*Engine enforcement:* Global budget tracked from job start. Hard termination with evidence capture when exceeded.

**Rule 4.4 — Termination must preserve evidence.**
Whether a job completes successfully, fails, is budget-terminated, or is PO-cancelled — all evidence produced up to that point is preserved. Nothing is silently discarded.

*Engine enforcement:* Evidence capture runs as a shutdown hook. Termination reason and evidence paths recorded in ledger.

### 4.6. Domain 5 — Governance & Auditability

**Rule 5.1 — Every decision must be recorded.**
Every gate approval/rejection, every escalation, every scope exception, every budget extension, every contract modification — recorded in the append-only ledger with timestamp, actor, decision, and rationale.

*Engine enforcement:* The ledger is written by the engine, not by sessions. Sessions produce artifacts; the engine records decisions about those artifacts.

**Rule 5.2 — The ledger is append-only.**
No ledger entry can be modified or deleted. Corrections are expressed as new entries referencing the original.

*Engine enforcement:* The ledger writer only supports append operations. Sequential entry numbering with no gaps for integrity verification.

**Rule 5.3 — Agent sessions cannot modify the contract, the ledger, or engine control files.**
The governance infrastructure — contract, ledger, phase state, budget trackers — is engine-only territory. No agent session can write to these paths regardless of scope configuration.

*Engine enforcement:* These paths are excluded from every role's scope as a meta-rule override, even if the Architect attempts to include them.

**Rule 5.4 — Every verification must produce evidence.**
When the engine runs a verification (scope check, test run, artifact existence check, budget check), it captures the result as evidence. Not just pass/fail — the full output is stored.

*Engine enforcement:* Every verification function writes its inputs and outputs to the evidence directory before returning its result.

**Rule 5.5 — PO authority cannot be delegated below the declared gate level.**
If the contract declares that the PO approves at a gate, no agent session or automated process can substitute for that approval. Gate audiences are locked at contract validation time.

*Engine enforcement:* Gate resolution functions verify the approver identity against the contract's declared audience for that gate.

---

## 5. Discovery Phase — Product Vision Extraction

### 5.1. Purpose

The discovery phase transforms raw PO input — messy PRDs, scattered docs, verbal ideas, or nothing at all — into a structured product vision that the Architect can plan against. It is the front door to Nibbler and the foundation for everything downstream.

### 5.2. Input Spectrum

POs arrive with wildly different starting points. The discovery flow must handle all of them:

- **Nothing** — just a verbal idea or short description
- **Partial docs** — rough PRD, user stories, competitor notes
- **Rich docs** — detailed PRD, wireframes, API specs
- **Existing repo** — "I have this app, I want to add feature X"

### 5.3. Project Type Classification

The project type drives which questions matter, what defaults are sensible, and what the scaffold looks like. Early in discovery, the agent classifies (by inference or by asking) and loads the appropriate question module.

**Primary types:**

- **Web Application** — Frontend + backend + database. SaaS, internal tool, dashboard, marketplace.
- **API / Service** — No user-facing frontend. Public API, microservice, webhook processor, data pipeline.
- **CLI Tool** — Developer or ops tooling. Interactive or batch.
- **Mobile Application** — iOS, Android, or cross-platform. Distinct platform constraints.
- **Library / Package** — Reusable code published for developers. SDK, plugin, utility.
- **Data Pipeline** — ETL, analytics, ML training, batch processing.

Each type has a **question module** that adjusts the emphasis, defaults, and specific questions within the tiered schema.

### 5.4. Tiered Question Schema

The schema is organized into three tiers representing information priority. The agent works through them adaptively — skipping pre-filled answers, confirming inferences, and asking only for gaps.

#### Tier 1 — Blocking (cannot plan without these)

**Problem & Context**
- What problem are we solving? For whom?
- What's the current workaround (how do people handle this today)?
- Why now — what's the trigger for building this?

**Solution Concept**
- What's the product in one sentence?
- What type of product is this? (web app, API, CLI, mobile, library, pipeline)
- What's the core interaction loop — the one thing users do repeatedly?

**Personas & Access**
- Who are the distinct user types?
- Is there a hierarchy? (admin/manager/user, or flat?)
- Authentication model — open, invite-only, SSO, public + private areas?

*Note: Type-specific modules add questions here. For APIs, "personas" becomes "consumer profiles." For CLI tools, authentication is typically de-emphasized.*

**Core Workflows (MVP)**
- What are the 3-5 things a user must be able to do for this to be useful?
- For each: trigger → steps → expected outcome
- Which is the single most important one?

**Scope Boundaries**
- What's explicitly NOT in v1?
- Features the PO is tempted to include but should defer?
- Hard constraints: budget, timeline, regulatory?

#### Tier 2 — Important (needed for quality, can be inferred with confirmation)

**Non-Functional Requirements**
- Performance expectations
- Availability needs
- Security & compliance
- Offline/connectivity requirements

*The agent infers sensible defaults from the project type and domain, then asks the PO to confirm. "You're building a healthcare app — I'm assuming HIPAA compliance is required. Correct?" is faster than "What are your compliance requirements?"*

**Technical Constraints & Integrations**
- Required or preferred tech stack?
- Must integrate with existing systems?
- Existing codebase to extend?
- Deployment target?

*If the PO says "I don't care, pick what's best," that's a valid answer. The Architect chooses and documents it.*

**Data Model (conceptual)**
- What are the core "things" in the system? (entities, not tables)
- Key relationships between them?
- What data exists vs. created fresh?

#### Tier 3 — Enrichment (improves quality, can emerge during planning)

**User Journeys**
- First-time user experience — sign-up to first value
- Daily driver path — what a returning user does most often
- Known edge cases

**Success Metrics**
- How will you know this is working?
- What would make v1 a success in 3 months?

**Roadmap Awareness**
- What's coming in v2/v3 that we should design for now?
- Known scaling inflection points?
- Platform expansion plans?

### 5.5. Type-Specific Question Modules

Each project type adds or adjusts questions within the tiers:

**Web Application** adds: authentication model details, multi-tenancy, responsive requirements, real-time needs, SEO.

**API / Service** adds: consumer profiles, contract style (REST/GraphQL/gRPC/event-driven), rate limiting, versioning strategy, SDK needs.

**CLI Tool** adds: command structure, input/output model, distribution method, configuration model, shell completion.

**Mobile Application** adds: platform targets, offline behavior, push notifications, device capabilities, app store considerations.

**Library / Package** adds: target language/runtime, public API surface, versioning strategy, backward compatibility, documentation expectations.

**Data Pipeline** adds: sources and sinks, volume/velocity, scheduling, idempotency, monitoring, data quality.

### 5.6. Adaptive Interview Behavior

The discovery interview is contextual and adaptive, not a linear questionnaire:

**Scenario A — PO provides nothing.** Full Tier 1 walkthrough, Tier 2 with smart defaults, Tier 3 if PO is engaged. Approximately 8-12 question batches of 2-3 questions each. Target: five minutes.

**Scenario B — PO provides documents.** Ingest first, pre-fill, then confirmation pass: "Here's what I extracted — confirm or correct." Followed by targeted gap questions. Approximately 3-5 batches. Target: two minutes.

**Scenario C — Existing repo + feature request.** Read codebase and existing artifacts, ask only about the delta. Approximately 2-3 batches. Target: one minute.

Questions come in **small batches (2-3 at a time)**, each batch informed by previous answers. The agent rephrases questions naturally, combines related questions, and skips or infers based on responses.

For technical questions (stack, NFRs, deployment), the Architect **proposes a default with rationale and alternatives** and the PO accepts or overrides.

### 5.7. Discovery Outputs

The discovery phase produces two artifacts:

**`vision.md`** — The structured product brief. Human-readable and machine-consumable. Contains all answered questions organized by the schema, with clear sections for problem, solution, personas, workflows, scope, NFRs, constraints, data model, success criteria, and roadmap notes. This becomes the source of truth for everything downstream.

**`architecture.md`** — Generated or reconciled.

- *If missing (greenfield):* Architect proposes architecture derived from the vision — stack choices, repo structure, deployment approach, key technical decisions. Each proposal includes brief rationale and alternatives. PO approves.
- *If exists:* Architect reconciles against the vision, flags conflicts ("architecture says REST but vision requires real-time collaboration"), flags gaps ("no auth mentioned but three user roles defined"), flags over-specification ("Kubernetes for 50 users?"), and proposes updates. PO approves.
- *If existing repo:* Also reads the actual codebase to understand what's really there vs. what's documented. Updates `architecture.md` to match reality, then layers in new requirements.

---

## 6. The Context Engine

The context engine is the intelligence core of Nibbler. For any given session, it determines what context the agent receives, what it must produce, and how its work is verified.

### 6.1. Core Principle — Folder as Registry

The file system is the artifact registry. Nibbler does not maintain a separate metadata database tracking artifacts. If an artifact exists in the right folder, Cursor sees it. If it doesn't, Cursor doesn't. The engine controls context through folder structure, `.cursor/rules/` overlays, and Cursor permissions config.

### 6.2. Three-Layer Context Model

Every agent session receives context assembled from three layers:

**Layer 1 — Identity (who you are).** The role definition from the contract. Established at `nibbler init`, stable across jobs. Contains: role name, responsibilities, scope boundaries, authority limits, output expectations, behavioral guidance. Materialized as `.cursor/rules/20-role-<role>.mdc`.

**Layer 2 — Mission (what you're doing now).** Job-specific and task-specific. Comes from the planning artifacts. Contains: assigned tasks, relevant acceptance criteria, dependencies, current phase within the workflow. Materialized as part of the role rule overlay and/or the bootstrap prompt.

**Layer 3 — World (what you need to know).** The curated project knowledge relevant to this role. Always includes `vision.md` and `architecture.md`. May include upstream outputs (test files from a testing role, review notes from the Architect, handoff artifacts from previous roles). Since all sessions share one workspace, the agent naturally sees everything committed by previous roles — Layer 3 control happens through the rules overlay, which tells the agent what to focus on.

### 6.3. Context Compilation Algorithm

```
To prepare a session for role R in phase P:

1. Read contract: what does phase P declare as inputs?
2. Read contract: what is role R's scope?
3. Swap .cursor/rules/:
   - Keep base rules (00-*, 10-*, etc.)
   - Remove previous role's overlay
   - Write R's overlay (20-role-<R>.mdc) containing:
     → Layer 1: role identity, scope, authority, outputs expected
     → Layer 2: assigned tasks, acceptance criteria, phase context
     → Layer 3: guidance on what files/folders to read for context
4. Swap Cursor permissions config for R's allowlist
5. Record pre-session git state (commit hash)
6. Launch Cursor agent session
7. On session completion:
   → Diff working tree against pre-session state
   → Verify all changed paths within R's scope
   → Run contract-declared verification methods
   → Capture evidence
   → Commit if valid, reject/revert if not
```

### 6.4. The Swap Mechanism

Between sessions, exactly three things change:

1. **`.cursor/rules/20-role-<role>.mdc`** — The role overlay rule file. Removed and rewritten for the new role. This is the primary context injection channel.
2. **Cursor CLI permissions config** — The command and path allowlist. Rewritten for the new role's authority profile.
3. **The bootstrap prompt** — The first message to the new session. Can be minimal since the rules overlay carries most context.

Everything else persists: the workspace, the branch, the committed files from previous sessions, the base cursor rules, the `.nibbler/` governance folder.

### 6.5. Artifact Chain Between Sessions

Since execution is sequential on a single branch, each role naturally inherits everything the previous role committed. The artifact chain is implicit in the git history:

```
Scaffold commit → SDET commits test files → Backend commits implementation
→ Frontend commits implementation → each role sees all prior work
```

The engine doesn't need to copy or mount artifacts. It just needs to ensure the task ordering in the delegation plan creates a logical flow — tests before implementation, shared types before consumers, etc. The Architect handles this during planning.

### 6.6. Discovery Phase Engine Behavior

The discovery phase is special: the Architect session runs with a **structured question schema injected** as part of its context. The schema includes:

- The tiered question structure (Tier 1, 2, 3)
- Per-question status tracking (gap, inferred, confirmed, answered)
- The project-type-specific question module
- Pre-filled answers from ingested documents

The agent works through the schema adaptively, updating status as answers come in. When all Tier 1 fields are populated and Tier 2 has answers or accepted defaults, the engine signals discovery completion.

### 6.7. Planning Phase Engine Behavior

The Architect session receives `vision.md`, `architecture.md`, and the contract's team/role definitions. It has full authority to decompose and delegate.

The engine validates the planning output against the contract: every task has a valid owner, every task's scope fits its owner's boundaries, dependency ordering is consistent, verification methods are defined. If validation fails, the engine loops the Architect with specific error feedback.

### 6.8. Execution Phase Engine Behavior

For each role in the delegation order:

1. Swap to role's overlay and permissions
2. Record pre-session git state
3. Launch session — agent works against its assigned tasks
4. On completion: diff check, scope check, verification run, evidence capture
5. If valid: commit and proceed to next role
6. If invalid: reject, revert, feed back to session (within budget) or escalate

### 6.9. Technical Escalation

All technical issues from worker roles are handled by the Architect. The escalation path is:

1. Worker encounters a problem it cannot resolve within its scope/authority
2. Worker signals the issue (via the event protocol or by failing to meet completion criteria)
3. Engine tears down the worker session
4. Engine starts an Architect session with the problem context (the worker's partial diff, error output, the original task)
5. Architect resolves (by providing guidance, adjusting the task, or expanding scope with an exception)
6. Engine restarts the worker session with the Architect's resolution

The PO is only involved if the Architect determines the issue is a product decision (EXCEPTION gate).

---

## 7. Workspace & Sandbox Model

### 7.1. Worktree-Based Job Isolation (Sequential Execution)

All work happens one role at a time, but each job executes in a dedicated **git worktree** and job branch. This avoids disrupting the user's working directory (no branch switching, no resets/cleans in the user's worktree).

The execution sequence:

1. Engine records the user's current branch as `source_branch`
2. Engine creates a job branch at current HEAD (`nibbler/job-<id>` or `nibbler/fix-<id>`)
3. Engine creates a worktree for the job branch (one worktree per job)
4. Engine sets up `.nibbler/jobs/<id>/` folder structure (evidence, ledger, status) in the main repo directory
5. For each role in delegation order:
   - Swap rules overlay and permissions
   - Run session inside the job worktree
   - Verify and commit (or reject and loop)
6. If the job completes successfully, the engine merges the job branch back into `source_branch` **only if** the user's current branch still matches `source_branch` and the working tree is clean; then it removes the worktree and deletes the job branch (best-effort).
7. If the job fails (or merge is skipped/fails), the engine preserves the worktree + job branch for inspection/manual merge.

### 7.2. Scope Enforcement (Post-Hoc)

Since all roles share the same workspace, scope enforcement is based on diff analysis, not filesystem isolation:

**Before session:** Engine records current commit hash.

**During session:** The role works freely. Cursor permissions provide a soft boundary at the agent level.

**After session:** Engine diffs against the pre-session state. Every changed file path is checked against the role's declared scope. Out-of-scope changes trigger rejection: the engine reverts, provides feedback, and the session retries (within budget) or escalates.

### 7.3. What Persists Across Sessions

- The job worktree workspace (single directory per job, single job branch)
- All committed files from previous sessions
- Base cursor rules (`00-nibbler-protocol.mdc`, etc.)
- The `.nibbler/` job folder (evidence, ledger, plan artifacts)
- The contract files

### 7.4. What Swaps Between Sessions

- `.cursor/rules/20-role-<role>.mdc` — the role overlay
- Cursor CLI permissions config — the path/command allowlist
- The bootstrap prompt (minimal — rules carry the context)

### 7.5. Protected Paths

The engine enforces a set of paths that no agent session can modify, regardless of scope configuration:

- `.nibbler/` — ledger, evidence, job state, contract
- `.cursor/rules/00-nibbler-protocol.mdc` — base protocol rules
- `.git/` — git internals (including worktree metadata)
- Any path the engine uses for governance

These exclusions are meta-rule enforced (Rule 5.3) and cannot be overridden by the contract.

---

## 8. The Contract

### 8.1. What the Contract Is

The contract is the project-specific governance structure proposed by the Architect during `nibbler init` and validated against the constitutional meta-rules. It defines everything that the meta-rules leave abstract: role names, scope definitions, phase sequences, verification methods, gate placements, budget parameters, and artifact expectations.

### 8.2. What the Contract Defines

**Roles** — each declares:
- What it owns (scope — could be file paths, modules, or domains)
- What it can do (authority — commands, actions, decisions)
- What it must produce when given work (output expectations)
- How its work is verified (verification method — tests, review, lint, or any other deterministic check)
- Its budget parameters (iterations, time, diff size, or other limits)

**Phases** — each declares:
- Its preconditions (what must exist before it starts)
- Its actors (which roles participate)
- Its input and output boundaries (folder paths)
- Its completion criteria (deterministically verifiable)
- Its successor (what phase comes next, and under what conditions)

**Gates** — each declares:
- Its trigger condition (what state activates it)
- Its audience (PO, Architect, or specific role)
- Its required inputs (what the audience sees to decide)
- Its outcomes (approve → proceed to X, reject → loop to Y, exception → escalate to Z)

### 8.3. Contract Validation

At `nibbler init`, the engine validates the Architect's proposed contract against all 17 meta-rules:

- Every role has a declared scope (Rule 1.1)
- No undeclared scope overlaps (Rule 1.3)
- Every phase has input/output boundaries (Rule 2.1)
- Phase dependency graph is a DAG (Rule 3.3)
- Every phase has completion criteria (Rule 3.1)
- Every gate has defined outcomes for all resolutions (Rule 3.4)
- Every role has a budget (Rule 4.1)
- Budget exhaustion has an escalation path (Rule 4.2)
- A global job lifetime is defined (Rule 4.3)
- At least one PO gate exists (Rule 5.5)
- Protected paths are excluded from all scopes (Rule 5.3)

If validation fails, the engine returns specific errors to the Architect for correction. This loop is autonomous — the PO is not involved until the contract validates.

**Important note on “open Architect scope”:**
- Use `authority.allowedPaths: ["**/*"]` for broad Architect write access.
- Do **not** use `scope: ["**/*"]` (it will create undeclared overlaps with other roles and fail Rule 1.3 validation).
- Protected paths remain non-negotiable (Rule 5.3), even with broad `allowedPaths`.

### 8.4. Contract Evolution

The contract can be updated after initialization via `nibbler init --review`. This is useful when:

- The project has evolved (new components, new roles needed)
- Best practices have changed (different verification methods)
- The team has learned from previous jobs (tighter scopes, better budgets)

The Architect proposes changes; the engine re-validates; the PO confirms.

---

## 9. Init — The Bootstrap Problem

### 9.1. The Challenge

The Architect needs a context pack to produce the contract, but context packs are normally compiled from the contract. The init phase is the one place where Nibbler uses a **built-in bootstrap prompt** rather than a contract-derived one.

### 9.2. Init Flow

```
nibbler init
  │
  ├─ 1. Read project state
  │     ├─ Existing contract? (update mode)
  │     ├─ Existing vision.md / architecture.md? (discovery may be skipped)
  │     ├─ Existing codebase? (infer structure)
  │     └─ Classify: greenfield vs. existing
  │
  ├─ 2. Discovery (only if vision.md or architecture.md is missing)
  │     ├─ Ingest provided materials (`--file`, repeatable)
  │     ├─ Adaptive interview (agent emits QUESTIONS, PO answers via CLI prompts)
  │     ├─ Writes vision.md + architecture.md (preserving on-disk casing)
  │     └─ Artifact quality heuristics
  │           ├─ Sufficient → continue
  │           ├─ Insufficient → decision: rediscover | continue | abort
  │           └─ Optional: propose improvements and ask to apply them
  │
  ├─ 3. Start Architect session with bootstrap context
  │     ├─ Meta-rules (the constitution — what the contract must satisfy)
  │     ├─ Project context (codebase + vision.md + architecture.md)
  │     ├─ Example contracts (templates) + artifact-quality summary
  │     └─ Init mandate: "Propose a governance contract for this project"
  │
  ├─ 4. Architect proposes contract (iterative)
  │     ├─ Role definitions (team composition, scopes, authority, budgets)
  │     ├─ Phase definitions (workflow, transitions, completion criteria)
  │     ├─ Gate definitions (audience, inputs, outcomes)
  │     └─ Cursor session profiles (permissions per role)
  │
  ├─ 5. Engine validates against meta-rules (loop until valid or budget exhausted)
  │     ├─ Pass → present to PO for confirmation
  │     └─ Fail → loop Architect with specific errors
  │
  └─ 6. PO confirms → contract + profiles committed
        ├─ .nibbler/contract/* written to repo
        ├─ .nibbler/config/cursor-profiles/* written to repo
        ├─ .cursor/rules/00-nibbler-protocol.mdc written to repo
        └─ Ready for nibbler build
```

### 9.3. Init Outputs

Written into the target repository:

- `vision.md` — product vision (discovery output; created if missing)
- `architecture.md` — technical architecture (discovery output; created if missing)
- `.nibbler/contract/team.yaml` — role definitions, scopes, authority, budgets
- `.nibbler/contract/phases.yaml` — phase graph, transitions, gates, criteria
- `.nibbler/contract/project-profile.yaml` — scan/classification signals used during init
- `.cursor/rules/00-nibbler-protocol.mdc` — base protocol rules
- `.nibbler/config/cursor-profiles/<role>/cli-config.json` — per-role Cursor permissions profiles

The contract format is validated by the engine and enforced at runtime. Contract and profile files are committed; staging and per-job evidence are gitignored.

---

## 10. End-to-End Workflow

### 10.1. Happy Path

```
1. nibbler init
   │
   ├─ DISCOVERY (only if vision.md / architecture.md missing; unless --skip-discovery)
   │   → Ingest provided materials (--file ...)
   │   → Adaptive interview (questions via CLI prompts)
   │   → Write vision.md + architecture.md
   │   → Artifact quality heuristics (optional rediscover / improve / abort)
   │
   └─ CONTRACT
       → Architect proposes contract → engine validates → PO confirms
       → Contract + profiles committed to repo

2. nibbler build "requirement"
   │
   ├─ PRE-FLIGHT
   │   → Require clean working tree
   │   → Require .nibbler/contract + vision.md + architecture.md
   │   → Create job branch + worktree; init evidence + ledger
   │
   ├─ PLANNING
   │   → Architect session consumes vision.md + architecture.md + contract
   │   → Produces planning artifacts (acceptance, test plan, delegation, risk)
   │   → Engine validates delegation against contract
   │   → PO gate(s) as declared in the contract (commonly PLAN)
   │
   ├─ SCAFFOLD (if included by contract)
   │   → Architect session creates project boilerplate
   │   → Based on architecture.md as source of truth
   │   → Committed on branch before worker execution
   │
   ├─ EXECUTION (sequential, per delegation order)
   │   → For each role:
   │       → Swap rules + permissions
   │       → Run session
   │       → Verify: scope check + completion criteria + evidence
   │       → Commit
   │   → Architect review after each role (or as contract defines)
   │   → Technical issues → Architect resolves
   │   → Product issues → PO GATE: EXCEPTION
   │
   └─ SHIP
       → All verifications pass
       → Architect approves
       → PO GATE: SHIP
       → Recommended default: a docs-focused SHIP step updates `README.md` (install/quickstart/commands/etc.) and is checked deterministically (e.g., required headings + minimum length)
       → Output: branch with linear commit history + evidence + rollback notes
```

### 10.2. Clarification Routing

During any phase, agents may need additional context:

- **Architect → PO:** Questions during discovery or planning are presented to the PO directly and answers are persisted as durable artifacts.
- **Worker → Architect:** Questions during execution are routed to the Architect. The PO is not prompted for technical clarifications.
- **Architect → PO (exception):** If the Architect determines a worker's issue requires a product decision, it raises an EXCEPTION gate.

### 10.3. Failure & Recovery

**Worker fails within budget:** Engine loops the session with feedback (scope violation details, test failure output, etc.).

**Worker exhausts budget:** Engine escalates to Architect per contract's escalation path.

**Architect cannot resolve:** EXCEPTION gate raised to PO.

**Job exceeds global lifetime:** Hard termination with full evidence preservation.

**PO rejects a gate:** Engine follows the contract's recovery path (loop back, terminate, or modify scope).

---

## 11. CLI Interface

### 11.1. Commands

- **`nibbler init`** — Generate or review the project's governance contract.
  - `--file <path>` — Input document for discovery (repeatable).
  - `--review` — Re-evaluate and update an existing contract.
  - `--skip-discovery` — Skip discovery (requires existing vision.md + architecture.md).
  - `--dry-run` — Preview proposed contract changes without committing.

- **`nibbler build "<requirement>"`** — Run a full job: plan → execute → ship (as defined by the contract phase graph).
  - `--file <path>` — Accepted (repeatable). Currently reserved; discovery inputs are handled by `nibbler init --file`.
  - `--dry-run` — Print the contract-defined execution plan summary (no agent sessions run).
  - `--skip-scaffold` — Accepted. Currently a hint; scaffolding is controlled by the contract phases.

Build is the single entrypoint for job execution: on failure, the engine performs autonomous recovery (Architect-first) and prompts the user only as a last resort.

- **`nibbler fix [instructions]`** — Run a fix flow on top of an existing job.
  - Job selection is interactive by default, or explicit via `--job <id>`.
  - Fix instructions can be provided as a positional string, via `--file <path>`, or via prompt (interactive).
  - The fix flow runs as a new job (new worktree + branch) based on the selected job’s output, and merges back when safe.

- **`nibbler status [job-id]`** — Show current phase, active role, last events, progress.

- **`nibbler list`** — List active jobs.

- **`nibbler history`** — List completed jobs with outcomes.

- **`nibbler resume <job-id>`** — Reattach to a running or paused job.

### 11.2. PO Gate Interaction

Gates are presented in the CLI as interactive prompts. The PO sees:

- **Team context** (roles + scopes)
- **Transition/outcomes** (what approve/reject will do)
- **Acceptance criteria** (phase completion criteria, deterministically enforced)
- **Relevant artifacts** (required inputs with previews and a drill-down viewer)
- Clear options: approve, reject (with reason), or request changes

Gate responses are recorded in the ledger.

---

## 12. Architecture Components

### 12.1. Nibbler CLI

Entry point for all commands. Parses arguments, starts jobs, prints status, triggers PO gates, manages the orchestration lifecycle.

### 12.2. Job Manager

Creates per-job workspace state and logs. Tracks the current phase, active session, and budget consumption. Runs the main orchestration loop.

### 12.3. Plan Generator

Runs the Architect session during planning. Feeds the session with vision + architecture + contract. Validates the output (delegation, acceptance criteria, test plan) against the contract.

### 12.4. Policy Engine (Deterministic)

The core of Nibbler — enforces meta-rules and contract constraints. Responsibilities:

- Contract validation at init
- Scope verification (post-hoc diff checking) at every session boundary
- Completion criteria evaluation at every phase transition
- Gate enforcement
- Budget tracking and enforcement
- Protected path enforcement
- Evidence capture

### 12.5. Session Controller

Manages the Cursor Agent CLI lifecycle:

- Swaps `.cursor/rules/` overlays between sessions
- Swaps Cursor permissions config
- Launches and tears down Cursor agent sessions
- Sends bootstrap prompts
- Monitors session for events and completion signals

### 12.6. Evidence Collector

Captures all verification outputs:

- Git diffs (per session)
- Command outputs (test runs, linters, builds)
- Scope check results
- Budget consumption records

Stores in the job's evidence directory.

### 12.7. Gate UI

Presents gates to the PO via CLI prompts. Collects approvals with optional notes. Records gate resolutions in the ledger.

### 12.8. Ledger

Append-only record of all decisions, events, and state transitions. Each entry includes sequential ID, timestamp, event type, actor, and relevant data. Written exclusively by the engine.

---

## 13. File System Layout

### 13.1. Target Repository

```
.cursor/
  rules/
    00-nibbler-protocol.mdc       # base protocol (engine-managed)
    10-*.mdc                       # methodology rules (contract-defined)
    20-role-<role>.mdc             # role overlay (swapped per session)

.nibbler/
  contract/                        # governance contract (engine-protected)
    team.yaml                      # role definitions
    phases.yaml                    # phase graph
    ...                            # (format is contract-defined)
  jobs/
    <job-id>/
      plan/                        # planning artifacts
      evidence/                    # verification outputs
        sessions/                  # raw Cursor session logs (durable, per role/attempt)
      ledger.jsonl                 # append-only decision log
      status.json                  # current job state

vision.md                          # product vision (discovery output)
architecture.md                    # technical architecture (discovery output)
```

Exact file names and internal formats within `plan/` and other job folders are contract-defined, not prescribed by Nibbler.

### 13.2. Protected Paths (Meta-Rule Enforced)

These paths are excluded from all role scopes:

- `.nibbler/` — all governance infrastructure
- `.cursor/rules/00-nibbler-protocol.mdc` — base protocol
- Any path the engine uses for state management

---

## 14. Extensibility

### 14.1. Runner Adapter Interface

Nibbler defines an interface for execution backends, enabling future support for agents beyond Cursor:

- `spawn_session(role, workspace, env) → session_handle`
- `send(session_handle, input) → output/events`
- `stop(session_handle)`
- `capabilities()` — hooks support, structured output, permission model

### 14.2. Contract Extensibility

Since the contract is proposed by the Architect and validated against meta-rules (not a fixed schema), the system naturally extends to:

- New role types as engineering practices evolve
- New phases as workflows change
- New verification methods as tooling improves
- New project types with different question modules

### 14.3. Meta-Rule Versioning

Meta-rules change only through Nibbler version upgrades. When a new meta-rule is added, existing contracts are re-validated and the Architect is prompted to update if needed.

---

## 15. Security Model

### 15.1. Principles

- Never print secrets; redact sensitive data in logs and evidence.
- Restrict agent capabilities via Cursor permissions config per role.
- Avoid project-local security configuration that could be influenced by repository content.
- Per-session Cursor config sandboxing for permissions profiles.

### 15.2. Practical Controls

- Cursor permissions config swapped per role with minimal command allowlists.
- Protected paths enforced at the meta-rule level — no agent can modify governance infrastructure.
- Exception gate required for any permission expansion during execution.
- Evidence of all commands executed is captured for audit.

---

## 16. Open Design Decisions

To be resolved during implementation:

1. **Event protocol**: Strict JSON sentinel lines (`NIBBLER_EVENT {...}`) vs. hooks-based structured signals vs. hybrid. Depends on Cursor CLI reliability for each approach.
2. **Evidence normalization**: How to standardize verification outputs across different languages, test frameworks, and build tools.
3. **Default contract templates**: While the contract is Architect-proposed, shipping sensible defaults for common project types accelerates init. These are suggestions, not constraints.
4. **Session reliability**: Handling Cursor agent crashes, context window exhaustion, and unresponsive sessions. Retry strategy, evidence preservation on crash, and session health monitoring.
5. **Cost tracking**: Whether token/API cost is a budget dimension, and how to measure it through the Cursor CLI layer.

---
# Refs

- https://cursor.com/docs/context/rules?utm_source=chatgpt.com "Rules | Cursor Docs"
- https://cursor.com/docs/cli/reference/permissions?utm_source=chatgpt.com "Permissions | Cursor Docs"
- https://cursor.com/docs/cli/shell-mode?utm_source=chatgpt.com "Shell Mode | Cursor Docs"
- https://cursor.com/docs/agent/hooks?utm_source=chatgpt.com "Hooks | Cursor Docs"
- https://cursor.com/docs/cli/reference/output-format?utm_source=chatgpt.com "Output format | Cursor Docs"
- https://cursor.com/docs/cli/reference/configuration?utm_source=chatgpt.com "Configuration | Cursor Docs"
