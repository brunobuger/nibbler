# Architecture — Nibbler

*Technical architecture for a constitutional orchestration engine that drives sequential Cursor Agent CLI sessions with deterministic governance, scoped context injection, and artifact-driven phase transitions.*

---

## 0. Executive Summary

Nibbler is a **supervisor/orchestrator** implemented as a CLI application. It drives code changes by controlling **sequential Cursor Agent CLI sessions** (one active at a time, each representing a distinct engineering role) on a **single local git branch**. Between sessions, Nibbler swaps context (rules overlays and permissions) and verifies work through deterministic post-hoc checks (git diff analysis, command execution, artifact existence).

The system enforces **17 constitutional meta-rules** across five domains (Identity & Scope, Artifact Flow, Transitions & Gating, Budgets & Termination, Governance & Auditability). Everything else — role definitions, phase sequences, verification methods, artifact formats — is defined by a project-specific **contract** proposed by an Architect agent during initialization and validated against the constitution.

The architecture is intentionally **file-and-git centric**: the file system is the artifact registry, git history is the provenance record, and `.cursor/rules/` overlays are the sole context injection channel. Model memory is never trusted.

---

## 1. Architectural Principles

### 1.1. Constitutional Governance

Nibbler separates concerns into two layers:

**The Constitution (meta-rules)** — 17 invariant rules hardcoded in Nibbler's engine. They describe structural properties: every actor has a scope, every phase has completion criteria, every gate requires approval, every session has a budget. They are methodology-agnostic, schema-agnostic, and role-name-agnostic. They change only through Nibbler version upgrades.

**The Contract (project-specific)** — A governance structure proposed by the Architect agent during `nibbler init`. It defines the concrete roles, phases, gates, scopes, verification methods, and budgets for a specific project. The engine validates the contract against the constitution and enforces it at runtime.

This separation ensures the system is future-proof: if SDLC best practices change, the Architect proposes a different contract. Nibbler doesn't care what the methodology is — only that the structural invariants hold.

### 1.2. Deterministic Envelope, Non-Deterministic Interior

The engine is fully deterministic: phase transitions, scope checks, gate enforcement, budget tracking, evidence capture — all rule-based, no LLM judgment required. The agent sessions inside the envelope are non-deterministic (LLM-driven). The system achieves reliable outcomes by constraining the boundaries, not the interior.

### 1.3. File System as Registry

No metadata database. No artifact tracking index. The file system is the single source of truth for what exists. Cursor Agent CLI discovers context by scanning the workspace. Nibbler controls what the agent focuses on through `.cursor/rules/` overlays (instructions) and Cursor permissions config (access boundaries). If an artifact is in the workspace, Cursor can see it. If it's not, Cursor can't.

### 1.4. Post-Hoc Enforcement

Nibbler does not attempt to prevent scope violations or bad behavior during a session. Instead, it lets the agent work freely, then verifies the results after the session completes. Post-hoc enforcement via `git diff` analysis is simpler, more reliable, and more debuggable than pre-emptive filesystem isolation.

### 1.5. Sequential Execution, Worktree-Isolated Jobs

All work happens one role session at a time, but jobs run inside a dedicated **git worktree** on a job branch. This keeps the user's working directory and active branch stable during orchestration (no checkout/reset/clean in the user's worktree), while retaining the simplicity of sequential execution and post-hoc enforcement.

Each role commits directly to the job branch in the job worktree. On successful completion, Nibbler merges the job branch back into the user's original branch (only when safe) and cleans up the worktree; on failure, it preserves the worktree + branch for inspection/manual merge.

---

## 2. System Architecture

### 2.1. Component Overview

```
┌─────────────────────────────────────────────────────┐
│                    Nibbler CLI                       │
│              (entry point, argument parsing)         │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                   Job Manager                        │
│          (orchestration loop, phase state)            │
├──────────┬──────────┬──────────┬────────────────────┤
│          │          │          │                      │
▼          ▼          ▼          ▼                      ▼
┌────────┐┌────────┐┌────────┐┌──────────┐    ┌──────────────┐
│Policy  ││Session ││Evidence││Gate      │    │Contract      │
│Engine  ││Control-││Collec- ││Controller│    │Validator     │
│        ││ler     ││tor     ││          │    │              │
└───┬────┘└───┬────┘└───┬────┘└────┬─────┘    └──────────────┘
    │         │         │          │
    │         ▼         │          │
    │    ┌─────────┐    │          │
    │    │ Cursor   │    │          │
    │    │ Agent CLI│    │          │
    │    │ Session  │    │          │
    │    └─────────┘    │          │
    │                   │          │
    ▼                   ▼          ▼
┌─────────────────────────────────────────────────────┐
│              File System / Git Repository             │
│  .cursor/rules/  │  .nibbler/  │  workspace files     │
└─────────────────────────────────────────────────────┘
```

### 2.2. Component Responsibilities

**Nibbler CLI** — Entry point. Parses commands (`init`, `build`, `fix`, `status`, `list`, `history`, `resume`), initializes the Job Manager, handles top-level error reporting and signal handling.

**Job Manager** — The orchestration core. Maintains the job state machine, drives phase transitions, coordinates all other components. Owns the main loop: prepare session → launch session → collect evidence → verify → transition or loop.

**Policy Engine** — The constitutional enforcer. Implements all 17 meta-rules as deterministic checks. Two modes of operation: (1) contract validation at init time, (2) runtime enforcement at every session boundary and phase transition. Stateless — reads the contract and current state, returns pass/fail with evidence.

**Session Controller** — Manages the Cursor Agent CLI lifecycle. Handles the swap mechanism (rules overlay, permissions config), session spawning and teardown, bootstrap prompt delivery, and session health monitoring. Abstracts the Cursor CLI interaction behind a Runner Adapter Interface for future extensibility.

**Evidence Collector** — Captures all verification outputs: git diffs, command outputs (test runs, linters, builds), scope check results, budget consumption records. Writes to the job's evidence directory. Called by the Policy Engine after every verification.

**Gate Controller** — Presents gates to the PO via CLI prompts. Collects approval/rejection with optional notes. Records gate resolutions in the ledger. Enforces that only the declared audience can resolve a gate.

**Contract Validator** — Specialized component used during `nibbler init`. Takes an Architect-proposed contract and validates it against all 17 meta-rules. Returns specific errors for any violations, enabling the Architect to iterate.

---

## 3. The Contract System

### 3.1. Contract Structure

The contract is a set of files in `.nibbler/contract/` that define the project's governance structure. The internal format is proposed by the Architect and can vary between projects. The engine does not parse specific field names — it validates structural properties.

The contract must declare:

**Roles** — Each role definition must include:
- An identifier (role name)
- A scope declaration (what the role is allowed to affect — file path patterns, module boundaries, or other deterministically verifiable boundaries)
- Authority boundaries (what commands/actions the role can perform)
- Output expectations (what the role must produce when given work)
- A verification method (how the role's work is checked — must be deterministically executable by the engine)
- Budget parameters (limits on iterations, time, diff size, or other measurable quantities)

**Phases** — Each phase definition must include:
- An identifier (phase name)
- Preconditions (what must be true before the phase starts — expressed as artifact existence checks, state conditions, or prior phase completion)
- Participating roles (which roles are active during this phase)
- Input boundaries (folder paths or patterns the phase reads from)
- Output boundaries (folder paths or patterns the phase writes to)
- Completion criteria (deterministically verifiable conditions that must be met for the phase to complete)
- Successor mapping (what phase comes next, potentially conditional on outcomes)

**Gates** — Each gate definition must include:
- A trigger condition (what state or transition activates the gate)
- An audience (who must approve — PO, Architect, or a specific role)
- Required inputs (what artifacts/summaries the audience needs to make a decision)
- Outcome mapping (approve → proceed to X, reject → loop to Y, with at least approve and reject defined)

**Global parameters** — The contract must declare:
- A global job lifetime budget
- An escalation chain (what happens when a worker can't resolve an issue)
- Shared scope declarations (paths where multiple roles' scopes overlap)

**Effective write set (runtime):**
At runtime, Nibbler treats a role’s writable surface as:
- `role.scope` (owned paths)
- `sharedScopes` (explicitly declared overlaps)
- `role.authority.allowedPaths` (extra write access; commonly used for “open Architect scope”)
…minus engine-protected paths (see Section 10.2).

### 3.2. Contract Validation Algorithm

The Contract Validator checks the proposed contract against all 17 meta-rules. The algorithm:

```
function validate_contract(contract):
    errors = []

    // Domain 1 — Identity & Scope
    for role in contract.roles:
        if role has no scope declaration:
            errors.append("Rule 1.1: Role '{role.id}' has no scope")
        if role has no budget parameters:
            errors.append("Rule 4.1: Role '{role.id}' has no budget")
        if role has no verification method:
            errors.append("Rule 3.1: Role '{role.id}' has no verification method")

    // Scope overlap detection (Rule 1.3)
    for each pair (role_a, role_b) in contract.roles:
        overlap = compute_scope_intersection(role_a.scope, role_b.scope)
        if overlap is not empty:
            if overlap not declared in contract.shared_scopes:
                errors.append("Rule 1.3: Undeclared overlap between
                    '{role_a.id}' and '{role_b.id}' on paths: {overlap}")

    // Protected paths (Rule 5.3)
    protected = [".nibbler/", ".cursor/rules/00-nibbler-protocol.mdc"]
    for role in contract.roles:
        for path in protected:
            if role.scope includes path:
                errors.append("Rule 5.3: Role '{role.id}' scope
                    includes protected path '{path}'")

    // Domain 2 — Artifact Flow
    for phase in contract.phases:
        if phase has no input boundaries:
            errors.append("Rule 2.1: Phase '{phase.id}' has no input boundaries")
        if phase has no output boundaries:
            errors.append("Rule 2.1: Phase '{phase.id}' has no output boundaries")

    // Dependency satisfaction (Rule 2.2)
    for phase in contract.phases:
        for input_path in phase.input_boundaries:
            upstream = find_phase_that_outputs(input_path, contract)
            if upstream is none and input_path is not pre-existing:
                errors.append("Rule 2.2: Phase '{phase.id}' requires
                    input '{input_path}' but no upstream phase produces it")

    // Domain 3 — Transitions & Gating
    for phase in contract.phases:
        if phase has no completion criteria:
            errors.append("Rule 3.1: Phase '{phase.id}' has no completion criteria")
        if phase has no successor and phase is not terminal:
            errors.append("Rule 3.3: Phase '{phase.id}' has no successor
                and is not marked terminal")

    // DAG check (Rule 3.3)
    if phase_graph_has_cycle(contract.phases):
        errors.append("Rule 3.3: Phase graph contains a cycle")

    if not phase_graph_has_terminal(contract.phases):
        errors.append("Rule 3.3: Phase graph has no reachable terminal state")

    // Gate completeness (Rule 3.4)
    for gate in contract.gates:
        if gate has no reject outcome:
            errors.append("Rule 3.4: Gate '{gate.id}' has no reject outcome")
        if gate has no approve outcome:
            errors.append("Rule 3.4: Gate '{gate.id}' has no approve outcome")

    // PO gate existence (Rule 5.5)
    po_gates = [g for g in contract.gates where g.audience == "PO"]
    if po_gates is empty:
        errors.append("Rule 5.5: Contract has no PO gates")

    // Domain 4 — Budgets & Termination
    if contract has no global_lifetime:
        errors.append("Rule 4.3: No global job lifetime defined")

    for role in contract.roles:
        if role.budget has no exhaustion_escalation:
            errors.append("Rule 4.2: Role '{role.id}' budget has
                no escalation path on exhaustion")

    return errors
```

If `errors` is empty, the contract is valid. If not, the errors are fed back to the Architect session for correction.

### 3.3. Contract Storage

The validated contract is written to `.nibbler/contract/` in the target repository. The specific files and formats within that directory are Architect-determined. The engine reads the contract through a **Contract Reader** abstraction that can parse whatever format the Architect chose, as long as it can extract the required structural elements (roles, phases, gates, scopes, budgets).

In practice, the initial implementation may standardize on YAML for contract files, with the understanding that this is a convenience default, not a constitutional requirement.

---

## 4. The Context Engine

### 4.1. Design Philosophy

The context engine is the intelligence core. Its job: for any given session, determine what context the agent receives, what it must produce, and how its work is verified.

The engine operates on one principle: **context injection happens through the file system and `.cursor/rules/` overlays, not through conversation history or memory.** Agents share artifacts, not conversations. The workspace is continuous; the rules overlay is the only thing that changes.

### 4.2. Three-Layer Context Model

Every agent session receives context assembled from three layers:

**Layer 1 — Identity.** Who the agent is. Comes from the contract's role definition. Stable across jobs for the same project. Contains: role name, responsibilities, scope boundaries, authority limits, output expectations, behavioral guidance.

**Layer 2 — Mission.** What the agent is doing right now. Comes from the planning artifacts (delegation, task packets, acceptance criteria). Job-specific and task-specific. Contains: assigned tasks, relevant acceptance criteria, dependencies, current workflow phase.

**Layer 3 — World.** What the agent needs to know about the broader project. Curated guidance on which files and folders to read for context. Always references the product vision and technical architecture. May reference upstream outputs (test files, handoff artifacts, review notes). Since all sessions share one workspace, the agent can see everything — Layer 3 controls *focus*, not *visibility*.

### 4.3. Materialization

All three layers are materialized into a single file: **`.cursor/rules/20-role-<role>.mdc`**. This is the role overlay rule — the primary context injection artifact. Cursor reads it automatically when the session starts.

The overlay is a markdown-like file (`.mdc` format per Cursor conventions) that contains structured natural language. It tells the agent:

- Who it is and what its boundaries are (Layer 1)
- What tasks it's working on and what success looks like (Layer 2)
- What files to read for context and what to focus on (Layer 3)

The engine generates this file dynamically for each session based on the contract, the current phase, and the planning artifacts.

### 4.4. Context Compilation Algorithm

```
function compile_context(role, phase, job_state, contract):
    // Layer 1 — Identity
    role_def = contract.get_role(role)
    identity = {
        name: role_def.id,
        scope: role_def.scope,
        authority: role_def.authority,
        outputs_expected: role_def.output_expectations,
        verification: role_def.verification_method,
        behavioral_rules: role_def.behavioral_guidance
    }

    // Layer 2 — Mission
    tasks = job_state.get_tasks_for_role(role)
    phase_def = contract.get_phase(phase)
    mission = {
        assigned_tasks: tasks,
        acceptance_criteria: extract_relevant_criteria(tasks, job_state),
        dependencies: extract_dependencies(tasks, job_state),
        current_phase: phase,
        completion_signal: phase_def.completion_criteria
    }

    // Layer 3 — World
    world = {
        always_read: ["vision.md", "architecture.md"],
        phase_inputs: phase_def.input_boundaries,
        upstream_outputs: get_completed_outputs(phase, job_state),
        focus_guidance: generate_focus_hints(role, tasks, contract)
    }

    // Generate the .mdc overlay
    overlay = render_overlay_template(identity, mission, world)
    write_file(".cursor/rules/20-role-{role}.mdc", overlay)
```

### 4.5. The Swap Mechanism

Between sessions, exactly three things change in the workspace:

**1. Role overlay** — `.cursor/rules/20-role-<role>.mdc` is deleted and rewritten for the new role. This is the primary context injection channel. All three layers of context are encoded here.

**2. Cursor permissions config** — The CLI permissions file is rewritten to reflect the new role's command allowlist and path restrictions. This provides a soft boundary at the Cursor agent level. Location depends on Cursor CLI configuration — typically controlled via `CURSOR_CONFIG_DIR` environment variable.

**3. Bootstrap prompt** — The first message sent to the new session. Can be minimal ("Begin your assigned work as described in the project rules.") since the rules overlay carries the full context.

Everything else persists across sessions: the workspace directory, the branch, all committed files from previous sessions, base cursor rules (`00-nibbler-protocol.mdc`, `10-*.mdc`), and the `.nibbler/` governance folder.

### 4.6. Swap Sequence

```
function swap_session(from_role, to_role, job, contract):
    // 1. Tear down current session
    session_controller.stop_session(from_role)

    // 2. Verify outgoing role's work (Policy Engine)
    pre_commit = job.last_commit_hash
    diff = git_diff(pre_commit, "HEAD")
    scope_result = policy_engine.verify_scope(diff, contract.get_role(from_role))
    completion_result = policy_engine.verify_completion(from_role, job, contract)

    // 3. Capture evidence
    evidence_collector.record_diff(job, from_role, diff)
    evidence_collector.record_verification(job, from_role, scope_result)
    evidence_collector.record_verification(job, from_role, completion_result)

    // 4. Handle verification failure
    if not scope_result.passed or not completion_result.passed:
        handle_verification_failure(from_role, job, contract, scope_result, completion_result)
        return  // may retry, escalate, or abort

    // 5. Commit the role's work
    git_commit(message="[nibbler:{job.id}] {from_role} phase complete")
    job.last_commit_hash = current_commit()

    // 6. Swap context for incoming role
    compile_context(to_role, job.current_phase, job, contract)
    write_permissions_config(to_role, contract)

    // 7. Launch new session
    session_controller.start_session(to_role, job.workspace)
    send_bootstrap_prompt(to_role)
```

---

## 5. Session Controller

### 5.1. Cursor Agent CLI Interaction Model

The Session Controller manages Cursor Agent CLI processes. Each session is a single interactive Cursor agent process running in the target workspace.

**Session lifecycle:**
1. **Spawn** — Start a Cursor CLI agent process in the workspace with the appropriate environment (`CURSOR_CONFIG_DIR` set for the role's permissions profile).
2. **Bootstrap** — Send the initial prompt that triggers the agent to begin work. The prompt is minimal because the rules overlay already contains full context.
3. **Monitor** — Watch for session output, event signals, completion signals, errors, and health indicators.
4. **Teardown** — Stop the session cleanly. Capture any final output. Ensure the workspace is in a consistent state.

### 5.2. Event Protocol

Agent sessions communicate structured events back to Nibbler. The recommended protocol is a single-line JSON sentinel:

```
NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"..."}
NIBBLER_EVENT {"type":"NEEDS_ESCALATION","reason":"...","context":"..."}
NIBBLER_EVENT {"type":"EXCEPTION","reason":"...","impact":"..."}
```

The Session Controller monitors session output for lines matching the `NIBBLER_EVENT` prefix, parses the JSON payload, and routes events to the Job Manager.

The event protocol is defined in `.cursor/rules/00-nibbler-protocol.mdc` and is part of every session's context. The contract can extend the event types but cannot remove the base set required by the engine.

**Fallback:** If the agent fails to emit structured events (LLM non-compliance), the Session Controller falls back to timeout-based completion detection and manual state assessment by the engine.

### 5.3. Runner Adapter Interface

The Session Controller wraps Cursor CLI behind an abstraction for future extensibility:

```
interface RunnerAdapter:
    spawn(workspace_path, env_vars, config_dir) → SessionHandle
    send(handle, message) → void
    read_events(handle) → stream of Event
    is_alive(handle) → boolean
    stop(handle) → void
    capabilities() → { hooks: bool, structured_output: bool, permissions: bool }
```

The initial implementation targets Cursor Agent CLI only. Future adapters could wrap Claude Code, Aider, or other coding agent CLIs.

### 5.4. Session Health Monitoring

The Session Controller monitors:

- **Process liveness** — Is the Cursor CLI process still running?
- **Activity** — Has the session produced output recently? (Detects hangs.)
- **Budget consumption** — Has the session exceeded its iteration, time, or diff budget?
- **Event signals** — Has the session emitted a completion or escalation event?

Health check failures trigger the engine's escalation path as defined in the contract.

---

## 6. Policy Engine

### 6.1. Responsibilities

The Policy Engine is the constitutional enforcer. It implements all 17 meta-rules as deterministic check functions. It has two modes:

**Init-time validation** — Validates the contract against all meta-rules. Called by the Contract Validator during `nibbler init`.

**Runtime enforcement** — Called at every session boundary, phase transition, and gate. Verifies scope compliance, completion criteria, budget limits, protected paths, and evidence capture requirements.

### 6.2. Scope Verification

The primary runtime check. After every session:

```
function verify_scope(diff, role_def):
    violations = []
    for file in diff.changed_files:
        if not role_def.scope.matches(file.path):
            // Check shared scopes
            if not contract.shared_scopes.matches(file.path):
                violations.append({
                    file: file.path,
                    role: role_def.id,
                    allowed: role_def.scope.patterns,
                    action: file.change_type  // added, modified, deleted
                })

    // Check protected paths (meta-rule override)
    for file in diff.changed_files:
        if is_protected_path(file.path):
            violations.append({
                file: file.path,
                role: role_def.id,
                reason: "protected path (meta-rule 5.3)"
            })

    return ScopeResult(
        passed: violations is empty,
        violations: violations,
        diff_summary: diff.summary,
        checked_at: now()
    )
```

### 6.3. Completion Criteria Evaluation

Each phase has contract-defined completion criteria. The Policy Engine evaluates them:

```
function verify_completion(role, job, contract):
    phase = contract.get_phase(job.current_phase)
    results = []

    for criterion in phase.completion_criteria:
        result = evaluate_criterion(criterion, job)
        results.append(result)

    return CompletionResult(
        passed: all(r.passed for r in results),
        criteria_results: results,
        checked_at: now()
    )
```

**Criterion types the engine can evaluate:**
- `artifact_exists(path_pattern)` — Check that files matching the pattern exist in the workspace.
- `command_succeeds(command)` — Execute a command and check exit code 0.
- `command_fails(command)` — Execute a command and check non-zero exit code (useful for TDD red phase).
- `diff_non_empty()` — Verify the session actually produced changes.
- `diff_within_budget(max_files, max_lines)` — Verify diff size within limits.
- `custom(script)` — Run a custom verification script provided by the contract.

The specific criterion types available are extensible — the contract can reference any type the engine supports. The initial implementation covers the types listed above.

### 6.4. Budget Enforcement

The Policy Engine tracks budget consumption per session:

```
function check_budget(session, role_def):
    budget = role_def.budget
    usage = session.get_usage()

    exceeded = {}
    if budget.max_iterations and usage.iterations > budget.max_iterations:
        exceeded["iterations"] = { limit: budget.max_iterations, actual: usage.iterations }
    if budget.max_time and usage.elapsed > budget.max_time:
        exceeded["time"] = { limit: budget.max_time, actual: usage.elapsed }
    if budget.max_diff_lines and usage.diff_lines > budget.max_diff_lines:
        exceeded["diff_lines"] = { limit: budget.max_diff_lines, actual: usage.diff_lines }

    if exceeded:
        return BudgetResult(
            passed: false,
            exceeded: exceeded,
            escalation: role_def.budget.exhaustion_escalation
        )

    return BudgetResult(passed: true)
```

### 6.5. Gate Enforcement

Gates cannot be bypassed. When the Job Manager reaches a gate-bearing transition:

```
function enforce_gate(gate_def, job):
    // Prepare gate inputs
    inputs = collect_gate_inputs(gate_def, job)

    // Compute a deterministic fingerprint for this gate state.
    // For planning-origin gates, include a digest of `.nibbler/jobs/<id>/plan/**`
    // so plan edits force re-approval.
    fp = compute_gate_fingerprint(gate_def, job, inputs)

    // Dedupe: if the most recent gate_resolved for this gate was APPROVE and fp matches,
    // auto-apply approval without prompting again (recovery/resume).
    last = ledger.last_gate_resolved(gate_def.id)
    if last.decision == "approve" and last.fingerprint == fp:
        return gate_def.outcomes["approve"]

    // Present to audience
    resolution = gate_controller.present_gate(
        gate: gate_def,
        inputs: inputs,
        audience: gate_def.audience
    )

    // Record in ledger
    ledger.append({
        type: "gate_resolved",
        gate: gate_def.id,
        audience: gate_def.audience,
        resolution: resolution.decision,  // approve | reject
        notes: resolution.notes,
        fingerprint: fp,
        timestamp: now()
    })

    // Follow outcome mapping
    return gate_def.outcomes[resolution.decision]
```

---

## 7. Job Manager — The Orchestration Loop

### 7.1. Job Lifecycle

A job is the unit of work in Nibbler. It represents a single `nibbler build` invocation and tracks all state required to execute the **contract-defined phase graph** (typically planning → execution → ship) inside a dedicated worktree.

Discovery artifacts (`vision.md`, `architecture.md`) are produced during `nibbler init` (unless they already exist) and are **prerequisites** for `nibbler build` in the current implementation.

**Job states:**
- `created` — Job initialized (id allocated, branch/worktree prepared, ledger opened)
- `executing` — Orchestration is running (role sessions + deterministic verification)
- `paused` — Waiting on a gate resolution (`pendingGateId` set)
- `completed` — Terminal phase reached and any terminal gate resolved
- `failed` — Job terminated due to unrecoverable error
- `cancelled` — Job cancelled by PO
- `budget_exceeded` — Job terminated by global lifetime budget

Phase semantics (planning/scaffold/execution/ship, etc.) are tracked via `currentPhaseId` (contract phase id) and `currentRoleId` (active actor). Gate waiting is represented by `state="paused"` plus `pendingGateId`.

### 7.2. The Main Loop

```
function run_job(job):
    try:
        // Contract-driven execution (phases + gates + criteria)
        start_phase = find_start_phase(contract)
        job.set_state("executing")
        phase_id = start_phase

        while true:
            phase = contract.get_phase(phase_id)

            // Run each actor in the phase (sequentially).
            // (If delegation is present, execution may be ordered by the delegation plan.)
            for role_id in phase.actors:
                outcome = run_role_session(role_id, job)
                if outcome != "ok":
                    finalize(job, outcome)
                    return

            // Terminal phase: optional terminal gate at `${phase_id}->__END__`
            if phase.is_terminal or phase.successors.is_empty:
                maybe_enforce_gate(f"{phase_id}->__END__", job)
                job.set_state("completed")
                return

            // Default successor selection: prefer `on=done`, else first successor
            next_id = select_successor(phase)
            transition = f"{phase_id}->{next_id}"

            // Gate enforcement (contract-defined)
            gate_def = contract.gate_for_trigger(transition)
            if gate_def:
                job.set_state("paused")
                job.pending_gate_id = gate_def.id
                mapped = enforce_gate(gate_def, job)   // returns next phase id (or __END__)
                job.set_state("executing")
                job.pending_gate_id = null
                phase_id = mapped
                continue

            phase_id = next_id

    except BudgetExceededException:
        job.set_state("budget_exceeded")
        evidence_collector.capture_final_state(job)
    except Exception as e:
        job.set_state("failed")
        evidence_collector.capture_final_state(job)
        raise
```

### 7.3. Role Session Execution

The innermost loop — running a single role's session:

```
function run_role_session(role_task_group, job):
    role = role_task_group.role
    role_def = contract.get_role(role)
    retry_count = 0

    while retry_count < role_def.budget.max_iterations:
        // Record pre-session state
        pre_session_commit = git_current_commit()

        // Compile and inject context
        compile_context(role, job.current_phase, job, contract)
        write_permissions_config(role, contract)

        // Launch session
        handle = session_controller.spawn(job.workspace, role_env(role))
        session_controller.send(handle, bootstrap_prompt(role))

        // Monitor until completion or budget
        wait_for_session_completion(handle, role_def.budget)

        // Tear down
        session_controller.stop(handle)

        // Verify
        diff = git_diff(pre_session_commit)
        scope_result = policy_engine.verify_scope(diff, role_def)
        completion_result = policy_engine.verify_completion(role, job, contract)

        // Capture evidence
        evidence_collector.record(job, role, diff, scope_result, completion_result)

        if scope_result.passed and completion_result.passed:
            // Success — commit and return
            git_commit("[nibbler:{job.id}] {role} complete")
            ledger.append({ type: "role_complete", role: role, timestamp: now() })
            return

        // Failure — handle based on failure type
        retry_count += 1
        if scope_result.has_violations:
            // Revert out-of-scope changes, provide feedback
            git_revert_to(pre_session_commit)
            job.add_feedback(role, "scope_violation", scope_result.violations)
        else:
            // Completion criteria not met — provide feedback
            git_revert_to(pre_session_commit)
            job.add_feedback(role, "incomplete", completion_result.failures)

    // Budget exhausted — escalate
    escalate(role, job, role_def.budget.exhaustion_escalation)
```

### 7.4. Escalation Handling

```
function escalate(role, job, escalation_path):
    ledger.append({ type: "escalation", role: role, reason: "budget_exhausted", timestamp: now() })

    if escalation_path == "architect":
        // Start Architect session with problem context
        run_architect_resolution(role, job)
    elif escalation_path == "exception_gate":
        // Raise EXCEPTION gate to PO
        outcome = enforce_gate("exception", job)
        follow_recovery_path("exception", outcome, job)
    elif escalation_path == "terminate":
        // Record and terminate the role's contribution
        ledger.append({ type: "role_terminated", role: role, timestamp: now() })
```

### 7.5. Architect Resolution

When a worker role escalates to the Architect:

```
function run_architect_resolution(failed_role, job):
    // Compile context with problem information
    problem_context = {
        role: failed_role,
        last_diff: job.get_last_diff(failed_role),
        failures: job.get_feedback(failed_role),
        tasks: job.get_tasks_for_role(failed_role),
        evidence: evidence_collector.get_latest(job, failed_role)
    }

    // Swap to Architect with resolution mandate
    compile_context("architect", "resolution", job, contract,
        extra_context=problem_context)
    write_permissions_config("architect", contract)

    handle = session_controller.spawn(job.workspace, role_env("architect"))
    session_controller.send(handle, resolution_prompt(failed_role, problem_context))

    wait_for_session_completion(handle, architect_budget)
    session_controller.stop(handle)

    // Architect may:
    // - Adjust task definitions
    // - Provide implementation guidance
    // - Expand scope (requires EXCEPTION gate)
    // - Mark tasks as blocked
    // The resolution is captured as artifacts that feed back into
    // the failed role's next attempt
```

---

## 8. Discovery Engine

### 8.1. Architecture

The Discovery Engine is a specialized subsystem that handles the product vision extraction flow. It runs an Architect session in "discovery mode" with a structured question schema injected as context.

### 8.2. Question Schema Design

The question schema is a structured data file that the engine generates based on the project type. It contains:

```
discovery_schema:
  project_type: <classified type>

  tiers:
    tier_1:
      sections:
        - id: problem_context
          status: gap | inferred | confirmed | answered
          questions:
            - id: <unique_id>
              ask: <question text>
              status: gap | inferred | confirmed | answered
              inferred_answer: <if inferred from documents>
              confidence: low | medium | high
              answer: <PO's answer, once provided>
          propose_default: <if applicable>

        - id: solution_concept
          ...

    tier_2:
      sections:
        ...

    tier_3:
      sections:
        ...

  type_module:
    additional_questions:
      - id: <unique_id>
        tier: 1 | 2 | 3
        section: <parent section>
        ask: <question text>
        ...
```

### 8.3. Document Ingestion

Before the interview begins, the engine ingests all provided materials:

```
function ingest_materials(provided_files, existing_repo):
    context = {}

    // Read provided files
    for file in provided_files:
        context[file.name] = extract_content(file)

    // Read existing repo artifacts
    if exists("vision.md"):
        context["existing_vision"] = read("vision.md")
    if exists("architecture.md"):
        context["existing_architecture"] = read("architecture.md")

    // Scan codebase if it exists
    if repo_has_code(existing_repo):
        context["codebase_summary"] = scan_codebase(existing_repo)

    // Classify repo state
    context["repo_state"] = classify_repo(existing_repo)
    // → "empty" | "docs_only" | "has_code"

    return context
```

### 8.4. Discovery Session Flow (init-time)

```
function run_discovery(repo_root, provided_files, force=false):
    // Ingest
    context = ingest_materials(provided_files, repo_root)

    // Classify project type (may require a quick agent query)
    project_type = classify_or_ask_project_type(context)

    // Generate question schema
    schema = generate_discovery_schema(project_type, context)

    // Pre-fill from ingested materials
    pre_fill_schema(schema, context)

    // Compile discovery context
    // The Architect gets: meta-rules, the schema, ingested materials
    compile_discovery_context(schema, context)

    // Run Architect session in discovery mode
    // The session interactively asks the PO questions
    // The engine mediates: agent proposes questions → engine presents to PO
    //   → PO answers → engine feeds answer back to agent
    run_interactive_discovery_session(repo_root, schema)

    // Synthesize outputs
    // The Architect session produces vision.md and architecture.md
    // (generated or reconciled with existing)

    // Verify discovery outputs exist
    assert exists("vision.md"), "Discovery must produce vision.md"
    assert exists("architecture.md"), "Discovery must produce architecture.md"

    // Note: in the current implementation, discovery runs during `nibbler init`.
    // The resulting docs are committed alongside the contract when init completes.
```

### 8.5. architecture.md Generation and Reconciliation

The discovery phase handles three scenarios for `architecture.md`:

**Greenfield (no existing file):**
1. Architect proposes architecture derived from `vision.md` — stack, structure, deployment, key decisions
2. Each proposal includes rationale and alternatives
3. PO accepts or overrides each major decision
4. Result committed as `architecture.md`

**Existing docs, remediation (via `nibbler init` rediscovery):**
1. Architect reads existing `architecture.md` and `vision.md`
2. Flags conflicts, gaps, and over-specification
3. Proposes updates
4. Updated `architecture.md` written (and committed as part of init)

**Existing repo with code:**
1. Architect reads `architecture.md`, `vision.md`, *and* scans actual codebase
2. Reconciles documentation with implementation reality
3. Updates `architecture.md` to reflect both truth and new requirements

---

## 9. Workspace & Git Model

### 9.1. Branch Strategy

```
source_branch (user's current branch)
  ├── (unchanged during job execution)
  └── merge-back (on success, when safe)
        ▲
        │
        └── nibbler/job-<id>                       ← work happens here (in a worktree)
              ├── commit: <role1> complete
              ├── commit: <role2> complete
              └── (linear history, one commit per role completion)
```

The job branch is created at job start (at current HEAD) and contains a linear history. Each role's verified work is a single commit (or a squashed set if the role required multiple iterations).

Jobs run in a dedicated worktree located next to the repo (stable + discoverable):

`<repoParent>/.nibbler-wt-<repoBasename>/<jobId>/`

Engine state and evidence stay under the main repo root in `.nibbler/jobs/<id>/...` (gitignored), while code changes happen in the worktree.

**Worktree health (robustness):**
Git worktrees rely on metadata under `.git/worktrees/**`. If that metadata is missing/corrupted (e.g. due to external cleanup), git commands inside the worktree can fail with “not a git repository”. The Job Manager performs a best-effort **worktree health check and repair** before critical git operations (diff/finalize) so jobs fail less often and retries don’t cascade.

### 9.2. Pre-Session / Post-Session State

**Pre-session snapshot:**
```
function record_pre_session(job, role):
    job.pre_session_commit = git_current_commit()
    job.pre_session_timestamp = now()
    ledger.append({
        type: "session_start",
        role: role,
        commit: job.pre_session_commit,
        timestamp: now()
    })
```

**Post-session verification:**
```
function verify_post_session(job, role):
    diff = git_diff(job.pre_session_commit)

    // Scope check
    scope_ok = policy_engine.verify_scope(diff, contract.get_role(role))

    // Completion check
    completion_ok = policy_engine.verify_completion(role, job, contract)

    // Evidence capture
    evidence_collector.record_diff(job, role, diff)
    evidence_collector.record_scope_check(job, role, scope_ok)
    evidence_collector.record_completion_check(job, role, completion_ok)

    // Run contract-defined verification commands
    for check in contract.get_role(role).verification_commands:
        result = execute_command(check.command)
        evidence_collector.record_command(job, role, check, result)

    return scope_ok.passed and completion_ok.passed
```

### 9.3. Revert on Failure

When a session fails verification:

```
function revert_session(job, role, pre_session_commit):
    // Hard reset to pre-session state
    git_reset_hard(pre_session_commit)

    // Clean any untracked files the session created outside scope
    git_clean()

    ledger.append({
        type: "session_reverted",
        role: role,
        reverted_to: pre_session_commit,
        timestamp: now()
    })
```

---

## 10. File System Layout

### 10.1. Target Repository Layout

```
<repo root>/
├── .cursor/
│   ├── rules/
│   │   ├── 00-nibbler-protocol.mdc    # Base protocol (engine-managed, protected)
│   │   ├── 10-*.mdc                    # Methodology rules (contract-defined)
│   │   └── 20-role-<role>.mdc          # Role overlay (swapped per session)
│   └── hooks.json                       # Optional, contract-managed
│
├── .nibbler/                             # All engine state (protected path)
│   ├── contract/                         # Governance contract
│   │   ├── team.yaml                    # Role definitions (format is contract-defined)
│   │   ├── phases.yaml                  # Phase graph (format is contract-defined)
│   │   └── ...                          # Additional contract files
│   │
│   ├── jobs/
│   │   └── <job-id>/
│   │       ├── plan/                    # Planning artifacts (format is contract-defined)
│   │       ├── evidence/                # All verification outputs
│   │       │   ├── diffs/              # Git diffs per session
│   │       │   ├── checks/             # Scope & completion check results
│   │       │   ├── commands/           # Verification command outputs
│   │       │   └── gates/              # Gate presentation & resolution records
│   │       ├── ledger.jsonl             # Append-only decision log
│   │       └── status.json              # Current job state
│   │
│   └── config/                           # Engine configuration
│       └── cursor-profiles/             # Per-role Cursor permission configs
│           ├── architect/
│           │   └── cli-config.json
│           ├── backend/
│           │   └── cli-config.json
│           └── .../
│
├── vision.md                             # Product vision (discovery output)
├── architecture.md                       # Technical architecture (discovery output)
│
└── <project source code>                 # Managed by worker roles
```

### 10.2. Protected Paths

The following paths are excluded from all role scopes as a meta-rule (5.3) enforcement. No agent session can modify them regardless of contract configuration:

- `.nibbler/**` — All engine state, ledger, evidence, contract
- `.cursor/rules/00-nibbler-protocol.mdc` — Base protocol rules
- `.git/**` — Git internals (including worktree metadata)

The engine verifies this exclusion both at contract validation time (rejecting any scope that includes these paths) and at runtime (checking post-session diffs for protected path modifications).

### 10.3. Cursor Permissions Sandboxing

Each role has a pre-generated Cursor CLI config stored at `.nibbler/config/cursor-profiles/<role>/cli-config.json`. When launching a session for a role, the Session Controller sets:

```
CURSOR_CONFIG_DIR=<repo>/.nibbler/config/cursor-profiles/<role>/
```

This ensures the Cursor agent process reads the role-specific permissions (command allowlist, path restrictions) without modifying the user's global Cursor configuration.

The profiles are generated during `nibbler init` based on the contract's role definitions and regenerated whenever the contract is updated.

---

## 11. Ledger Design

### 11.1. Format

The ledger is a JSON Lines (`.jsonl`) file. Each line is a self-contained JSON object representing one event. The ledger is append-only (meta-rule 5.2).

### 11.2. Entry Structure

Every entry contains a common envelope:

```json
{
    "seq": 1,
    "timestamp": "2025-01-15T10:30:00Z",
    "type": "<event_type>",
    "data": { ... }
}
```

`seq` is a monotonically increasing integer. Gaps in the sequence indicate corruption.

### 11.3. Event Types

**Job lifecycle:**
- `job_created` — Job initialized with parameters
- `job_completed` — Job finished successfully
- `job_failed` — Job terminated due to error
- `job_cancelled` — Job cancelled by PO
- `job_budget_exceeded` — Job terminated by global budget

**Phase transitions:**
- `phase_started` — A phase began
- `phase_completed` — A phase completed with all criteria met

**Session events:**
- `session_start` — Role session launched (role, commit hash)
- `session_complete` — Role session finished
- `session_reverted` — Role session's changes were reverted
- `session_escalated` — Role session escalated (to architect or exception gate)

**Verification events:**
- `scope_check` — Scope verification result (passed/failed, details)
- `completion_check` — Completion criteria result
- `command_executed` — Verification command result (command, exit code, output path)

**Gate events:**
- `gate_presented` — Gate shown to audience
- `gate_resolved` — Gate approved or rejected (decision, notes, audience)

**Escalation events:**
- `escalation` — Budget exhaustion or issue escalation (role, reason, target)
- `architect_resolution` — Architect resolved an escalation (resolution summary)

### 11.4. Ledger Integrity

The engine is the sole writer. Agent sessions cannot access the ledger path (protected by meta-rule 5.3). Sequential `seq` numbering enables simple integrity verification:

```
function verify_ledger_integrity(ledger_path):
    entries = read_jsonl(ledger_path)
    for i, entry in enumerate(entries):
        assert entry.seq == i + 1, "Sequence gap at position {i}"
        assert entry.timestamp is valid ISO datetime
        assert entry.type is in known_event_types
```

---

## 12. Evidence Collection

### 12.1. Evidence Directory Structure

```
.nibbler/jobs/<job-id>/evidence/
├── diffs/
│   ├── <role>-<seq>.diff              # Raw git diff
│   └── <role>-<seq>.diff.meta.json    # Diff metadata (files changed, lines, scope)
├── checks/
│   ├── <role>-<seq>-scope.json        # Scope check result
│   └── <role>-<seq>-completion.json   # Completion check result
├── commands/
│   ├── <role>-<seq>-<command>.stdout   # Command stdout
│   ├── <role>-<seq>-<command>.stderr   # Command stderr
│   └── <role>-<seq>-<command>.meta.json # Exit code, duration, command text
├── sessions/
│   └── <role>-<phase>-<attempt>.log    # Raw Cursor session transcript (stream-json text)
└── gates/
    ├── <gate>-inputs.json              # What was presented to the audience
    └── <gate>-resolution.json          # Decision, notes, timestamp
```

### 12.2. Evidence Capture Functions

```
function record_diff(job, role, diff):
    seq = next_evidence_seq(job, role)
    path = "{job.evidence_dir}/diffs/{role}-{seq}.diff"
    write(path, diff.raw)
    write("{path}.meta.json", {
        files_changed: diff.files,
        lines_added: diff.additions,
        lines_removed: diff.deletions,
        role: role,
        timestamp: now()
    })

function record_command(job, role, check, result):
    seq = next_evidence_seq(job, role)
    base = "{job.evidence_dir}/commands/{role}-{seq}-{check.name}"
    write("{base}.stdout", result.stdout)
    write("{base}.stderr", result.stderr)
    write("{base}.meta.json", {
        command: check.command,
        exit_code: result.exit_code,
        duration_ms: result.duration,
        role: role,
        timestamp: now()
    })
```

### 12.3. Final State Capture

On any job termination (success, failure, budget exceeded, cancelled):

```
function capture_final_state(job):
    // Capture current workspace state
    write("{job.evidence_dir}/final-tree.txt", git_ls_files())
    write("{job.evidence_dir}/final-status.json", {
        branch: git_current_branch(),
        commit: git_current_commit(),
        job_state: job.state,
        active_role: job.current_role,
        budget_usage: job.get_global_budget_usage(),
        timestamp: now()
    })
```

---

## 13. Gate Controller

### 13.1. Gate Presentation

When the Job Manager reaches a gate-bearing transition, the Gate Controller prepares and presents the gate:

```
function present_gate(gate_def, job):
    // Collect inputs per gate definition
    inputs = {}
    for input_spec in gate_def.required_inputs:
        inputs[input_spec.name] = resolve_input(input_spec, job)

    // Store what was presented (evidence)
    write("{job.evidence_dir}/gates/{gate_def.id}-inputs.json", inputs)

    // Present to audience via CLI
    display_gate_prompt(gate_def, inputs)

    // Collect response
    resolution = read_gate_response()
    // → { decision: "approve" | "reject", notes: "..." }

    // Store resolution (evidence)
    write("{job.evidence_dir}/gates/{gate_def.id}-resolution.json", {
        decision: resolution.decision,
        notes: resolution.notes,
        audience: gate_def.audience,
        timestamp: now()
    })

    return resolution
```

### 13.2. Gate CLI Interface

Gates are presented as interactive CLI prompts:

```
╔══════════════════════════════════════════════════════╗
║  PO GATE: PLAN APPROVAL                             ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  Scope: Crew scheduling web application              ║
║  Roles: architect, sdet, backend, frontend           ║
║  Tasks: 12 total (3 sdet, 5 backend, 4 frontend)    ║
║                                                      ║
║  Artifacts for review:                               ║
║    → .nibbler/jobs/<id>/plan/acceptance.md            ║
║    → .nibbler/jobs/<id>/plan/test-plan.md             ║
║    → .nibbler/jobs/<id>/plan/delegation.yaml          ║
║    → .nibbler/jobs/<id>/plan/risk.md                  ║
║                                                      ║
║  Risks: 2 identified (see risk.md)                   ║
║                                                      ║
╠══════════════════════════════════════════════════════╣
║  [A]pprove  [R]eject  [V]iew artifacts               ║
╚══════════════════════════════════════════════════════╝
```

---

## 14. Init Bootstrap

### 14.1. The Bootstrap Problem

The Architect needs context to propose a contract, but context packs are normally compiled from the contract. Init is the one place where Nibbler uses a **hardcoded bootstrap** rather than a contract-derived context.

### 14.2. Bootstrap Context

The init session receives:

1. **The constitution** — All 17 meta-rules, presented as constraints the contract must satisfy.
2. **Project context** — Whatever exists: existing codebase, existing `architecture.md`, existing `vision.md`, repo structure scan.
3. **The init mandate** — "Propose a governance contract for this project that satisfies all constitutional constraints."
4. **Examples** — Optional contract examples for common project types (web app, API, CLI tool). These are suggestions, not templates.

### 14.3. Init Session Flow

```
function run_init(workspace):
    // Scan existing state
    context = scan_project_state(workspace)

    // Write bootstrap rules (temporary, replaced by contract output)
    write_bootstrap_rules(context)

    // Start Architect session with bootstrap context
    handle = session_controller.spawn(workspace, architect_env())
    session_controller.send(handle, init_bootstrap_prompt(context))

    // Wait for contract proposal
    wait_for_session_completion(handle)
    session_controller.stop(handle)

    // Read proposed contract
    contract = read_proposed_contract(workspace)

    // Validate against constitution
    errors = contract_validator.validate(contract)

    while errors:
        // Feed errors back to Architect
        handle = session_controller.spawn(workspace, architect_env())
        session_controller.send(handle, contract_revision_prompt(errors))
        wait_for_session_completion(handle)
        session_controller.stop(handle)

        contract = read_proposed_contract(workspace)
        errors = contract_validator.validate(contract)

    // Present to PO for confirmation
    display_contract_summary(contract)
    if not po_confirms():
        // PO can request changes → loop Architect
        ...

    // Commit validated contract
    git_commit("[nibbler] init: contract established")

    // Generate Cursor permission profiles from contract
    generate_cursor_profiles(contract)
```

### 14.4. Contract Review Mode

`nibbler init --review` re-runs the init process with the existing contract and project state as additional context. The Architect can propose modifications based on how the project has evolved. The engine re-validates the updated contract against all meta-rules.

---

## 15. Error Handling & Recovery

### 15.1. Error Categories

**Recoverable (autonomous):**
- Session scope violation → revert, provide feedback, retry within budget
- Completion criteria not met → revert, provide feedback, retry within budget
- Verification command failure → retry within budget
- Session crash/hang → restart session, retry within budget
- Cursor CLI transient error → retry with backoff

**Escalatable (to Architect):**
- Worker budget exhausted → Architect resolution session
- Worker cannot satisfy criteria after multiple retries → Architect analysis
- Ambiguous technical decision → Architect guidance

**Gate-requiring (to PO):**
- Permission expansion needed → EXCEPTION gate
- Scope change needed → EXCEPTION gate
- Product decision required → EXCEPTION gate
- Architect cannot resolve → EXCEPTION gate

**Terminal:**
- Global job budget exceeded → hard termination with evidence
- Unrecoverable engine error → crash with evidence preservation
- PO cancellation → graceful shutdown with evidence

### 15.2. Recovery Patterns

**Retry with feedback:**
```
function retry_with_feedback(role, job, feedback):
    job.add_feedback(role, feedback)
    // Feedback is included in the next context compilation
    // The role overlay will contain the feedback so the agent
    // knows what went wrong and what to fix
    run_role_session(role, job)  // re-enters the session loop
```

**Architect resolution:**
```
function architect_resolution(failed_role, job):
    // Architect gets: the failure evidence, the task definition,
    // and authority to adjust the approach
    resolution = run_architect_resolution(failed_role, job)

    if resolution.type == "guidance":
        // Retry the role with Architect's guidance as extra context
        retry_with_feedback(failed_role, job, resolution.guidance)
    elif resolution.type == "scope_expansion":
        // Requires EXCEPTION gate
        enforce_gate("exception", job)
    elif resolution.type == "task_blocked":
        // Mark task as blocked, continue with remaining tasks
        job.block_task(resolution.task_id, resolution.reason)
```

**Autonomous job-level recovery (CLI):**
- When a job fails and the CLI attempts autonomous recovery, it **restarts orchestration from the failing phase**
  (the persisted `currentPhaseId`) rather than re-running earlier phases like planning. This minimizes unnecessary PO prompts.
- If orchestration does re-encounter an already-approved PO gate (e.g. PLAN) during recovery/resume, the engine
  uses the ledger-recorded gate fingerprint to **auto-apply approval** when the underlying artifacts are unchanged.

### 15.3. Evidence Preservation on Failure

All error paths converge on evidence capture:

```
function handle_fatal_error(job, error):
    // Capture current state
    evidence_collector.capture_final_state(job)

    // Record in ledger
    ledger.append({
        type: "job_failed",
        error: str(error),
        state_at_failure: job.state,
        role_at_failure: job.current_role,
        timestamp: now()
    })

    // Ensure workspace is in a known state
    // (preserve the branch for debugging, don't delete anything)
```

---

## 16. CLI Design

### 16.1. Command Structure

```
nibbler <command> [options] [arguments]

Commands:
  init                    Generate or review the project governance contract
  build [requirement]     Run a full job: plan → execute → ship (contract-defined)
  status [job-id]         Show job status
  list                    List active jobs
  history                 List completed jobs
  resume <job-id>         Reattach to a running or paused job
```

### 16.2. Command Details

**`nibbler init [options]`**
```
Options:
  --file <path>     Input document for discovery (repeatable)
  --review          Re-evaluate and update existing contract
  --skip-discovery  Skip discovery (requires existing vision.md + architecture.md)
  --dry-run         Preview proposed contract without committing
```

**`nibbler build [requirement] [options]`**
```
Arguments:
  requirement       Natural language description of what to build (optional, quoted string)

Options:
  --file <path>     Accepted (repeatable). Currently reserved; discovery inputs are handled by `nibbler init --file`.
  --dry-run         Print the contract-defined execution plan summary (no agent sessions run)
  --skip-scaffold   Accepted. Currently a hint; scaffolding is controlled by the contract phases.
```

**`nibbler status [job-id]`**
```
Displays:
  - Current phase and state
  - Active role session (if any)
  - Budget consumption (per-role and global)
  - Last ledger events
  - Artifact summary
```

**`nibbler list`**
```
Displays:
  - All active/paused jobs with IDs, states, and ages
```

**`nibbler history`**
```
Displays:
  - Completed jobs with outcomes, durations, and evidence paths
```

**`nibbler resume <job-id>`**
```
Reattaches to a running or paused job:
  - If paused at a gate: re-presents the gate
  - If paused mid-execution: resumes from the last committed state
  - If running in background: attaches to the live session
```

---

## 17. Security Model

### 17.1. Threat Model

The primary threats Nibbler defends against:

1. **Agent scope violation** — An agent session modifies files outside its declared scope. Mitigated by post-hoc diff checking (Policy Engine).
2. **Governance tampering** — An agent session modifies the contract, ledger, or engine state. Mitigated by protected path enforcement (meta-rule 5.3).
3. **Secret exposure** — Agent sessions include secrets in artifacts, logs, or committed code. Mitigated by redaction rules in the base protocol and evidence scrubbing.
4. **Runaway execution** — An agent session runs indefinitely, consuming resources. Mitigated by budget enforcement (meta-rules 4.1-4.3).
5. **Malicious repo content** — Repository files influence Cursor behavior in unintended ways (e.g., prompt injection via code comments). Mitigated by Cursor's own safety mechanisms and by Nibbler's post-hoc verification (the engine trusts diffs, not intentions).

### 17.2. Permission Sandboxing

Each role's Cursor session runs with a dedicated permissions config:

- **Command allowlist** — Only commands relevant to the role are permitted (e.g., test runner, linter, build tool). No arbitrary shell access beyond what the contract declares.
- **Path restrictions** — Cursor-level path restrictions align with the role's scope. These are a soft boundary (advisory to the agent); the hard boundary is the engine's post-hoc diff check.
- **Environment isolation** — `CURSOR_CONFIG_DIR` is set per role to prevent cross-contamination of permissions between sessions.

### 17.3. Secret Handling

- The base protocol rule (`00-nibbler-protocol.mdc`) instructs agents to never include secrets, credentials, or sensitive data in artifacts or output.
- The Evidence Collector can be configured with redaction patterns to scrub sensitive data from captured command outputs.
- The contract can declare paths or patterns that are secret-bearing; these are excluded from all role scopes and from context packs.

---

## 18. Observability

### 18.1. Job Status

The `status.json` file in each job directory provides a real-time snapshot:

```json
{
    "job_id": "j-20250115-001",
    "state": "executing",
    "current_phase": "implementation",
    "current_role": "backend",
    "session_active": true,
    "budget": {
        "global": { "limit": "4h", "elapsed": "1h23m" },
        "current_role": { "iterations": { "limit": 5, "used": 2 } }
    },
    "progress": {
        "roles_completed": ["sdet"],
        "roles_remaining": ["backend", "frontend"],
        "tasks_completed": 4,
        "tasks_total": 12
    },
    "last_event": {
        "type": "session_start",
        "role": "backend",
        "timestamp": "2025-01-15T11:45:00Z"
    }
}
```

### 18.2. Live Monitoring

`nibbler status <job-id>` reads `status.json` and the ledger tail to present a live view. When attached to a running job (`nibbler resume`), the CLI streams session output and ledger events.

### 18.3. Post-Mortem Analysis

The evidence directory + ledger provide complete audit trail:

```
nibbler history --detail <job-id>
```

Reconstructs the full decision history: what was proposed, what was verified, what passed, what failed, what was approved, and the final diff.

---

## 19. Extensibility Points

### 19.1. Runner Adapters

New coding agent CLIs can be supported by implementing the `RunnerAdapter` interface. Each adapter handles:
- Session spawning with appropriate env/config
- Context injection mechanism (Cursor uses `.cursor/rules/`, others may differ)
- Event protocol adaptation
- Permission model mapping

### 19.2. Contract Extensions

The contract system is inherently extensible:
- New role types require no engine changes (just new scope/authority definitions)
- New phases require no engine changes (just new entries in the phase graph)
- New verification methods require engine support for new criterion types, but the criterion evaluation framework is pluggable
- New gate types require no engine changes (just new entries in the gate definitions)

### 19.3. Meta-Rule Versioning

Meta-rules are versioned with Nibbler releases. When a new meta-rule is added:
1. Existing contracts are re-validated on next `nibbler init --review`
2. If the new rule would be violated, the Architect is prompted to update the contract
3. The engine records the meta-rule version in the contract for compatibility tracking

### 19.4. Plugin Hooks

Future consideration: a plugin system where external scripts can observe engine events (phase transitions, gate presentations, evidence captures) and extend behavior. This aligns with Cursor's own hooks model and could enable integrations with CI systems, notification services, and project management tools.

---

## 20. Performance Considerations

### 20.1. Startup Time

Nibbler's engine overhead per session is minimal: read contract, compile context, write overlay file, swap permissions file, spawn process. Target: under 2 seconds between sessions.

### 20.2. Verification Overhead

Post-session verification (diff analysis, scope checking, command execution) adds time between sessions. For most projects:
- `git diff` analysis: milliseconds
- Scope pattern matching: milliseconds
- Test suite execution: variable (seconds to minutes, depending on project)

The test suite is the bottleneck, not the engine.

### 20.3. Ledger Performance

Append-only writes to a JSONL file are effectively O(1). The ledger is read sequentially for `status` and `history` commands. For very long-running jobs (hundreds of entries), an in-memory index could be built at read time, but this is unlikely to be needed for typical job sizes.

---

## 21. Open Technical Decisions

### 21.1. Implementation Language

Nibbler itself needs to be implemented. Candidates:
- **TypeScript/Node.js** — Aligns with Cursor's ecosystem, strong CLI tooling (Commander, Ink), good process management.
- **Python** — Rich ecosystem for CLI tools (Click, Rich), good subprocess management, widely understood.
- **Rust** — Fast startup, reliable process management, but higher development cost.

Recommendation: TypeScript for v1 (ecosystem alignment with Cursor, fast iteration), with the Runner Adapter Interface designed to be language-agnostic for future adapters.

### 21.2. Event Protocol Reliability

The NIBBLER_EVENT sentinel protocol depends on the LLM consistently emitting structured events. Fallback strategies for non-compliance:
- Timeout-based completion detection (session idle for N seconds → check state)
- Cursor Hooks for structured event capture (if available and reliable)
- Hybrid: use hooks where supported, fall back to sentinel parsing

### 21.3. Contract Format Standardization

While the architecture allows any format, the initial implementation should ship with a YAML-based contract format as the default. This provides a concrete starting point for the Architect while maintaining the theoretical flexibility for future alternatives.

### 21.4. Cursor CLI Stability

The architecture depends on Cursor Agent CLI capabilities (permissions, config dir override, shell mode) that may evolve. The Runner Adapter Interface provides a buffer, but the initial implementation will be tightly coupled to Cursor's current CLI behavior. Changes in Cursor's CLI may require adapter updates.
