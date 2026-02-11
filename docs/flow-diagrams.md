# Nibbler Flow Diagrams

This document contains detailed flow diagrams for the `init` and `build` commands, including all behaviors, exceptions, gates, and roles.

---

## 1. INIT Command Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           NIBBLER INIT COMMAND                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 0: PRE-FLIGHT SETUP                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> Display version & welcome banner
    │
    ├──> Workspace Scan
    │    ├─> Initialize .nibbler/ directory structure
    │    ├─> Ensure git initialized (git init if needed)
    │    ├─> Update .gitignore with required entries:
    │    │   • .nibbler/jobs/
    │    │   • .nibbler-staging/
    │    │   • .cursor/rules/20-role-*.mdc
    │    ├─> Write protocol rule (.cursor/rules/00-nibbler-protocol.mdc)
    │    ├─> Scan project state:
    │    │   • Detect language (TypeScript/JavaScript from package.json)
    │    │   • Check for src/ directory
    │    │   • Check for existing artifacts (vision.md, architecture.md, PRD.md)
    │    │   • Check for existing contract
    │    │   • Detect project type & traits
    │    └─> Check git repo cleanliness
    │
    └──> Display workspace scan results
         • Repo path, clean status
         • Language, file count
         • Existing artifacts
         • Project type & traits

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: DISCOVERY (AI-DRIVEN)                                              │
│ ROLE: Architect (interviewer/advisor mode)                                  │
│ AUTHORITY: Proposes, PO decides                                             │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> Skip if: --skip-discovery AND vision.md + architecture.md exist
    │
    ├──> Run Discovery Session (if artifacts missing)
    │    │
    │    ├─> Architect Agent Session
    │    │   • Mode: Interview/Discovery
    │    │   • Input: Codebase scan, existing docs
    │    │   • Provided files: opts.files (if specified)
    │    │   • Output directory: .nibbler-staging/discovery/
    │    │   │
    │    │   ├─> Architect explores codebase
    │    │   ├─> Architect generates:
    │    │   │   • vision.md (product vision)
    │    │   │   • architecture.md (technical architecture)
    │    │   └─> Session logs: .nibbler-staging/discovery/sessions/
    │    │
    │    └─> [EXCEPTION: Discovery Failed]
    │        ├─> Display error message
    │        ├─> Show verbose details (if NIBBLER_VERBOSE=1)
    │        └─> ABORT with error
    │
    └──> Refresh project scan after discovery

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: ARTIFACT QUALITY VALIDATION                                        │
│ ENGINE: Structural heuristics (deterministic)                               │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> Validate Artifacts (vision.md, architecture.md, PRD.md)
    │    • Check: Minimum length, required sections, structure
    │    • Score: "sufficient", "marginal", "insufficient"
    │    • Collect issues per artifact
    │
    └──> If ANY artifacts scored "insufficient":
         │
         ├──> Display quality report
         │
         ├──> [DECISION GATE: Artifact Quality]
         │    AUDIENCE: User (via prompt or env var)
         │    │
         │    ├─> Option 1: "Rediscover" (if !opts.skipDiscovery)
         │    │   │
         │    │   ├─> Re-run Discovery Session (with force=true)
         │    │   ├─> Re-validate artifacts
         │    │   │
         │    │   └─> If STILL insufficient:
         │    │       │
         │    │       ├─> Run Artifact Improvement Session
         │    │       │   • Architect generates proposed improvements
         │    │       │   • Output: .nibbler-staging/artifact-improvements/
         │    │       │   • Time budget: 600s (10 min)
         │    │       │
         │    │       ├─> [USER GATE: Apply Proposals]
         │    │       │   For each proposed artifact:
         │    │       │   • Display preview (first 25 lines)
         │    │       │   • Prompt: "Apply proposed update?"
         │    │       │   • Options: Apply / Skip
         │    │       │
         │    │       ├─> Re-validate after applying proposals
         │    │       │
         │    │       └─> If STILL insufficient:
         │    │           └─> [DECISION GATE: Continue or Abort]
         │    │
         │    ├─> Option 2: "Continue" (accept as-is, contract quality may suffer)
         │    │
         │    └─> Option 3: "Abort"
         │        └─> ABORT with instructions to fix manually

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: CONTRACT GENERATION (ITERATIVE)                                    │
│ ROLE: Architect                                                             │
│ AUTHORITY: Technical decisions, proposes contract                           │
│ MAX ATTEMPTS: 10                                                            │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> Initialize contract staging directory
    │    • Path: .nibbler-staging/contract/
    │    • Clear existing content
    │
    └──> ITERATIVE LOOP (attempt = 1..10):
         │
         ├──> [LOOP EXIT: Too many attempts (> 10)]
         │    └─> ABORT with error
         │
         ├──> Build Bootstrap Prompt for Architect
         │    • Include: project scan results
         │    • Include: example contracts (API service, CLI tool, web app)
         │    • Include: artifact quality summary
         │    • Include: existing contract YAML (if review mode)
         │    • Include: feedback from previous attempts (if any)
         │    • Output location: .nibbler-staging/contract/
         │
         ├──> Write role overlay for Architect
         │    • Path: .cursor/rules/20-role-architect.mdc
         │
         ├──> Start Architect Session (PLAN mode)
         │    │
         │    ├─> Permissions: Read-only repo, Write to staging only
         │    │   • Allow: Read(**/*), Write(.nibbler-staging/**)
         │    │   • Deny: Write(.nibbler/**), Write(.cursor/**), secrets
         │    │
         │    ├─> Architect analyzes codebase
         │    ├─> Architect generates contract files:
         │    │   • team.yaml (roles, scopes, budgets)
         │    │   • phases.yaml (phases, gates, transitions)
         │    │
         │    └─> Wait for completion event:
         │        NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"..."}
         │
         ├──> Stop Architect Session
         │
         ├──> [VALIDATION: Read Contract Files]
         │    │
         │    ├─> Try to read contract from staging
         │    │   • Path: .nibbler-staging/contract/
         │    │   • Files: team.yaml, phases.yaml
         │    │
         │    └─> [EXCEPTION: Contract Read Failed]
         │        ├─> Record failure feedback
         │        ├─> Display warning
         │        ├─> Show verbose details (if enabled)
         │        └─> RETRY with feedback
         │
         ├──> [VALIDATION: Contract Schema & Rules]
         │    │
         │    ├─> Validate against Zod schema
         │    ├─> Check constitutional meta-rules:
         │    │   • Every role has declared scope
         │    │   • Every phase has input/output boundaries
         │    │   • Phase graph is acyclic (DAG)
         │    │   • Every role has budget
         │    │   • Gates have defined outcomes
         │    │   • Scope overlaps are declared (sharedScopes)
         │    │
         │    └─> [EXCEPTION: Validation Errors]
         │        ├─> Record validation errors as feedback
         │        ├─> Display error count
         │        ├─> Show verbose details (if enabled)
         │        └─> RETRY with feedback
         │
         ├──> Display Contract Summary
         │    • Roles & their scopes
         │    • Phases & terminal flags
         │    • Gates, audiences, triggers
         │    • File paths: .nibbler/contract/team.yaml, phases.yaml
         │
         ├──> [DECISION GATE: PO Contract Approval]
         │    AUDIENCE: Product Owner
         │    │
         │    ├─> Prompt: "Accept this contract?"
         │    │   Options: Approve / Reject
         │    │
         │    ├─> Option: "Reject"
         │    │   ├─> Prompt for rejection notes
         │    │   ├─> Record notes as feedback
         │    │   └─> RETRY with feedback
         │    │
         │    └─> Option: "Approve"
         │        └─> BREAK loop, proceed to commit
         │
         └──> [END LOOP]

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: COMMIT & FINALIZE                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> Write Contract to Repository
    │    • Destination: .nibbler/contract/
    │    • Files: team.yaml, phases.yaml
    │
    ├──> Write Project Profile
    │    • Path: .nibbler/contract/project-profile.yaml
    │    • Contains: project type, traits, signals
    │
    ├──> Generate Cursor Profiles (Permissions)
    │    • For each role in contract:
    │      • Generate permissions config (scope patterns)
    │      • Write to: .nibbler/config/cursor-profiles/<roleId>/
    │
    ├──> Git Commit (if not dry-run)
    │    • Message: "[nibbler] init: contract established"
    │    • Include engine artifacts
    │
    ├──> Display Success Message
    │    "Initialization complete. Run `nibbler build` to start a job."
    │
    └──> RETURN { ok: true, contract }

┌─────────────────────────────────────────────────────────────────────────────┐
│ EXCEPTION HANDLING (throughout init)                                        │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> Cancellation (Ctrl+C / SIGINT)
    │    ├─> Cancel active Cursor session (best-effort)
    │    ├─> Cleanup active handle
    │    └─> RETURN { ok: false, errors: { reason: 'cancelled' } }
    │
    └──> Unexpected Errors
         ├─> Check if already cancelled
         ├─> Cleanup active session handle (best-effort)
         └─> THROW error (propagate to caller)
```

---

## 2. BUILD Command Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          NIBBLER BUILD COMMAND                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 0: PRE-FLIGHT CHECKS                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> Allocate Job ID
    │    • Format: j-YYYYMMDD-NNN (e.g., j-20260209-001)
    │    • Sequential per day
    │
    ├──> Check Working Tree Cleanliness
    │    • Ignore: .nibbler/ engine artifacts
    │    • [ABORT if dirty]: "Working tree is not clean"
    │
    ├──> Read Contract
    │    • Path: .nibbler/contract/
    │    • [ABORT if missing]: "Run `nibbler init` first"
    │
    ├──> Check .gitignore
    │    • Required entries: .nibbler/jobs/, .nibbler-staging/, etc.
    │    • [ABORT if incomplete]: "Run `nibbler init`"
    │
    ├──> Check Required Artifacts
    │    • vision.md (required)
    │    • architecture.md (required)
    │    • [ABORT if missing]: "Run `nibbler init` first"
    │
    └──> [DRY-RUN Mode]
         ├─> Display contract path summary
         └─> RETURN { ok: true, dryRun: true }

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: STALE JOB DETECTION & RESUME                                       │
│ (Skipped in test mode)                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> Find Latest Recoverable Job
    │    • Scan: .nibbler/jobs/ directory
    │    • Filter: state != 'completed' AND state != 'cancelled'
    │    • Select: latest job
    │
    └──> If stale job found:
         │
         ├──> Display job summary:
         │    • Job ID, state, phase, role
         │    • Progress: X/Y roles completed
         │    • Engine PID (if running)
         │
         ├──> [DECISION GATE: Resume or New]
         │    AUDIENCE: User (interactive prompt)
         │    │
         │    ├─> Option 1: "Resume"
         │    │   └─> DELEGATE to runExistingJob()
         │    │       • Rehydrate job state
         │    │       • Resume from current phase/role
         │    │       • Run with recovery on failure
         │    │
         │    └─> Option 2: "Start a new build"
         │        └─> Continue with new job below
         │
         └──> (Quiet mode: auto-resume latest job)

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: JOB SETUP                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> Prepare Job Worktree
    │    • Branch name: nibbler/job-<jobId>
    │    • Worktree path: <repoParent>/.nibbler-wt-<repoBasename>/<jobId>/
    │    • Base branch: <current-branch>
    │    │
    │    ├─> Create worktree: git worktree add
    │    ├─> Create job branch
    │    │
    │    └─> [EXCEPTION: Worktree preparation failed]
    │        └─> ABORT with error
    │
    ├──> Initialize Job Workspace
    │    • Create: .nibbler/jobs/<jobId>/
    │    • Subdirectories:
    │      - evidence/ (diffs, checks, commands, gates)
    │      - plan/ (delegation plans, resolutions)
    │      - status.json (job state snapshot)
    │      - ledger.jsonl (append-only event log)
    │
    ├──> Initialize Components
    │    • EvidenceCollector (captures verification outputs)
    │    • LedgerWriter (append-only audit trail)
    │    • GateController (presents gates to PO/architect)
    │    • SessionController (manages Cursor agent sessions)
    │
    └──> Create JobState
         • jobId, mode: 'build'
         • description: <requirement>
         • currentPhaseId: <contract.phases[0].id>
         • worktreePath, sourceBranch, jobBranch
         • startedAtIso, enginePid
         • globalBudgetLimitMs

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: JOB EXECUTION (CONTRACT-DRIVEN)                                    │
│ ORCHESTRATOR: JobManager                                                    │
│ CONTRACT: Defines roles, phases, gates, criteria                            │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> JobManager.runContractJob(job, contract)
    │    │
    │    ├─> Append to ledger: job_created
    │    │
    │    ├─> Find start phase (indegree = 0 in phase graph)
    │    │   • [ABORT if no start]: "No start phase found"
    │    │
    │    └──> PHASE GRAPH TRAVERSAL (max 50 transitions):
    │         │
    │         ╔═══════════════════════════════════════════════════════════════╗
    │         ║         FOR EACH PHASE (Sequential Execution)                 ║
    │         ╚═══════════════════════════════════════════════════════════════╝
    │         │
    │         ├──> Set job.currentPhaseId = phaseId
    │         │
    │         ├──> Hook: onPhaseEnter
    │         │    └─> Display phase banner
    │         │
    │         ├──> Special: PLANNING Phase
    │         │    │
    │         │    └──> If phaseId == 'planning' AND roleId == 'architect':
    │         │         │
    │         │         ├─> Run Planning Session (PLAN mode)
    │         │         │   • Bootstrap prompt includes:
    │         │         │     - Requirement (job.description)
    │         │         │     - Planning principles (right-sizing guidance)
    │         │         │     - Output: delegation.yaml
    │         │         │     - Schema: tasks with roleId, scopeHints, etc.
    │         │         │     - Role scopes summary
    │         │         │   • Session mode: PLAN
    │         │         │   • Output boundaries enforced
    │         │         │
    │         │         └─> Verify Delegation Plan
    │         │             • Check: file exists
    │         │             • Parse: YAML schema
    │         │             • Validate: tasks match role scopes
    │         │             • On success: store in job.delegationPlan
    │         │             • On failure: feedback to Architect, retry
    │         │
    │         ├──> Special: SCAFFOLD Phase
    │         │    │
    │         │    └──> If phaseId == 'scaffold' AND roleId == 'architect':
    │         │         │
    │         │         └─> Run Scaffold Session (IMPLEMENT mode)
    │         │             • Bootstrap prompt includes:
    │         │               - Goal: minimal project scaffold
    │         │               - Scope constraints (hard)
    │         │               - Web app guidance (if applicable)
    │         │               - Keep minimal, no features
    │         │               - Make `npm test` work
    │         │
    │         ├──> Special: EXECUTION Phase (Delegation-Driven)
    │         │    │
    │         │    └──> If phaseId == 'execution' AND job.delegationPlan exists:
    │         │         │
    │         │         ├─> Resolve Delegation
    │         │         │   • Topological sort tasks by dependsOn
    │         │         │   • Group tasks by roleId
    │         │         │   • Determine role order
    │         │         │
    │         │         └─> FOR EACH ROLE (in delegation order):
    │         │             │
    │         │             ├─> Hook: onHandoff (from prev role to current)
    │         │             │
    │         │             ├─> Run Delegated Plan Step (PLAN mode)
    │         │             │   • Worker reviews codebase + delegated tasks
    │         │             │   • Writes implementation plan to staging
    │         │             │   • Plan materialized to job workspace
    │         │             │   • Verification: no repo changes
    │         │             │
    │         │             └─> Run Role Session (IMPLEMENT mode)
    │         │                 • Bootstrap: "Execute plan at <path>"
    │         │                 • delegatedTasks passed to session
    │         │                 └─> (see ROLE SESSION flow below)
    │         │
    │         ├──> Special: SHIP Phase (Docs)
    │         │    │
    │         │    └──> If phaseId == 'ship' AND roleId == 'docs':
    │         │         │
    │         │         └─> Run Docs Session (IMPLEMENT mode)
    │         │             • Bootstrap prompt includes:
    │         │               - Goal: ship-ready README.md
    │         │               - Required headings (from criteria)
    │         │               - Minimum length (from criteria)
    │         │
    │         ├──> Default: Execute Phase Actors
    │         │    │
    │         │    └─> FOR EACH ACTOR in phase.actors[]:
    │         │        │
    │         │        ├─> Hook: onHandoff (if role changed)
    │         │        │
    │         │        ├─> Set job.currentRoleId = roleId
    │         │        ├─> Set job.currentPhaseActorIndex = i
    │         │        │
    │         │        └─> Run Role Session
    │         │            └─> (see ROLE SESSION flow below)
    │         │
    │         ├──> [CHECK: Terminal Phase]
    │         │    │
    │         │    └──> If phase.isTerminal OR no successors:
    │         │         │
    │         │         ├─> Check for Terminal Gate
    │         │         │   • Trigger: <phaseId>->__END__
    │         │         │   • If exists: present gate
    │         │         │   • Outcomes may loop back or end
    │         │         │
    │         │         └─> Break phase loop (job complete)
    │         │
    │         ├──> Determine Next Phase
    │         │    ├─> Find successor with on='done'
    │         │    ├─> Or use first successor
    │         │    │
    │         │    └─> [EXCEPTION: No successors]
    │         │        └─> ABORT with error
    │         │
    │         ├──> [CHECK: Gate at Transition]
    │         │    │
    │         │    └──> If gate exists for <current>-><next>:
    │         │         │
    │         │         ├─> Set job.state = 'paused'
    │         │         ├─> Set job.pendingGateId = gateId
    │         │         │
    │         │         ├─> GateController.presentGate()
    │         │         │   │
    │         │         │   ├─> Collect gate inputs (paths, data)
    │         │         │   ├─> Append to ledger: gate_presented
    │         │         │   │
    │         │         │   ├─> Render gate prompt (UI)
    │         │         │   │   AUDIENCE: <gate.audience> (PO / architect)
    │         │         │   │   • Title: job description
    │         │         │   │   • Subtitle: gate audience
    │         │         │   │   • Artifacts: required inputs
    │         │         │   │   • Prompt: approve / reject / other
    │         │         │   │
    │         │         │   ├─> Wait for resolution
    │         │         │   │
    │         │         │   ├─> Record resolution evidence
    │         │         │   └─> Append to ledger: gate_resolved
    │         │         │
    │         │         ├─> Map resolution.decision to outcome
    │         │         │   • Use gate.outcomes[decision]
    │         │         │   • [ABORT if outcome missing]
    │         │         │
    │         │         ├─> Set job.state = 'executing'
    │         │         ├─> Clear job.pendingGateId
    │         │         │
    │         │         └─> Set phaseId = outcome (may loop back)
    │         │
    │         └──> Proceed to next phase
    │              └─> LOOP
    │
    ├──> Job Complete
    │    ├─> Set job.state = 'completed'
    │    ├─> Clear current role/phase
    │    ├─> Finalize evidence
    │    └─> Append to ledger: job_completed
    │
    └──> [EXCEPTION: Job Failed/Cancelled]
         └─> (see EXCEPTION HANDLING below)

┌─────────────────────────────────────────────────────────────────────────────┐
│ SUB-FLOW: ROLE SESSION EXECUTION                                            │
│ (Called for each actor in each phase)                                       │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> JobManager.runRoleSession(roleId, job, contract, options)
    │    │
    │    ├─> Initialize Role Session State
    │    │   • Get role definition from contract
    │    │   • maxIterations = roleDef.budget.maxIterations (default: 1)
    │    │   • Resume: rehydrate attempts + scope overrides from ledger
    │    │   • attempt = 1 (or previous + 1 if resume)
    │    │
    │    └──> RETRY LOOP (attempt = 1..maxIterations):
    │         │
    │         ├──> [CHECK: Global Budget]
    │         │    ├─> Check: job total time vs contract.globalLifetime.maxTimeMs
    │         │    │
    │         │    └─> [EXCEPTION: Budget Exceeded]
    │         │        ├─> Set job.state = 'budget_exceeded'
    │         │        ├─> Finalize with job_budget_exceeded
    │         │        └─> RETURN { ok: false, reason: 'budget_exceeded' }
    │         │
    │         ├──> Capture Pre-Session State
    │         │    • Git commit hash: preSessionCommit
    │         │    • Store in job.preSessionCommit
    │         │
    │         ├──> [SPECIAL: Delegated Planning Step]
    │         │    │
    │         │    └──> If phaseId=='execution' AND delegatedTasks exist:
    │         │         │
    │         │         ├─> Run Plan Session (PLAN mode)
    │         │         │   • Prompt: Review codebase, write impl plan
    │         │         │   • Output: .nibbler-staging/<jobId>/plans/<role>-plan.md
    │         │         │   • Permissions: staging only
    │         │         │
    │         │         ├─> Verify: no repo changes
    │         │         │   • [FAIL]: revert, feedback, retry
    │         │         │
    │         │         ├─> Verify: plan file exists
    │         │         │   • [FAIL]: feedback, retry
    │         │         │
    │         │         └─> Materialize Plan
    │         │             • Copy to: .nibbler/jobs/<id>/plan/<role>-impl-plan.md
    │         │             • Also to worktree (session can read it)
    │         │
    │         ├──> Append to ledger: session_start
    │         │
    │         ├──> Hook: onRoleStart
    │         │    └─> Display spinner: "Starting session (attempt X/Y)..."
    │         │
    │         ├──> Build Effective Contract
    │         │    • Base contract + scope overrides (from previous escalations)
    │         │    • Apply granted patterns (if any)
    │         │    • Expire overrides past their attempt limit
    │         │
    │         ├──> Build Bootstrap Prompt (if applicable)
    │         │    • Planning: delegation schema, output boundaries
    │         │    • Scaffold: minimal setup guidance, scope warnings
    │         │    • Docs: README headings, length requirements
    │         │    • Delegated execution: "Execute plan at <path>"
    │         │    • Include: role scope summary, shared scopes
    │         │
    │         ├──> Start Cursor Agent Session
    │         │    │
    │         │    ├─> SessionController.startSession()
    │         │    │   • roleId, job, effectiveContract
    │         │    │   • mode: 'plan' OR 'implement'
    │         │    │   • delegatedTasks (if applicable)
    │         │    │   • implementationPlanRel (if delegated execution)
    │         │    │   • bootstrapPrompt (if provided)
    │         │    │
    │         │    ├─> Session Config
    │         │    │   • Workspace: worktreePath (job branch)
    │         │    │   • Permissions: from effectiveContract role scope
    │         │    │   • Task type: plan / implement
    │         │    │   • Inactivity timeout: 120s
    │         │    │
    │         │    ├─> Write Overlay
    │         │    │   • Path: .cursor/rules/20-role-<roleId>.mdc
    │         │    │   • Contains:
    │         │    │     - Role identity, scope, authority
    │         │    │     - Phase context, requirements
    │         │    │     - Delegated tasks (if applicable)
    │         │    │     - Implementation plan reference (if applicable)
    │         │    │     - Bootstrap prompt
    │         │    │     - Feedback from previous attempts
    │         │    │     - Scope exception decisions (if applicable)
    │         │    │     - Engine hints
    │         │    │     - Protocol reminder
    │         │    │
    │         │    └─> Launch Cursor Agent
    │         │        • Spawn Cursor CLI process
    │         │        • Monitor events stream
    │         │        • Log to: .nibbler/jobs/<id>/evidence/sessions/<seq>-<role>-<phase>-<attempt>.log
    │         │
    │         ├──> Wait for Session Completion
    │         │    │
    │         │    ├─> Poll events: NIBBLER_EVENT messages
    │         │    │   • PHASE_COMPLETE: role finished successfully
    │         │    │   • NEEDS_ESCALATION: role requests help
    │         │    │   • EXCEPTION: product decision needed
    │         │    │
    │         │    ├─> Check Budget During Execution
    │         │    │   • roleDef.budget.maxTimeMs
    │         │    │   • Inactivity timeout (120s)
    │         │    │
    │         │    └─> [TIMEOUT / BUDGET]
    │         │        └─> Stop session, escalate
    │         │
    │         ├──> Stop Session
    │         │    • SessionController.stopSession()
    │         │    • Clear active handle
    │         │
    │         ├──> Set job.sessionActive = false
    │         │
    │         ├──> [CHECK: Cancellation]
    │         │    └─> If job.state == 'cancelled':
    │         │        └─> RETURN { ok: false, reason: 'cancelled' }
    │         │
    │         ├──> [SPECIAL: NEEDS_ESCALATION from worker (not architect)]
    │         │    │
    │         │    └──> If outcome.event.type == 'NEEDS_ESCALATION':
    │         │         │
    │         │         ├─> Append to ledger: session_escalated
    │         │         │
    │         │         ├─> Revert Session Changes
    │         │         │   • git reset --hard <preSessionCommit>
    │         │         │   • git clean
    │         │         │
    │         │         ├─> Run Escalation Resolution by Architect
    │         │         │   └─> (see ESCALATION RESOLUTION below)
    │         │         │
    │         │         ├─> Store guidance in job.feedbackByRole[roleId]
    │         │         │
    │         │         └─> RETRY (attempt += 1)
    │         │
    │         ├──> Compute Diff
    │         │    • git diff <preSessionCommit>..HEAD
    │         │    • Filter out engine paths (.nibbler/, .cursor/rules/, etc.)
    │         │    • Store in job.lastDiff
    │         │
    │         ├──> Hook: beforeVerifyCompletion
    │         │    └─> Materialize planning artifacts (if applicable)
    │         │
    │         ├──> Verify Scope
    │         │    │
    │         │    ├─> For each changed file in diff:
    │         │    │   ├─> Check: protected paths (.nibbler/contract/, etc.)
    │         │    │   ├─> Check: file in role scope patterns
    │         │    │   ├─> Check: file in shared scope (if role included)
    │         │    │   │
    │         │    │   └─> [VIOLATION]: record ScopeViolation
    │         │    │       • file, role, reason (out_of_scope / protected_path)
    │         │    │
    │         │    └─> Result: ScopeResult { passed, violations, diffSummary }
    │         │
    │         ├──> Verify Completion
    │         │    │
    │         │    ├─> For each criterion in phase.completionCriteria:
    │         │    │   │
    │         │    │   ├─> artifact_exists: check file exists + non-empty
    │         │    │   ├─> command_succeeds: run command, check exit 0
    │         │    │   ├─> command_fails: run command, check exit != 0
    │         │    │   ├─> diff_non_empty: check diff has changes
    │         │    │   ├─> markdown_has_headings: parse markdown, check headings
    │         │    │   ├─> delegation_coverage: verify task scopeHints coverage
    │         │    │   ├─> diff_within_budget: check file/line counts
    │         │    │   └─> custom: run script, check exit 0
    │         │    │
    │         │    └─> Result: CompletionResult { passed, criteriaResults }
    │         │
    │         ├──> [SPECIAL: Delegation Plan Verification]
    │         │    │
    │         │    └──> If roleId=='architect' AND phaseId=='planning':
    │         │         │
    │         │         ├─> Verify delegation.yaml exists
    │         │         │   • [FAIL]: feedback with schema example
    │         │         │
    │         │         ├─> Parse delegation.yaml
    │         │         │   • [FAIL]: feedback with YAML quoting tip
    │         │         │
    │         │         ├─> Validate delegation against contract
    │         │         │   • Check: tasks target execution-phase actors only
    │         │         │   • Check: scopeHints match role scopes
    │         │         │   • [FAIL]: feedback with errors
    │         │         │
    │         │         └─> Store in job.delegationPlan
    │         │
    │         ├──> Record Evidence
    │         │    • Diff snapshot
    │         │    • Scope check result
    │         │    • Completion check result
    │         │
    │         ├──> Append to Ledger
    │         │    • scope_check: role, attempt, passed, violations
    │         │    • completion_check: role, attempt, passed, criteriaResults
    │         │
    │         ├──> Compute Budget Usage
    │         │    • iterations: attempt count
    │         │    • elapsedMs: session duration
    │         │    • diffLines: additions + deletions
    │         │
    │         ├──> Hook: onVerification
    │         │    └─> Display scope + completion results
    │         │
    │         ├──> [SUCCESS: Both Passed]
    │         │    │
    │         │    └──> If scope.passed AND completion.passed:
    │         │         │
    │         │         ├─> Git Commit
    │         │         │   • Message: "[nibbler:<jobId>] <roleId> complete"
    │         │         │
    │         │         ├─> Append to ledger: session_complete
    │         │         │
    │         │         ├─> Hook: onRoleComplete
    │         │         │   └─> Display: "X files changed (Y lines)"
    │         │         │
    │         │         └─> RETURN { ok: true }
    │         │
    │         ├──> [FAILURE: Scope or Completion Failed]
    │         │    │
    │         │    ├─> Revert Session Changes
    │         │    │   • git reset --hard <preSessionCommit>
    │         │    │   • git clean
    │         │    │
    │         │    ├─> Append to ledger: session_reverted
    │         │    │
    │         │    ├─> Hook: onRoleReverted
    │         │    │   └─> Display: "Reverted — <reason>. Retrying..."
    │         │    │
    │         │    ├─> Build Attempt Summary
    │         │    │   • attempt number
    │         │    │   • scope: passed, violationCount, sampleViolations
    │         │    │   • completion: passed, failedCriteria
    │         │    │   • engineHint: (generated based on failure pattern)
    │         │    │
    │         │    ├─> Store in job.feedbackHistoryByRole[roleId][]
    │         │    ├─> Store in job.feedbackByRole[roleId]
    │         │    │
    │         │    ├─> Append to ledger: session_feedback
    │         │    │
    │         │    ├─> [CHECK: Budget Exhausted]
    │         │    │    └─> If !budget.passed:
    │         │    │        └─> ESCALATE (budget_exhausted)
    │         │    │
    │         │    ├──> [CHECK: Scope Violations - Severity-Based Escalation]
    │         │    │    │
    │         │    │    └──> If !scope.passed AND roleId != 'architect':
    │         │    │         │
    │         │    │         ├─> Classify Violations
    │         │    │         │   • protectedPaths (always escalate)
    │         │    │         │   • outOfScopePaths (may escalate)
    │         │    │         │
    │         │    │         ├─> Determine If Should Escalate Now
    │         │    │         │   • Always: hasProtected
    │         │    │         │   • Always: attempt==1 AND structural violation
    │         │    │         │   • Always: attempt >= 2
    │         │    │         │   • (Structural: many files, different owners)
    │         │    │         │
    │         │    │         └──> If shouldEscalateNow AND hasArchitect:
    │         │    │              │
    │         │    │              ├─> Append to ledger: session_escalated
    │         │    │              │   • reason: protected_path_violation OR scope_violation
    │         │    │              │   • protectedPaths, outOfScopePaths, ownerHints
    │         │    │              │
    │         │    │              ├─> Run Scope Exception Decision by Architect
    │         │    │              │   └─> (see SCOPE EXCEPTION DECISION below)
    │         │    │              │
    │         │    │              ├─> Inject Decision into Feedback
    │         │    │              │   • Update feedbackHistoryByRole[-1].scopeDecision
    │         │    │              │   • Update feedbackByRole.scopeDecision
    │         │    │              │
    │         │    │              ├─> [DECISION: terminate]
    │         │    │              │   └─> RETURN { ok: false, reason: 'failed' }
    │         │    │              │
    │         │    │              ├─> [DECISION: reroute_work]
    │         │    │              │   └─> RETURN { ok: false, reason: 'failed' }
    │         │    │              │
    │         │    │              └─> [DECISION: grant_narrow_access]
    │         │    │                  │
    │         │    │                  ├─> Record in job.scopeOverridesByRole[roleId]
    │         │    │                  │   • kind: shared_scope / extra_scope
    │         │    │                  │   • patterns: granted globs
    │         │    │                  │   • ownerRoleId (if applicable)
    │         │    │                  │   • phaseId, grantedAtIso
    │         │    │                  │   • expiresAfterAttempt (if set)
    │         │    │                  │   • notes
    │         │    │                  │
    │         │    │                  └─> Add engineHint to feedback
    │         │    │                      "Scope override granted..."
    │         │    │
    │         │    └─> RETRY (attempt += 1, continue loop)
    │         │
    │         └──> [END LOOP: Out of iterations]
    │              │
    │              └─> ESCALATE (budget_exhausted)
    │                  └─> (see ESCALATION below)

┌─────────────────────────────────────────────────────────────────────────────┐
│ SUB-FLOW: SCOPE EXCEPTION DECISION BY ARCHITECT                             │
│ ROLE: Architect                                                             │
│ AUTHORITY: Technical decisions (scope triage)                               │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> Capture Pre-Decision State
    │    • Git commit: pre
    │
    ├──> Prepare Decision Request
    │    • decisionFile: .nibbler-staging/<jobId>/scope-exception-decision.json
    │    • proposalEvidence: .nibbler/jobs/<id>/evidence/checks/scope-exception-proposal.json
    │
    ├──> Write Proposal Evidence
    │    • failedRoleId, attempt
    │    • protectedPaths[], outOfScopePaths[]
    │    • ownerHints: [{file, owners}]
    │
    ├──> Append to ledger: scope_exception_requested
    │
    ├──> Inject Feedback for Architect
    │    • job.feedbackByRole.architect = {
    │        kind: 'scope_exception_decision',
    │        request: { failedRoleId, protectedPaths, outOfScopePaths, ownerHints },
    │        choices: ['deny', 'grant_narrow_access', 'reroute_work', 'terminate'],
    │        rules: { protectedPathsNonNegotiable, neverKeepViolatingDiff, ... }
    │      }
    │
    ├──> Build Decision Bootstrap Prompt
    │    • Failed role, phase, attempt
    │    • Out-of-scope paths (from verification)
    │    • Protected paths (non-negotiable)
    │    • Ownership hints (file -> likely owners)
    │    • Suggested narrow patterns (advisory)
    │    • Output: JSON decision file
    │    • Allowed decisions: deny, grant_narrow_access, reroute_work, terminate
    │    • Example: {"decision":"grant_narrow_access","kind":"shared_scope","patterns":[...]}
    │
    ├──> Restrict Architect Contract
    │    • scope: ['.nibbler-staging/**'] (staging writes only)
    │    • authority.allowedCommands: []
    │
    ├──> Start Architect Session (PLAN mode)
    │    • Workspace: worktreePath
    │    • Permissions: staging only
    │    • Bootstrap: decision prompt
    │    • Wait for: PHASE_COMPLETE
    │
    ├──> Stop Session
    │
    ├──> Enforce: No Repo Modifications
    │    • Diff vs pre-decision commit
    │    • Filter engine paths
    │    • If non-empty: revert, deny, log
    │
    ├──> Read Decision File
    │    • Path: .nibbler-staging/<jobId>/scope-exception-decision.json
    │    • [MISSING]: deny with notes
    │    • [PARSE FAIL]: deny with notes
    │
    ├──> Validate Decision
    │    • decision in ['deny', 'grant_narrow_access', 'reroute_work', 'terminate']
    │    • [INVALID]: deny with notes
    │
    ├──> [DECISION: deny]
    │    ├─> Append to ledger: scope_exception_denied
    │    └─> RETURN { decision: 'deny', notes }
    │
    ├──> [DECISION: reroute_work]
    │    ├─> Append to ledger: scope_exception_denied (reason: reroute_work)
    │    └─> RETURN { decision: 'reroute_work', toRoleId?, notes }
    │
    ├──> [DECISION: terminate]
    │    ├─> Append to ledger: scope_exception_denied (reason: terminated)
    │    └─> RETURN { decision: 'terminate', notes }
    │
    └──> [DECISION: grant_narrow_access]
         │
         ├─> Extract Parameters
         │   • patterns: string[] (required, non-empty)
         │   • kind: 'shared_scope' (preferred) | 'extra_scope'
         │   • ownerRoleId?: string
         │   • expiresAfterAttempt?: number
         │   • notes?: string
         │
         ├─> Validate: patterns non-empty
         │    • [FAIL]: deny with notes
         │
         ├─> Append to ledger: scope_exception_granted
         │    • jobId, phaseId, role, attempt
         │    • kind, patterns, ownerRoleId, expiresAfterAttempt
         │    • evidencePath, notes
         │
         ├─> Write Effective Evidence
         │    • Path: .nibbler/jobs/<id>/evidence/checks/scope-exception-effective.json
         │    • Contains: decision, overrideKind, patterns, etc.
         │
         └─> RETURN {
               decision: 'grant_narrow_access',
               kind, patterns, ownerRoleId, expiresAfterAttempt, notes
             }

┌─────────────────────────────────────────────────────────────────────────────┐
│ SUB-FLOW: ESCALATION RESOLUTION BY ARCHITECT                                │
│ ROLE: Architect                                                             │
│ AUTHORITY: Technical guidance for blocked workers                           │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> Triggered by:
    │    • Worker emits NEEDS_ESCALATION
    │    • Budget exhaustion
    │
    ├──> Capture Pre-Resolution State
    │    • Git commit: pre
    │
    ├──> Prepare Resolution Request
    │    • resolutionFile: .nibbler-staging/<jobId>/resolutions/<failedRoleId>.md
    │    • failedRoleId, attempt, event (NEEDS_ESCALATION)
    │    • delegatedTasks (if applicable)
    │    • implementationPlanRel (if worker had plan)
    │
    ├──> Inject Feedback for Architect
    │    • job.feedbackByRole.architect = {
    │        kind: 'escalation_resolution_request',
    │        failedRoleId, attempt, event,
    │        delegatedTasks, implementationPlanRel,
    │        outputFile: resolutionStagedRel
    │      }
    │
    ├──> Record Custom Check Evidence
    │    • kind: escalation-request
    │
    ├──> Append to ledger: architect_resolution
    │
    ├──> Build Resolution Prompt
    │    • Worker role, reason for escalation
    │    • Goal: provide actionable technical guidance
    │    • Output: resolution markdown file in staging
    │    • Do NOT modify repo files
    │    • Emit: PHASE_COMPLETE when done
    │
    ├──> Restrict Architect Contract
    │    • scope: ['.nibbler-staging/**']
    │    • authority.allowedCommands: []
    │
    ├──> Start Architect Session (PLAN mode)
    │    • Bootstrap: resolution prompt
    │    • Wait for: PHASE_COMPLETE
    │
    ├──> Stop Session
    │
    ├──> Enforce: No Repo Modifications
    │    • Diff vs pre-resolution commit
    │    • Filter engine paths
    │    • [VIOLATION]: revert, deny, log
    │
    ├──> [MISSING: Resolution File]
    │    └─> RETURN { ok: false, notes: "Missing resolution file" }
    │
    ├──> Materialize Resolution
    │    • Copy from staging to: .nibbler/jobs/<id>/plan/resolutions/<role>.md
    │    • Also to worktree (worker can read it on retry)
    │
    ├──> Record Evidence
    │    • kind: escalation-resolution-materialized
    │
    ├──> Reset Tracked Changes (safety)
    │    • git reset --hard pre
    │    • git clean
    │
    └──> RETURN { ok: true, resolutionRel }

┌─────────────────────────────────────────────────────────────────────────────┐
│ SUB-FLOW: BUDGET EXHAUSTION ESCALATION                                      │
│ ROLE: Architect                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> Hook: onEscalation
    │    └─> Display: "Budget exhausted"
    │
    ├──> Append to ledger: escalation
    │    • jobId, role, reason: 'budget_exhausted', budget
    │
    ├──> [CHECK: No Architect OR roleId is Architect]
    │    └─> Set job.state = 'failed'
    │        └─> RETURN { ok: false, reason: 'failed' }
    │
    ├──> Run Escalation Resolution by Architect
    │    • Provide: failedRoleId, attempt, event (NEEDS_ESCALATION)
    │    • Architect writes guidance to staging
    │    • Guidance materialized to job workspace
    │    └─> (see ESCALATION RESOLUTION above)
    │
    ├──> Store Guidance in Feedback
    │    • job.feedbackByRole[roleId] = {
    │        kind: 'architect_guidance',
    │        event: { type: 'NEEDS_ESCALATION', reason: 'budget_exhausted' },
    │        guidance
    │      }
    │
    ├──> Set job.state = 'failed'
    │
    └──> RETURN { ok: false, reason: 'escalated', details: { roleId, guidance } }

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: RECOVERY (AUTONOMOUS)                                              │
│ ROLE: Architect                                                             │
│ MAX ATTEMPTS: 2                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    └──> If JobOutcome.ok == false AND reason != 'cancelled':
         │
         ├──> FOR attempt = 1..2:
         │    │
         │    ├─> Display: "Recovery (autonomous)"
         │    ├─> Display: "Build failed. Architect reviewing..."
         │    │
         │    ├─> Reset JobManager for Recovery
         │    │   • jm.resetForRecovery()
         │    │
         │    ├─> Update Job Mode
         │    │   • job.mode = 'fix'
         │    │   • job.state = 'executing'
         │    │
         │    ├─> Inject Feedback for Architect
         │    │   • job.feedbackByRole.architect = {
         │    │       kind: 'fix',
         │    │       issue: formatFailureForArchitect(outcome, job),
         │    │       userGuidance: guidance (if user provided)
         │    │     }
         │    │
         │    ├─> Run Contract Job from Fix Start Phase
         │    │   • startPhase = pickFixStartPhase(contract)
         │    │   • Usually: 'execution' or 'planning'
         │    │   • Full role session flow runs again
         │    │
         │    ├─> [SUCCESS]
         │    │   └─> RETURN { ok: true }
         │    │
         │    ├─> [FAILURE: Cancelled]
         │    │   └─> RETURN { ok: false, reason: 'cancelled' }
         │    │
         │    └─> [FAILURE: Other]
         │         │
         │         ├─> If prompts disabled OR attempt >= 2:
         │         │   └─> RETURN outcome (failed)
         │         │
         │         ├─> Display: "Autonomous recovery did not resolve"
         │         ├─> Display: evidence path
         │         │
         │         ├─> [USER GATE: Retry or Abort]
         │         │   │
         │         │   ├─> Option: "Provide guidance and retry"
         │         │   │   └─> Prompt for guidance string
         │         │   │       └─> Store in guidance variable
         │         │   │           └─> CONTINUE loop
         │         │   │
         │         │   └─> Option: "Abort"
         │         │       └─> RETURN outcome (failed)
         │         │
         │         └─> [END LOOP]
         │
         └──> RETURN outcome (failed)

┌─────────────────────────────────────────────────────────────────────────────┐
│ PHASE 5: MERGE & CLEANUP                                                    │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    └──> If JobOutcome.ok == true:
         │
         ├──> Merge Job Branch Back to Source Branch
         │    │
         │    ├─> Check: source branch still exists
         │    ├─> Check: no divergence (source didn't move)
         │    ├─> Attempt: git merge --ff-only OR git merge --no-ff
         │    │
         │    ├─> [SUCCESS]
         │    │   └─> Display: "Merged into <sourceBranch>"
         │    │
         │    └─> [FAILURE: Cannot merge]
         │        ├─> Display: "Auto-merge skipped"
         │        ├─> Display: worktree preserved
         │        └─> RETURN { ok: false, details: "Merge manually" }
         │
         ├──> Cleanup Worktree
         │    │
         │    ├─> Remove worktree: git worktree remove
         │    ├─> Delete job branch: git branch -D
         │    │
         │    ├─> [SUCCESS]
         │    │   └─> Display: "Worktree cleaned up"
         │    │
         │    └─> [INCOMPLETE]
         │        └─> Display: "Cleanup incomplete" + paths
         │
         ├──> Display Job Complete Summary
         │    • Job ID, duration
         │    • Roles completed
         │    • Commits count
         │    • Files/lines changed
         │    • Branch (after merge)
         │    • Evidence path
         │    • Ledger path
         │
         └──> RETURN { ok: true, jobId }

┌─────────────────────────────────────────────────────────────────────────────┐
│ EXCEPTION HANDLING (throughout build)                                       │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├──> Cancellation (Ctrl+C / SIGINT)
    │    │
    │    ├─> Cancel via JobManager
    │    │   • Set job.state = 'cancelled'
    │    │   • Stop active Cursor session (best-effort)
    │    │   • Capture evidence
    │    │   • Write job_cancelled to ledger
    │    │
    │    ├─> Preserve worktree & branch
    │    │   └─> Display: paths for manual inspection
    │    │
    │    └─> RETURN { ok: false, reason: 'cancelled' }
    │
    ├──> Job Failed (from JobManager)
    │    │
    │    ├─> Set job.state = 'failed'
    │    ├─> Capture final evidence
    │    │   • Final git tree
    │    │   • Final state snapshot
    │    │   • Commit hash, branch
    │    ├─> Write job_failed to ledger
    │    │
    │    ├─> Preserve worktree & branch
    │    │   └─> Display: paths for manual inspection
    │    │
    │    └─> RETURN { ok: false, jobId, details }
    │
    └──> Global Budget Exceeded
         │
         ├─> Set job.state = 'budget_exceeded'
         ├─> Write job_budget_exceeded to ledger
         ├─> Preserve worktree & branch
         └─> RETURN { ok: false, reason: 'budget_exceeded' }

┌─────────────────────────────────────────────────────────────────────────────┐
│ LEDGER EVENTS (append-only audit trail)                                     │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ├─> job_created: jobId, repoRoot, mode
    ├─> session_start: role, commit, mode (plan/implement)
    ├─> session_escalated: role, reason, event, details
    ├─> session_complete: role, outcome
    ├─> session_reverted: role, attempt, scopePassed, completionPassed
    ├─> session_feedback: jobId, role, attempt, scope, completion, engineHint
    ├─> scope_check: role, attempt, passed, violations, diff, evidencePath
    ├─> completion_check: role, attempt, passed, criteriaResults, evidencePath
    ├─> custom_check: kind, passed, reason?, evidencePath
    ├─> scope_exception_requested: jobId, role, attempt, protectedPaths, outOfScopePaths
    ├─> scope_exception_granted: jobId, role, attempt, kind, patterns, ownerRoleId, notes
    ├─> scope_exception_denied: jobId, role, attempt, reason, notes
    ├─> architect_resolution: jobId, failedRoleId, attempt, outputFile
    ├─> escalation: jobId, role, reason, budget
    ├─> gate_presented: gateId, audience, inputs
    ├─> gate_resolved: gateId, audience, decision, notes
    ├─> job_completed: jobId
    ├─> job_failed: jobId, details
    ├─> job_budget_exceeded: jobId, exceeded
    └─> job_cancelled: jobId, info
```

---

## 3. Key Roles & Authority

### Product Owner (PO)
- **Authority**: Product decisions (what, why, priorities)
- **Active during**:
  - Discovery phase (answers questions, approves vision)
  - Gates (PLAN, EXCEPTION, SHIP)
- **Cannot**: Make technical decisions, bypass gates, modify contract

### Architect (AI Agent)
- **Authority**: Technical decisions (architecture, delegation, code review)
- **Active during**:
  - Init (proposes contract)
  - Discovery (interviews PO, proposes vision/architecture)
  - Planning (decomposes work, writes delegation plan)
  - Execution (reviews, resolves escalations, scope exceptions)
- **Cannot**: Bypass PO gates, approve own SHIP gate, modify meta-rules

### Worker Roles (AI Agents)
- **Authority**: Implementation within declared scope
- **Active during**: Execution phase (assigned tasks)
- **Cannot**: Work outside scope, modify governance, bypass review, contact PO directly

---

## 4. Exception & Escalation Paths

### Scope Violations (Worker)
```
┌─────────────────────────────────────────────────────────────┐
│ Scope Violation Detected (post-session)                    │
└─────────────────────────────────────────────────────────────┘
    │
    ├──> Classify severity:
    │    • Protected paths → ALWAYS escalate
    │    • Structural (many files, multi-owner) + attempt==1 → escalate
    │    • Attempt >= 2 → escalate
    │    • Otherwise → retry with feedback
    │
    ├──> If escalation triggered:
    │    │
    │    └──> Architect Scope Exception Decision
    │         ├─> deny → revert, retry with feedback
    │         ├─> grant_narrow_access → add override, retry
    │         ├─> reroute_work → terminate, suggest different role
    │         └─> terminate → abort job
    │
    └──> Retry with:
         • Scope feedback (violations list)
         • Engine hint
         • Scope decision (if granted)
```

### Budget Exhaustion (Worker)
```
┌─────────────────────────────────────────────────────────────┐
│ Role Budget Exhausted                                       │
└─────────────────────────────────────────────────────────────┘
    │
    ├──> Hook: onEscalation(roleId, 'budget_exhausted')
    │
    ├──> If no Architect OR roleId is Architect:
    │    └─> Fail job
    │
    └──> Run Escalation Resolution by Architect
         ├─> Architect reviews failure context
         ├─> Writes guidance to staging
         ├─> Guidance materialized to job workspace
         ├─> Store in feedbackByRole[roleId]
         └─> Fail job (user can attempt recovery)
```

### Worker Requests Help (NEEDS_ESCALATION)
```
┌─────────────────────────────────────────────────────────────┐
│ Worker Emits NEEDS_ESCALATION Event                        │
└─────────────────────────────────────────────────────────────┘
    │
    ├──> Revert session changes
    │
    ├──> Run Escalation Resolution by Architect
    │    ├─> Architect reviews:
    │    │   • Worker role, reason, context
    │    │   • Delegated tasks
    │    │   • Implementation plan
    │    ├─> Writes guidance markdown
    │    └─> Materialized to job workspace
    │
    ├──> Store guidance in feedbackByRole[roleId]
    │
    └──> Retry worker session with guidance
```

### Discovery Failed (Init)
```
┌─────────────────────────────────────────────────────────────┐
│ Discovery Session Failed                                   │
└─────────────────────────────────────────────────────────────┘
    │
    ├──> Display error message
    ├──> Show verbose details (if NIBBLER_VERBOSE=1)
    └──> Abort init
```

### Contract Validation Failed (Init)
```
┌─────────────────────────────────────────────────────────────┐
│ Contract Schema/Meta-Rules Validation Failed               │
└─────────────────────────────────────────────────────────────┘
    │
    ├──> Record validation errors
    ├──> Provide errors as feedback to Architect
    ├──> Display error count
    ├──> Show verbose details (if enabled)
    └──> Retry contract generation with feedback
         (max 10 attempts)
```

---

## 5. Gate Types & Audiences

### PLAN Gate
- **Trigger**: `planning->execution`
- **Audience**: PO
- **Inputs**: delegation.yaml, task breakdown
- **Outcomes**: approve (→ execution), reject (→ planning retry)

### EXCEPTION Gate
- **Trigger**: scope/budget exceptions (configured per contract)
- **Audience**: PO
- **Outcomes**: approve exception, modify plan, terminate

### SHIP Gate
- **Trigger**: `ship->__END__`
- **Audience**: PO
- **Inputs**: README.md, final artifacts
- **Outcomes**: approve (→ complete), reject (→ ship retry)

### Scope Exception Gate (Internal)
- **Trigger**: scope violations (worker)
- **Audience**: Architect
- **Outcomes**: deny, grant_narrow_access, reroute_work, terminate

---

## 6. Verification Criteria Types

### Scope Check (enforced for ALL sessions)
- **Validates**: Changed files within role.scope OR contract.sharedScopes
- **Detects**: out_of_scope, protected_path violations
- **Post-hoc**: Computed from git diff after session

### Completion Criteria (per phase in contract)
- `artifact_exists`: Check file exists + non-empty
- `command_succeeds`: Run command, verify exit 0
- `command_fails`: Run command, verify exit != 0
- `diff_non_empty`: Verify diff has changes
- `markdown_has_headings`: Parse markdown, check required headings + length
- `delegation_coverage`: Verify task scopeHints coverage (engine-added for delegation-driven)
- `diff_within_budget`: Check file/line count limits
- `custom`: Run script, verify exit 0

---

## 7. Evidence & Audit Trail

### Evidence Directory Structure
```
.nibbler/jobs/<jobId>/
├── evidence/
│   ├── diffs/          # Git diffs per session
│   ├── checks/         # Scope, completion, custom checks
│   ├── commands/       # Command execution outputs
│   ├── gates/          # Gate inputs, resolutions
│   └── sessions/       # Session logs (Cursor agent output)
├── plan/
│   ├── delegation.yaml            # Planning output
│   ├── <role>-impl-plan.md        # Worker implementation plans
│   └── resolutions/<role>.md      # Architect guidance
├── status.json         # Live job state snapshot
└── ledger.jsonl        # Append-only event log
```

### Ledger (Append-Only Audit)
- Every decision recorded with timestamp
- Gate approvals/rejections
- Escalations, scope exceptions
- Session start/complete/revert
- Scope/completion check results
- Evidence paths

---

## Notes for Review

1. **Phase Flow**: Does the phase graph traversal logic make sense? Especially gate handling and terminal phases?

2. **Role Session Loop**: Is the retry logic clear? Especially:
   - When to escalate vs retry
   - Scope exception decision flow
   - Feedback accumulation

3. **Delegation-Driven Execution**: Is the flow for planning → plan verification → worker planning → worker execution clear?

4. **Exception Paths**: Are all escalation triggers and resolution flows covered?

5. **Recovery Flow**: Is the autonomous recovery loop (Tier 1: auto-retry, Tier 2: user guidance) clear?

6. **Gates**: Are the gate types, audiences, and outcomes comprehensive?

Let me know what needs clarification or adjustment!
