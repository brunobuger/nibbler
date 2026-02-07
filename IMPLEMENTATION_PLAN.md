# Nibbler — Implementation Plan

*A phased implementation plan for building Nibbler: a constitutional orchestration engine that drives sequential Cursor Agent CLI sessions with deterministic governance.*

---

## 0. Starting Point & Technology Decisions

### 0.1. Current State

The project is greenfield. Only `PRD.md`, `ARCHITECTURE.md`, and a stub `README.md` exist. There is no code, no dependencies, no build tooling.

### 0.2. Language & Runtime

**TypeScript on Node.js** (as recommended in ARCHITECTURE §21.1). Rationale:

- Ecosystem alignment with Cursor (VS Code / Electron heritage)
- Strong CLI tooling ecosystem (Commander, Ink/Chalk for terminal UI)
- Good subprocess management via `child_process` / `execa`
- Fast iteration speed for v1
- The Runner Adapter Interface is designed to be language-agnostic; the implementation language does not constrain future adapters

### 0.3. Key Dependencies (Initial)

| Dependency | Purpose |
|---|---|
| `commander` | CLI argument parsing |
| `yaml` | Contract parsing (YAML format for v1) |
| `chalk` | Terminal colors and styling |
| `inquirer` / `@inquirer/prompts` | Interactive gate prompts and PO interview |
| `execa` | Subprocess management (Cursor CLI sessions) |
| `picomatch` / `minimatch` | Glob pattern matching for scope verification |
| `uuid` or `nanoid` | Job ID generation |
| `zod` | Runtime validation for contract schemas and ledger entries |
| `vitest` | Testing framework |
| `tsx` | TypeScript execution without build step during development |
| `tsup` | Bundling for distribution |
| `eslint` + `prettier` | Code quality |

### 0.4. Project Structure

```
nibbler/
├── src/
│   ├── cli/                    # CLI entry point and command handlers
│   │   ├── index.ts            # Main entry (commander setup)
│   │   ├── commands/
│   │   │   ├── init.ts
│   │   │   ├── build.ts
│   │   │   ├── fix.ts
│   │   │   ├── status.ts
│   │   │   ├── list.ts
│   │   │   ├── history.ts
│   │   │   └── resume.ts
│   │   └── ui/                 # Terminal UI components (gate prompts, status display)
│   │       ├── gate-prompt.ts
│   │       └── status-display.ts
│   │
│   ├── core/                   # Core engine components
│   │   ├── job-manager.ts      # Orchestration loop, job state machine
│   │   ├── policy-engine.ts    # Meta-rule enforcement (scope, completion, budget)
│   │   ├── contract/
│   │   │   ├── reader.ts       # Contract reading abstraction
│   │   │   ├── validator.ts    # Contract validation against 17 meta-rules
│   │   │   └── types.ts        # Contract type definitions
│   │   ├── context/
│   │   │   ├── compiler.ts     # Three-layer context compilation
│   │   │   ├── overlay.ts      # .cursor/rules/ overlay generation
│   │   │   └── permissions.ts  # Cursor permissions config generation
│   │   ├── session/
│   │   │   ├── controller.ts   # Session lifecycle management
│   │   │   ├── runner.ts       # Runner adapter interface
│   │   │   ├── cursor-adapter.ts   # Cursor CLI runner implementation
│   │   │   ├── event-parser.ts     # NIBBLER_EVENT protocol parser
│   │   │   └── health.ts       # Session health monitoring
│   │   ├── evidence/
│   │   │   ├── collector.ts    # Evidence capture functions
│   │   │   └── types.ts        # Evidence type definitions
│   │   ├── ledger/
│   │   │   ├── writer.ts       # Append-only ledger writer
│   │   │   ├── reader.ts       # Ledger reading and querying
│   │   │   └── types.ts        # Ledger event type definitions
│   │   └── gate/
│   │       ├── controller.ts   # Gate presentation and resolution
│   │       └── types.ts        # Gate type definitions
│   │
│   ├── discovery/              # Discovery engine
│   │   ├── engine.ts           # Discovery orchestration
│   │   ├── schema.ts           # Tiered question schema
│   │   ├── ingestion.ts        # Document ingestion
│   │   ├── classification.ts   # Project type classification
│   │   └── type-modules/       # Per-type question modules
│   │       ├── web-app.ts
│   │       ├── api-service.ts
│   │       ├── cli-tool.ts
│   │       ├── mobile-app.ts
│   │       ├── library.ts
│   │       └── data-pipeline.ts
│   │
│   ├── git/                    # Git operations abstraction
│   │   ├── operations.ts       # Branch, commit, diff, reset, clean
│   │   └── diff-parser.ts      # Structured diff analysis
│   │
│   ├── workspace/              # Workspace management
│   │   ├── layout.ts           # .nibbler/ and .cursor/ directory setup
│   │   ├── protected-paths.ts  # Protected path definitions and checking
│   │   └── scanner.ts          # Existing codebase scanning
│   │
│   ├── templates/              # Built-in templates and bootstrap content
│   │   ├── protocol-rule.ts    # 00-nibbler-protocol.mdc template
│   │   ├── bootstrap-prompt.ts # Init bootstrap prompt
│   │   ├── discovery-prompt.ts # Discovery session prompt
│   │   └── contract-examples/  # Example contracts for common project types
│   │       ├── web-app.yaml
│   │       ├── api-service.yaml
│   │       └── cli-tool.yaml
│   │
│   └── utils/                  # Shared utilities
│       ├── logger.ts           # Structured logging
│       ├── id.ts               # ID generation
│       └── fs.ts               # File system helpers
│
├── tests/
│   ├── unit/                   # Unit tests (mirror src/ structure)
│   ├── integration/            # Integration tests (multi-component)
│   └── fixtures/               # Test fixtures (sample contracts, diffs, etc.)
│
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .eslintrc.js
├── .prettierrc
├── PRD.md
├── ARCHITECTURE.md
├── IMPLEMENTATION_PLAN.md
└── README.md
```

---

## 1. Implementation Phases

The implementation is divided into **10 phases**, each building on the previous. Each phase produces a testable, demonstrable increment. The dependency graph is linear at the macro level (each phase depends on prior phases), but within phases, many components can be built in parallel.

### Phase Summary

| Phase | Name | Description | Key Deliverables |
|---|---|---|---|
| 0 | **Project Bootstrap** | Repository setup, tooling, CI | Build, test, lint pipeline |
| 1 | **Foundation Layer** | Git ops, ledger, evidence, workspace layout | Core data infrastructure |
| 2 | **Contract System** | Contract parsing, validation, types | Contract reader + validator |
| 3 | **Policy Engine** | Scope verification, completion criteria, budgets | All 17 meta-rules enforced |
| 4 | **Session Controller** | Cursor CLI lifecycle, context injection, swap | Sessions can be spawned and managed |
| 5 | **Gate Controller** | Interactive PO gates, resolution recording | Gates can be presented and resolved |
| 6 | **Job Manager** | Orchestration loop, state machine, escalation | End-to-end execution pipeline |
| 7 | **Discovery Engine** | Interview, document ingestion, vision synthesis | `nibbler build` discovery phase works |
| 8 | **Init Bootstrap** | Contract proposal, validation loop, PO confirm | `nibbler init` fully functional |
| 9 | **End-to-End Integration** | Full pipeline, `build` command, error recovery | Complete happy path works |
| 10 | **Polish & Secondary Commands** | `fix`, `status`, `list`, `history`, `resume`, docs | Feature-complete v1 |

---

## Phase 0 — Project Bootstrap

**Goal:** A working TypeScript project with build, test, lint, and run infrastructure.

### Tasks

| # | Task | Details |
|---|---|---|
| 0.1 | Initialize package.json | `npm init`, set `"type": "module"`, set `"bin": { "nibbler": "./dist/cli.js" }` |
| 0.2 | Install dev dependencies | TypeScript, vitest, eslint, prettier, tsup, tsx |
| 0.3 | Install runtime dependencies | commander, yaml, chalk, inquirer, execa, picomatch, zod, nanoid |
| 0.4 | Configure TypeScript | `tsconfig.json` — target ES2022, module NodeNext, strict mode, path aliases |
| 0.5 | Configure build | `tsup` config — entry `src/cli/index.ts`, format ESM, dts generation |
| 0.6 | Configure testing | `vitest.config.ts` — coverage, path aliases, test file patterns |
| 0.7 | Configure linting | ESLint + Prettier configs, TypeScript-aware rules |
| 0.8 | Add npm scripts | `build`, `dev`, `test`, `test:watch`, `lint`, `lint:fix`, `format` |
| 0.9 | Create CLI entry point | Bare `src/cli/index.ts` with commander setup, `nibbler --version`, `nibbler --help` |
| 0.10 | Verify end-to-end | `npm run build && npx nibbler --help` prints usage |

### Exit Criteria

- `npm run build` succeeds
- `npm test` runs (even if no tests yet)
- `npx nibbler --help` prints command listing
- `npx nibbler --version` prints version from `package.json`

### Estimated Effort: Small (< 1 day)

---

## Phase 1 — Foundation Layer

**Goal:** Core data infrastructure that all higher-level components depend on: git operations, ledger, evidence collection, workspace layout management, and shared utilities.

### 1.1. Git Operations (`src/git/`)

An abstraction over git commands. All git interaction goes through this module — no raw `exec("git ...")` elsewhere.

| Function | Purpose |
|---|---|
| `getCurrentCommit()` | Return current HEAD hash |
| `createBranch(name)` | Create and checkout a new branch |
| `getCurrentBranch()` | Return current branch name |
| `commit(message)` | Stage all and commit |
| `diff(fromCommit, toCommit?)` | Return structured diff (changed files, additions, deletions) |
| `diffFiles(fromCommit)` | Return list of changed file paths (for scope checking) |
| `resetHard(commit)` | Hard reset to a commit |
| `clean()` | Remove untracked files |
| `lsFiles()` | List all tracked files |
| `isClean()` | Check if working tree is clean |

The `diff-parser.ts` module parses raw `git diff` output into a structured representation:

```typescript
interface DiffResult {
  files: DiffFile[];
  summary: { additions: number; deletions: number; filesChanged: number };
  raw: string;
}

interface DiffFile {
  path: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}
```

**Tests:** Unit tests with a temporary git repo fixture. Test diff parsing against known diff outputs.

### 1.2. Ledger (`src/core/ledger/`)

Append-only JSONL ledger implementation (meta-rules 5.1, 5.2).

| Component | Details |
|---|---|
| `types.ts` | Zod schemas for all event types: `job_created`, `session_start`, `scope_check`, `gate_resolved`, etc. Common envelope: `{ seq, timestamp, type, data }` |
| `writer.ts` | `LedgerWriter` class. Tracks next `seq`. Only `append(event)` method. Writes one JSON line per call. Validates event against Zod schema before writing. Flushes after every write (durability). |
| `reader.ts` | `LedgerReader` class. `readAll()`, `tail(n)`, `findByType(type)`, `verifyIntegrity()`. Integrity check: sequential `seq` with no gaps. |

**Key design decision:** The writer holds a file handle and tracks `seq` in memory (initialized by reading the file on construction). This is safe because Nibbler is single-process.

**Tests:** Write events → read them back → verify integrity. Test corruption detection (gap in seq). Test concurrent-safety is not needed (single-process design).

### 1.3. Evidence Collector (`src/core/evidence/`)

Captures verification outputs to the job's evidence directory (meta-rule 5.4).

| Function | Purpose |
|---|---|
| `recordDiff(job, role, diff)` | Write `.diff` and `.diff.meta.json` to `evidence/diffs/` |
| `recordScopeCheck(job, role, result)` | Write scope check JSON to `evidence/checks/` |
| `recordCompletionCheck(job, role, result)` | Write completion check JSON to `evidence/checks/` |
| `recordCommand(job, role, check, result)` | Write stdout, stderr, meta.json to `evidence/commands/` |
| `recordGateInputs(job, gate, inputs)` | Write gate inputs to `evidence/gates/` |
| `recordGateResolution(job, gate, resolution)` | Write resolution to `evidence/gates/` |
| `captureFinalState(job)` | Write `final-tree.txt` and `final-status.json` |

Uses a sequential counter per role per job for file naming: `<role>-<seq>-<type>.<ext>`.

**Tests:** Capture evidence → verify files exist with expected structure and content.

### 1.4. Workspace Layout (`src/workspace/`)

Manages the `.nibbler/` and `.cursor/` directory structures.

| Function | Purpose |
|---|---|
| `initWorkspace(repoRoot)` | Create `.nibbler/contract/`, `.nibbler/config/cursor-profiles/` |
| `initJob(repoRoot, jobId)` | Create `.nibbler/jobs/<id>/plan/`, `evidence/diffs/`, `evidence/checks/`, `evidence/commands/`, `evidence/gates/` |
| `isNibblerRepo(repoRoot)` | Check if `.nibbler/contract/` exists |
| `getJobDir(repoRoot, jobId)` | Return resolved job directory path |
| `writeProtocolRule(repoRoot, content)` | Write `.cursor/rules/00-nibbler-protocol.mdc` |
| `writeRoleOverlay(repoRoot, role, content)` | Write `.cursor/rules/20-role-<role>.mdc` |
| `clearRoleOverlays(repoRoot)` | Remove all `20-role-*.mdc` files |
| `isProtectedPath(path)` | Check if a path is engine-protected (`.nibbler/`, `00-nibbler-protocol.mdc`) |

**Tests:** Create workspace → verify directory structure. Check protected paths.

### 1.5. Shared Utilities (`src/utils/`)

| Module | Purpose |
|---|---|
| `logger.ts` | Structured logging with levels (debug, info, warn, error). Writes to stderr to keep stdout clean for PO interaction. Optional JSON mode for machine consumption. |
| `id.ts` | Job ID generation: `j-YYYYMMDD-NNN` format (sortable, human-readable). |
| `fs.ts` | Helpers: `ensureDir`, `writeJson`, `readJson`, `readYaml`, `fileExists`, `readText`. |

### Phase 1 Exit Criteria

- All git operations work against a real temporary repo in tests
- Ledger write → read → integrity check passes
- Evidence files are created with correct structure
- Workspace layout initialization creates all expected directories
- Protected path checking is correct
- All utility functions have tests

### Estimated Effort: Medium (2–3 days)

---

## Phase 2 — Contract System

**Goal:** Parse, validate, and provide typed access to the project's governance contract. This is the foundation for all policy enforcement.

### 2.1. Contract Types (`src/core/contract/types.ts`)

Zod-validated TypeScript types for the contract structure:

```typescript
interface Contract {
  roles: RoleDefinition[];
  phases: PhaseDefinition[];
  gates: GateDefinition[];
  globalLifetime: BudgetSpec;
  sharedScopes: SharedScopeDeclaration[];
  escalationChain: EscalationStep[];
}

interface RoleDefinition {
  id: string;
  scope: ScopePattern[];        // file path patterns (globs)
  authority: AuthoritySpec;      // commands, actions
  outputExpectations: string[];  // what the role must produce
  verificationMethod: VerificationSpec;
  budget: BudgetSpec;
  behavioralGuidance?: string;
}

interface PhaseDefinition {
  id: string;
  preconditions: Precondition[];
  actors: string[];              // role IDs
  inputBoundaries: string[];     // folder path patterns
  outputBoundaries: string[];    // folder path patterns
  completionCriteria: Criterion[];
  successors: SuccessorMapping[];
  isTerminal?: boolean;
}

interface GateDefinition {
  id: string;
  trigger: string;               // transition or state
  audience: 'PO' | 'architect' | string;
  requiredInputs: GateInputSpec[];
  outcomes: Record<string, string>;  // decision → next phase/action
}
```

### 2.2. Contract Reader (`src/core/contract/reader.ts`)

Reads the contract from `.nibbler/contract/` directory. For v1, assumes YAML format.

| Function | Purpose |
|---|---|
| `readContract(contractDir)` | Parse all YAML files in the directory, assemble into `Contract` |
| `writeContract(contractDir, contract)` | Serialize `Contract` back to YAML files |

The reader is an abstraction — the internal parse logic can be swapped for other formats in the future.

### 2.3. Contract Validator (`src/core/contract/validator.ts`)

Implements the validation algorithm from ARCHITECTURE §3.2. Checks all 17 meta-rules.

```typescript
function validateContract(contract: Contract): ValidationError[];
```

**Validation checks (mapped to meta-rules):**

| Check | Meta-Rule | Implementation |
|---|---|---|
| Every role has a scope | 1.1 | Iterate roles, check `scope` non-empty |
| No undeclared scope overlaps | 1.3 | Pairwise scope intersection using `picomatch` → check against `sharedScopes` |
| Protected paths excluded | 5.3 | Check no role scope matches `.nibbler/**` or `.cursor/rules/00-nibbler-protocol.mdc` |
| Every phase has input/output boundaries | 2.1 | Iterate phases, check arrays non-empty |
| Dependency satisfaction | 2.2 | For each phase input, verify an upstream phase outputs it |
| Phase graph is DAG | 3.3 | Build directed graph from successor mappings → topological sort → detect cycles |
| Reachable terminal state | 3.3 | BFS/DFS from start phase → verify terminal phase is reachable |
| Every phase has completion criteria | 3.1 | Iterate phases, check `completionCriteria` non-empty |
| Every gate has approve + reject outcomes | 3.4 | Iterate gates, check `outcomes` has both keys |
| At least one PO gate exists | 5.5 | Filter gates by `audience === 'PO'` |
| Every role has a budget | 4.1 | Iterate roles, check `budget` defined |
| Budget exhaustion has escalation | 4.2 | Iterate roles, check `budget.exhaustionEscalation` exists |
| Global job lifetime defined | 4.3 | Check `globalLifetime` exists |
| Every role has a verification method | 3.1 (implied) | Iterate roles, check `verificationMethod` defined |

**Scope intersection computation:** Use `picomatch` to expand glob patterns and detect overlaps. For efficiency, use a heuristic — if patterns share a common prefix or use `**`, they likely overlap.

### Phase 2 Exit Criteria

- A sample contract YAML can be parsed into typed `Contract`
- All 17 meta-rule checks implemented with individual test cases
- Invalid contracts are rejected with specific, actionable error messages
- Valid contracts pass without errors
- Round-trip: read → write → read produces identical contract

### Estimated Effort: Medium (2–3 days)

---

## Phase 3 — Policy Engine

**Goal:** Runtime enforcement of all constitutional meta-rules. The Policy Engine is called at every session boundary and phase transition.

### 3.1. Scope Verification (`src/core/policy-engine.ts`)

Post-hoc diff checking (meta-rules 1.2, 1.3, 5.3):

```typescript
function verifyScope(diff: DiffResult, roleDef: RoleDefinition, contract: Contract): ScopeResult;
```

Algorithm:
1. For each changed file in the diff, check if it matches the role's scope patterns
2. If not in role scope, check shared scopes
3. Check all changed files against protected paths (meta-rule override)
4. Return detailed violation report

Uses `picomatch` for glob pattern matching against file paths from the diff.

### 3.2. Completion Criteria Evaluation

```typescript
function verifyCompletion(role: string, job: JobState, contract: Contract): CompletionResult;
```

Criterion evaluators:

| Criterion Type | Implementation |
|---|---|
| `artifact_exists(pattern)` | Glob match against workspace files |
| `command_succeeds(command)` | Execute via `execa`, check exit code === 0 |
| `command_fails(command)` | Execute via `execa`, check exit code !== 0 |
| `diff_non_empty()` | Check diff has at least one changed file |
| `diff_within_budget(maxFiles, maxLines)` | Check diff counts against limits |
| `custom(script)` | Execute script, check exit code === 0 |

Each evaluator returns a `CriterionResult` with `passed`, `evidence` (full output), and `message`.

### 3.3. Budget Enforcement

```typescript
function checkBudget(usage: SessionUsage, roleDef: RoleDefinition): BudgetResult;
function checkGlobalBudget(job: JobState, contract: Contract): BudgetResult;
```

Tracks:
- **Iterations** — count of session attempts for a role
- **Elapsed time** — wall clock since session start
- **Diff size** — lines changed (if budget specifies)
- **Global lifetime** — wall clock since job start

### 3.4. Gate Enforcement

```typescript
function shouldEnforceGate(transition: string, contract: Contract): GateDefinition | null;
```

Checks if the current phase transition has a declared gate. Returns the gate definition if so.

### Phase 3 Exit Criteria

- Scope check correctly identifies in-scope and out-of-scope file changes
- Scope check detects protected path violations
- Scope check handles shared scopes correctly
- All criterion types evaluate correctly (artifact exists, command succeeds/fails, diff checks)
- Budget enforcement detects exceeded limits with correct escalation path
- Gate enforcement identifies gate-bearing transitions

### Estimated Effort: Medium (2–3 days)

---

## Phase 4 — Session Controller

**Goal:** Manage the lifecycle of Cursor Agent CLI sessions — spawning, context injection, event monitoring, and teardown.

### 4.1. Runner Adapter Interface (`src/core/session/runner.ts`)

```typescript
interface RunnerAdapter {
  spawn(workspacePath: string, envVars: Record<string, string>, configDir: string): Promise<SessionHandle>;
  send(handle: SessionHandle, message: string): Promise<void>;
  readEvents(handle: SessionHandle): AsyncIterable<NibblerEvent>;
  isAlive(handle: SessionHandle): boolean;
  stop(handle: SessionHandle): Promise<void>;
  capabilities(): RunnerCapabilities;
}
```

### 4.2. Cursor CLI Adapter (`src/core/session/cursor-adapter.ts`)

Implementation of `RunnerAdapter` for Cursor Agent CLI.

| Method | Implementation |
|---|---|
| `spawn` | `execa('cursor', ['--agent'], { cwd, env: { CURSOR_CONFIG_DIR, ...env } })` with stdio pipes |
| `send` | Write to stdin of the spawned process |
| `readEvents` | Parse stdout lines for `NIBBLER_EVENT {...}` prefix, yield parsed events |
| `isAlive` | Check if process is still running (pid exists, no exit code) |
| `stop` | Send SIGTERM, wait with timeout, then SIGKILL if needed |

**Key implementation detail:** Use `execa` with `{ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }` to get full control over I/O. Stream stdout through a line-by-line parser that checks for the `NIBBLER_EVENT` prefix.

### 4.3. Event Parser (`src/core/session/event-parser.ts`)

Parses `NIBBLER_EVENT {...}` lines from session output:

```typescript
function parseEventLine(line: string): NibblerEvent | null;
```

Event types (from ARCHITECTURE §5.2):
- `PHASE_COMPLETE` — Session declares its work is done
- `NEEDS_ESCALATION` — Session cannot resolve an issue
- `EXCEPTION` — Session encounters a product-level issue

**Fallback:** If no event is emitted within a configurable timeout, the controller assumes session completion and proceeds to verification.

### 4.4. Session Health Monitor (`src/core/session/health.ts`)

Monitors session liveness, activity, and budget:

```typescript
class SessionHealthMonitor {
  constructor(handle: SessionHandle, budget: BudgetSpec);
  start(): void;                    // Begin monitoring
  onBudgetExceeded(cb): void;       // Budget callback
  onInactive(cb): void;             // Inactivity callback
  onProcessDeath(cb): void;         // Crash callback
  stop(): void;                     // Stop monitoring
}
```

Polls at configurable intervals (default: 5 seconds). Tracks last activity timestamp (updated on any stdout output).

### 4.5. Context Compiler (`src/core/context/compiler.ts`)

Implements the three-layer context model (ARCHITECTURE §4.2–4.4):

```typescript
function compileContext(
  role: string,
  phase: string,
  jobState: JobState,
  contract: Contract
): CompiledContext;
```

Returns the three layers (identity, mission, world) which are then rendered into the overlay.

### 4.6. Overlay Generator (`src/core/context/overlay.ts`)

Renders compiled context into a `.cursor/rules/20-role-<role>.mdc` file:

```typescript
function renderOverlay(context: CompiledContext): string;
```

Generates markdown-style content with structured sections:
- Role identity, scope boundaries, authority limits
- Assigned tasks, acceptance criteria, completion signal instructions
- Files to read for context, focus guidance
- Event protocol instructions (NIBBLER_EVENT format)

### 4.7. Permissions Generator (`src/core/context/permissions.ts`)

Generates per-role Cursor CLI config:

```typescript
function generatePermissionsConfig(roleDef: RoleDefinition, contract: Contract): CursorConfig;
function writePermissionsProfile(repoRoot: string, role: string, config: CursorConfig): void;
```

### 4.8. Session Controller (`src/core/session/controller.ts`)

Orchestrates the full session lifecycle:

```typescript
class SessionController {
  constructor(runner: RunnerAdapter, workspace: string);

  async startSession(role: string, job: JobState, contract: Contract): Promise<SessionHandle>;
  async waitForCompletion(handle: SessionHandle, budget: BudgetSpec): Promise<SessionOutcome>;
  async stopSession(handle: SessionHandle): Promise<void>;
  async swapSession(fromRole: string, toRole: string, job: JobState, contract: Contract): Promise<void>;
}
```

The `swapSession` method implements the full swap sequence from ARCHITECTURE §4.6.

### Phase 4 Exit Criteria

- Runner adapter interface is defined and the Cursor adapter compiles
- A Cursor CLI session can be spawned, sent a message, and stopped (integration test, requires Cursor CLI installed)
- Event parser correctly extracts NIBBLER_EVENT from output lines
- Health monitor detects process death and inactivity
- Context compiler produces correct three-layer output for a sample contract + job state
- Overlay generator produces valid `.mdc` content
- Permissions config is generated correctly per role

**Note:** Full integration testing of the Cursor CLI adapter requires Cursor to be installed. Unit tests should mock the runner interface. A "dry run" adapter that logs actions without spawning a real process should be implemented for testing.

### Estimated Effort: Large (4–5 days)

---

## Phase 5 — Gate Controller

**Goal:** Present gates to the PO via interactive CLI prompts, collect resolutions, and record them in the ledger and evidence.

### 5.1. Gate Controller (`src/core/gate/controller.ts`)

```typescript
class GateController {
  constructor(ledger: LedgerWriter, evidence: EvidenceCollector);

  async presentGate(gateDef: GateDefinition, job: JobState): Promise<GateResolution>;
}
```

### 5.2. Gate CLI Interface (`src/cli/ui/gate-prompt.ts`)

Renders the gate prompt box (ARCHITECTURE §13.2) using `chalk` for styling and `inquirer` for input:

```
╔══════════════════════════════════════════════════════╗
║  PO GATE: PLAN APPROVAL                             ║
╠══════════════════════════════════════════════════════╣
║  Scope: <job description>                           ║
║  Roles: <role list>                                 ║
║  Tasks: <task summary>                              ║
║                                                      ║
║  Artifacts for review:                               ║
║    → <artifact paths>                                ║
╠══════════════════════════════════════════════════════╣
║  [A]pprove  [R]eject  [V]iew artifacts               ║
╚══════════════════════════════════════════════════════╝
```

Options:
- **Approve** — Record approval, proceed
- **Reject** — Prompt for rejection reason, record, follow recovery path
- **View** — Display artifact contents (paginated), then re-prompt

### 5.3. Gate Input Resolution

```typescript
function collectGateInputs(gateDef: GateDefinition, job: JobState): Record<string, unknown>;
```

Resolves `requiredInputs` from the gate definition — reads artifact files, generates summaries, computes statistics.

### Phase 5 Exit Criteria

- Gate prompt renders correctly in the terminal
- PO can approve, reject (with reason), and view artifacts
- Gate resolution is recorded in both the ledger and evidence directory
- Gate prompts block execution until resolved

### Estimated Effort: Small–Medium (1–2 days)

---

## Phase 6 — Job Manager

**Goal:** The orchestration core. Implements the job state machine, the main execution loop, phase transitions, and escalation handling.

### 6.1. Job State Machine (`src/core/job-manager.ts`)

States (from ARCHITECTURE §7.1):

```
created → discovering → planning → plan_gated → scaffolding
  → executing → review → ship_gated → completed
```

With error states: `failed`, `cancelled`, `budget_exceeded`.

```typescript
class JobManager {
  constructor(
    sessionController: SessionController,
    policyEngine: PolicyEngine,
    gateController: GateController,
    evidenceCollector: EvidenceCollector,
    ledger: LedgerWriter
  );

  async runJob(job: JobState): Promise<JobOutcome>;
}
```

### 6.2. Job State Persistence (`status.json`)

The job's current state is written to `.nibbler/jobs/<id>/status.json` after every state transition. This enables `nibbler resume` and `nibbler status`.

```typescript
interface JobState {
  jobId: string;
  state: JobStatus;
  currentPhase: string;
  currentRole: string | null;
  branch: string;
  workspace: string;
  preSessionCommit: string | null;
  lastCommitHash: string;
  globalBudgetStart: Date;
  feedback: Map<string, Feedback[]>;
  taskStates: Map<string, TaskState>;
  // ... methods for state transitions, task tracking, budget usage
}
```

### 6.3. Main Orchestration Loop

Implements the `run_job` function from ARCHITECTURE §7.2:

1. **Discovery** — Run discovery engine (Phase 7), produce `vision.md` + `architecture.md`
2. **Planning** — Run Architect session, produce planning artifacts, validate delegation
3. **PLAN gate** — Present to PO, handle approve/reject
4. **Scaffold** — (if needed) Run Architect session to create project boilerplate
5. **Execution** — For each role in delegation order:
   - Compile context, swap overlay and permissions
   - Run session, monitor health
   - On completion: diff check, scope check, completion criteria, evidence capture
   - If valid: commit and proceed
   - If invalid: revert, feed back, retry within budget or escalate
   - Architect review after each role (if contract requires)
6. **SHIP gate** — Present to PO, handle approve/reject
7. **Completion** — Mark job as completed

### 6.4. Role Session Execution

Implements `run_role_session` from ARCHITECTURE §7.3. The retry loop:

```
while retries < budget.maxIterations:
    record pre-session state
    compile context + swap
    spawn session
    wait for completion
    stop session
    verify scope + completion
    if passed: commit, return
    if failed: revert, add feedback, retry++
escalate to Architect
```

### 6.5. Escalation Handling

Implements `escalate` and `run_architect_resolution` from ARCHITECTURE §7.4–7.5:

- **To Architect:** Compile problem context (last diff, failures, task definition), start Architect resolution session
- **To PO (EXCEPTION gate):** If Architect determines the issue requires a product decision
- **Terminate:** If escalation chain is exhausted

### Phase 6 Exit Criteria

- Job state machine transitions correctly for the happy path
- Job state is persisted to `status.json` and can be resumed
- Role session execution with retry loop works (mocked sessions)
- Scope verification failure triggers revert and retry
- Budget exhaustion triggers escalation
- Escalation to Architect starts a resolution session
- Global budget enforcement terminates the job with evidence

### Estimated Effort: Large (4–5 days)

---

## Phase 7 — Discovery Engine

**Goal:** Implement the product vision extraction flow — document ingestion, project type classification, tiered question schema, adaptive interview, and vision/architecture synthesis.

### 7.1. Document Ingestion (`src/discovery/ingestion.ts`)

```typescript
function ingestMaterials(providedFiles: string[], workspace: string): IngestedContext;
```

- Reads provided files (PRD, specs, etc.)
- Reads existing `vision.md` and `architecture.md` if present
- Scans codebase if code exists (file tree, package.json/requirements.txt, README, key directories)
- Classifies repo state: `empty` | `docs_only` | `has_code`

### 7.2. Project Type Classification (`src/discovery/classification.ts`)

```typescript
function classifyProjectType(context: IngestedContext): ProjectType | null;
```

Heuristic classification from ingested materials (keywords, file structure, dependencies). Returns `null` if classification requires asking the PO.

Types: `web-app`, `api-service`, `cli-tool`, `mobile-app`, `library`, `data-pipeline`.

### 7.3. Question Schema (`src/discovery/schema.ts`)

Data structure for the tiered question schema (ARCHITECTURE §8.2):

```typescript
interface DiscoverySchema {
  projectType: ProjectType;
  tiers: {
    tier1: QuestionSection[];   // Blocking
    tier2: QuestionSection[];   // Important
    tier3: QuestionSection[];   // Enrichment
  };
  typeModule: TypeSpecificQuestions;
}

interface QuestionSection {
  id: string;
  label: string;
  questions: Question[];
}

interface Question {
  id: string;
  ask: string;
  status: 'gap' | 'inferred' | 'confirmed' | 'answered';
  inferredAnswer?: string;
  confidence?: 'low' | 'medium' | 'high';
  answer?: string;
}
```

Functions:
- `generateSchema(projectType)` — Create the full schema for a project type
- `preFillSchema(schema, context)` — Fill in answers from ingested documents
- `getNextBatch(schema)` — Return next 2–3 questions to ask (adaptive)
- `isDiscoveryComplete(schema)` — Check if Tier 1 complete + Tier 2 sufficient

### 7.4. Type-Specific Question Modules (`src/discovery/type-modules/`)

Each module exports additional questions for its project type (PRD §5.5):

- `web-app.ts` — Authentication, multi-tenancy, responsive, real-time, SEO
- `api-service.ts` — Consumer profiles, contract style, rate limiting, versioning, SDK
- `cli-tool.ts` — Command structure, I/O model, distribution, config, shell completion
- `mobile-app.ts` — Platform targets, offline, push notifications, device capabilities
- `library.ts` — Target runtime, API surface, versioning, backward compatibility
- `data-pipeline.ts` — Sources/sinks, volume, scheduling, idempotency, monitoring

### 7.5. Discovery Session Orchestration (`src/discovery/engine.ts`)

The discovery engine mediates between the Architect session and the PO:

1. Ingest materials, classify type, generate schema, pre-fill
2. Compile discovery context for the Architect (meta-rules + schema + ingested materials)
3. Run interactive session:
   - Agent proposes questions → engine presents to PO (via CLI)
   - PO answers → engine feeds back to agent
   - Agent updates schema status
4. On schema completion: agent synthesizes `vision.md` and `architecture.md`
5. Verify outputs exist, commit

**Alternative design (simpler for v1):** Instead of an interactive agent-mediated session, the engine can directly present questions from the schema to the PO, collecting answers, and then run a single Architect session with all answers to produce the vision and architecture documents. This avoids the complexity of real-time agent-PO mediation.

**Recommendation for v1:** Implement the simpler direct-interview approach first. The engine drives the question flow using the schema; the Architect session is only used for synthesis.

### Phase 7 Exit Criteria

- Documents are ingested and project type is classified
- Question schema is generated for all project types
- Pre-filling from ingested documents works (inferred answers marked)
- Adaptive question batching works (skips answered, asks gaps)
- Discovery completes with `vision.md` and `architecture.md` produced
- All three scenarios work: nothing provided, documents provided, existing repo

### Estimated Effort: Large (4–5 days)

---

## Phase 8 — Init Bootstrap

**Goal:** Implement `nibbler init` — the bootstrap flow where the Architect proposes a governance contract and the engine validates it.

### 8.1. Project State Scanner (`src/workspace/scanner.ts`)

```typescript
function scanProjectState(workspace: string): ProjectState;
```

Returns:
- Existing contract? (update mode)
- Existing `architecture.md`?
- Existing codebase? (file tree, languages, frameworks)
- Greenfield vs. existing classification

### 8.2. Bootstrap Prompt Generation (`src/templates/bootstrap-prompt.ts`)

Generates the init session context:

1. **Constitution** — All 17 meta-rules, rendered as constraints
2. **Project context** — Scan results, existing artifacts
3. **Init mandate** — "Propose a governance contract"
4. **Examples** — Contract examples from `src/templates/contract-examples/`

### 8.3. Init Session Flow (`src/cli/commands/init.ts`)

Implements `run_init` from ARCHITECTURE §14.3:

```
1. Scan project state
2. Write bootstrap rules (temporary .cursor/rules/ for init session)
3. Start Architect session with bootstrap context
4. Wait for contract proposal (written to .nibbler/contract/)
5. Read proposed contract
6. Validate against constitution
7. If errors: loop Architect with specific error feedback
8. If valid: present summary to PO
9. PO confirms → commit contract
10. Generate Cursor permission profiles from contract
```

### 8.4. Contract Review Mode

`nibbler init --review`:
- Reads existing contract + current project state
- Runs Architect session with both as context
- Architect proposes modifications
- Engine re-validates
- PO confirms changes

### 8.5. Example Contracts (`src/templates/contract-examples/`)

Provide 2–3 example contracts for common project types. These are suggestions fed to the Architect during init, not hard templates. They demonstrate valid contract structure and reasonable defaults.

### Phase 8 Exit Criteria

- `nibbler init` runs end-to-end (with Cursor CLI)
- Architect proposes a contract that validates against the constitution
- Validation errors are fed back and the Architect corrects them
- PO can review and confirm the contract
- Contract is committed to `.nibbler/contract/`
- Cursor permission profiles are generated
- `nibbler init --review` works on an existing contract
- `nibbler init --dry-run` shows what would be created without committing

### Estimated Effort: Medium (2–3 days)

---

## Phase 9 — End-to-End Integration

**Goal:** Wire everything together into a working `nibbler build` command. Test the full pipeline from discovery through ship.

### 9.1. Build Command (`src/cli/commands/build.ts`)

Parses arguments:
- `nibbler build "requirement"` — Natural language description
- `--file <path>` — Input documents (repeatable)
- `--dry-run` — Discovery + planning only
- `--skip-discovery` — Use existing `vision.md`
- `--skip-scaffold` — Don't scaffold even if repo looks empty

Creates a new job and runs the full pipeline via `JobManager.runJob()`.

### 9.2. Integration Testing

End-to-end tests that exercise the full pipeline:

| Test | Description |
|---|---|
| Happy path (mocked) | All phases succeed with mocked Cursor sessions |
| Scope violation + retry | Worker modifies out-of-scope file → revert → retry succeeds |
| Budget exhaustion | Worker fails repeatedly → escalate to Architect |
| Gate rejection | PO rejects PLAN gate → recovery path |
| Global budget exceeded | Job runs too long → hard termination with evidence |
| Architect resolution | Worker escalates → Architect resolves → worker retries with guidance |

**Mocked Cursor sessions:** Create a `MockRunnerAdapter` that simulates Cursor CLI behavior — writes expected files, emits expected events, and can be configured to fail in specific ways.

### 9.3. Dry Run Mode

`nibbler build --dry-run` runs discovery and planning, then prints:
- The delegation plan (which roles, what tasks, what order)
- Expected artifacts
- Budget allocations
- Gates that would be encountered

This is invaluable for testing and for PO review before committing to a full run.

### Phase 9 Exit Criteria

- `nibbler build "requirement"` runs the complete pipeline end-to-end
- Happy path produces a branch with linear commit history
- Error recovery works (scope violations, budget exhaustion, gate rejections)
- Dry run mode shows the execution plan without running sessions
- Evidence and ledger are complete and correct after a full run
- The branch can be inspected and the work is traceable

### Estimated Effort: Large (4–5 days)

---

## Phase 10 — Polish & Secondary Commands

**Goal:** Implement remaining CLI commands, harden error handling, improve UX, and write documentation.

### 10.1. Fix Command (`src/cli/commands/fix.ts`)

`nibbler fix "issue"` — A streamlined build for targeted fixes:
- Skips full discovery (uses existing vision/architecture)
- Architect plans a minimal fix
- Fewer roles involved (scope-limited)
- Faster cycle

### 10.2. Status Command (`src/cli/commands/status.ts`)

`nibbler status [job-id]` — Reads `status.json` and ledger tail:
- Current phase and state
- Active role session
- Budget consumption (per-role and global)
- Last N ledger events
- Artifact summary

### 10.3. List Command (`src/cli/commands/list.ts`)

`nibbler list` — Scans `.nibbler/jobs/` for active/paused jobs:
- Job ID, state, age, description

### 10.4. History Command (`src/cli/commands/history.ts`)

`nibbler history` — Scans `.nibbler/jobs/` for completed jobs:
- Job ID, outcome, duration, evidence path

### 10.5. Resume Command (`src/cli/commands/resume.ts`)

`nibbler resume <job-id>` — Reattaches to a running or paused job:
- If paused at a gate: re-presents the gate
- If paused mid-execution: resumes from last committed state
- If running: attaches to live output

### 10.6. Error Handling Hardening

- Graceful shutdown on SIGINT/SIGTERM (evidence preservation)
- Cursor CLI crash recovery (restart session, retry)
- Network/filesystem error handling
- Corrupt ledger detection and recovery
- Partial evidence preservation on any failure path

### 10.7. UX Polish

- Progress indicators during long operations
- Clear error messages with actionable guidance
- Colorized output with consistent styling
- Verbose mode (`--verbose`) for debugging
- Quiet mode (`--quiet`) for scripting

### 10.8. Documentation

- Update `README.md` with installation, quickstart, and usage
- Inline JSDoc for all public APIs
- Example contract files with comments
- Troubleshooting guide

### Phase 10 Exit Criteria

- All CLI commands work as documented
- Error handling is robust (no unhandled exceptions, evidence always preserved)
- UX is clean and informative
- README covers installation, quickstart, all commands, and troubleshooting

### Estimated Effort: Medium–Large (3–5 days)

---

## 2. Cross-Cutting Concerns

### 2.1. Testing Strategy

| Level | Scope | Tools | Coverage Target |
|---|---|---|---|
| **Unit** | Individual functions and classes | vitest, mocks | All policy engine checks, contract validation, diff parsing, ledger operations |
| **Integration** | Multi-component interactions | vitest, temp directories, temp git repos | Session swap, context compilation + overlay generation, evidence capture pipeline |
| **End-to-End** | Full CLI commands | vitest, MockRunnerAdapter | Happy path, error recovery, all gate scenarios |
| **Manual** | Real Cursor CLI integration | Manual verification | Full build pipeline with actual Cursor sessions |

The `MockRunnerAdapter` is critical infrastructure — it simulates Cursor CLI behavior for automated testing without requiring Cursor to be installed.

### 2.2. Error Model

All errors are categorized per ARCHITECTURE §15.1:

```typescript
enum ErrorCategory {
  Recoverable,     // Retry within budget (scope violation, criteria not met)
  Escalatable,     // Route to Architect (worker budget exhausted)
  GateRequired,    // Route to PO (product decision needed)
  Terminal         // Capture evidence and stop
}
```

Every error handler converges on evidence capture. No error path silently discards state.

### 2.3. Configuration

Nibbler has minimal configuration beyond the contract:

- **Engine defaults** — Timeout for session inactivity, health check interval, retry backoff. Stored as constants with environment variable overrides.
- **No user config file** — The contract is the configuration. Engine behavior is driven by meta-rules (immutable) and the contract (Architect-proposed, PO-approved).

### 2.4. Logging

Structured logging to stderr at all levels:

```
[nibbler] INFO  job j-20260207-001 created
[nibbler] INFO  session:architect spawned (pid 12345)
[nibbler] DEBUG scope check: 5 files, 0 violations
[nibbler] WARN  budget 80% consumed for role:backend
[nibbler] ERROR session crashed: SIGKILL
```

The ledger is the authoritative record. Logs are for debugging and operational awareness.

---

## 3. Risk Mitigation

### 3.1. Cursor CLI Stability (ARCHITECTURE §21.4)

**Risk:** Cursor Agent CLI behavior changes between versions, breaking the Session Controller.

**Mitigation:**
- The Runner Adapter Interface isolates Cursor-specific behavior
- Integration tests against the real Cursor CLI run in a dedicated test suite (not CI)
- Version-pin Cursor CLI in development instructions
- The event protocol fallback (timeout-based completion) provides resilience against event emission failures

### 3.2. Event Protocol Reliability (ARCHITECTURE §21.2)

**Risk:** LLMs don't consistently emit `NIBBLER_EVENT` lines.

**Mitigation:**
- The protocol is defined in `00-nibbler-protocol.mdc` which is always in the agent's context
- Fallback: timeout-based completion detection (configurable, default 60s of inactivity)
- The overlay explicitly instructs the agent to emit events
- Post-session verification doesn't depend on events — it uses git diff and command execution

### 3.3. Contract Format (ARCHITECTURE §21.3)

**Risk:** YAML is too rigid or too flexible for contracts.

**Mitigation:**
- v1 ships with YAML and Zod validation, which gives clear error messages
- The Contract Reader is an abstraction — swapping to TOML, JSON, or a custom format requires changing only the reader implementation
- Example contracts provide clear structure for the Architect to follow

### 3.4. Context Window Limits

**Risk:** Large projects produce overlays that exceed Cursor's context window.

**Mitigation:**
- The overlay is the compressed summary, not the full content — it references files, doesn't include them
- Focus guidance tells the agent what to read, not what to know
- For large projects, the Architect's planning phase can decompose work into smaller tasks with tighter focus

---

## 4. Dependency Graph

```
Phase 0: Project Bootstrap
    │
    ▼
Phase 1: Foundation Layer
    │  (git ops, ledger, evidence, workspace)
    │
    ├──────────┐
    ▼          ▼
Phase 2    Phase 1 tests
(Contract)
    │
    ▼
Phase 3: Policy Engine
    │  (uses contract types + git ops)
    │
    ├──────────┐
    ▼          ▼
Phase 4    Phase 5
(Session)  (Gates)
    │          │
    └────┬─────┘
         ▼
    Phase 6: Job Manager
         │  (orchestrates sessions, policies, gates)
         │
    ├────┴────┐
    ▼         ▼
Phase 7   Phase 8
(Discovery) (Init)
    │         │
    └────┬────┘
         ▼
    Phase 9: End-to-End Integration
         │
         ▼
    Phase 10: Polish & Secondary Commands
```

Phases 4 and 5 can be developed in parallel. Phases 7 and 8 can be developed in parallel. All other phases are sequential.

---

## 5. Estimated Timeline

| Phase | Duration | Cumulative |
|---|---|---|
| Phase 0: Bootstrap | 1 day | 1 day |
| Phase 1: Foundation | 2–3 days | 3–4 days |
| Phase 2: Contract | 2–3 days | 5–7 days |
| Phase 3: Policy Engine | 2–3 days | 7–10 days |
| Phase 4 + 5: Session + Gates (parallel) | 4–5 days | 11–15 days |
| Phase 6: Job Manager | 4–5 days | 15–20 days |
| Phase 7 + 8: Discovery + Init (parallel) | 4–5 days | 19–25 days |
| Phase 9: Integration | 4–5 days | 23–30 days |
| Phase 10: Polish | 3–5 days | 26–35 days |

**Total estimate: 4–5 weeks** for a feature-complete v1, assuming a single developer working full-time.

---

## 6. Definition of Done — v1

A feature-complete v1 means:

1. **`nibbler init`** produces a validated governance contract via Architect session
2. **`nibbler build`** runs the full pipeline: discovery → planning → scaffold → execution → ship
3. **All 17 meta-rules** are enforced at contract validation and runtime
4. **PO gates** (PLAN, SHIP, EXCEPTION) work interactively via CLI
5. **Scope enforcement** via post-hoc diff analysis with revert + retry
6. **Budget enforcement** per-session and global with escalation
7. **Evidence collection** captures diffs, verification outputs, gate resolutions
8. **Append-only ledger** records all decisions and state transitions
9. **Error recovery** handles scope violations, budget exhaustion, session crashes, and gate rejections
10. **Secondary commands** (`fix`, `status`, `list`, `history`, `resume`) are functional
11. **Tests** cover the policy engine, contract validation, and the orchestration loop
12. **Documentation** covers installation, quickstart, and all commands

---

## 7. What's Intentionally Deferred (Post-v1)

| Item | Rationale |
|---|---|
| Alternative runner adapters (Claude Code, Aider) | v1 targets Cursor only; interface is ready for extension |
| Plugin/hooks system | Future integration with CI, notifications, PM tools |
| Cost tracking as a budget dimension | Depends on Cursor CLI exposing token/cost data |
| Web UI for gate interaction | CLI-first; web UI is a future enhancement |
| Multi-project contract templates | Ship with examples, not a template marketplace |
| Contract format alternatives | YAML is sufficient for v1; reader abstraction allows future formats |
| Parallel session execution | Deliberately deferred per the PRD; sequential is the design choice |
| Remote/distributed execution | Nibbler is local-first by design |
