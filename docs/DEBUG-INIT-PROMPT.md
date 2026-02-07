# Debug: `nibbler init` not working properly

## Problem Statement

Running `nibbler init` in a target project (`/home/buger/workspace/todo-sample`) that contains `PRD.md` and `ARCHITECTURE.md` (both describing a React/Next.js web app called "FocusFlow") results in:

1. **Generic team**: The Architect proposes only `architect` + `worker` roles instead of specialized roles (e.g., `frontend`, `backend`, `sdet`)
2. **Possible session failures**: Contract validation may fail, or the Architect session may not complete correctly

The target repo (`/home/buger/workspace/todo-sample`) contains:
- `PRD.md` — FocusFlow: a React/Next.js + Tailwind CSS + Supabase task management web app
- `ARCHITECTURE.md` — Full architecture doc (Next.js, Zustand, Tailwind, Supabase with auth/realtime/database)
- No `package.json`, no `src/` dir — this is a docs-only greenfield project
- `.cursor/rules/00-nibbler-protocol.mdc` — Protocol rule (emit NIBBLER_EVENT on completion)

## How `nibbler init` works (end-to-end flow)

### 1. Workspace scan (`src/workspace/scanner.ts`)
- `scanProjectState(repoRoot)` detects top-level files case-insensitively (architecture.md/ARCHITECTURE.md, vision.md/VISION.md, prd.md/PRD.md)
- Calls `classifyProject(repoRoot)` which runs `ingestMaterials()` → `classifyProjectTypeDetailed()` → `detectTraits()`
- Returns a `ProjectState` with `projectType`, `traits`, `classificationConfidence`, `classificationReasons`

### 2. Bootstrap prompt (`src/templates/bootstrap-prompt.ts`)
- `renderInitBootstrapPrompt()` builds a long markdown prompt for the Architect
- Includes: mission, constitutional constraints, project context, project classification, doc-reading instructions, example contracts, output requirements
- Instructs the Architect to: read the project docs, classify the project, propose specialized roles (NOT generic "worker"), write two YAML files to a staging dir

### 3. Cursor Agent CLI session (`src/cli/commands/init.ts` + `src/core/session/cursor-adapter.ts`)
- Creates a staging dir: `.nibbler-staging/contract/`
- Writes a permissions config to `.nibbler/config/cursor-profiles/init/cli-config.json`
- Writes the bootstrap prompt as a `.cursor/rules/20-role-architect.mdc` overlay
- Spawns the Cursor Agent CLI: `agent --print --force --output-format stream-json`
  - `cwd` = workspace root (the target project)
  - `CURSOR_CONFIG_DIR` = the init config dir
  - stdin receives the bootstrap prompt, then stdin is closed
- Waits for a `NIBBLER_EVENT` (parsed from stdout NDJSON) signaling completion
- Stops the process

### 4. Contract validation (`src/core/contract/validator.ts`)
- Reads `team.yaml` + `phases.yaml` from the staging dir
- Validates against 17 constitutional meta-rules (scope, budget, phases DAG, gates, etc.)
- If invalid → feedback loop (up to 10 attempts): error is appended to the prompt and Architect retries

### 5. Commit
- Writes contract to `.nibbler/contract/`
- Writes `project-profile.yaml` with classification results
- Generates permissions profiles for each role
- Git commits

## Key files to investigate

All paths relative to `/home/buger/workspace/nibbler/`:

| File | Purpose |
|------|---------|
| `src/cli/commands/init.ts` | Init command orchestration (the main loop) |
| `src/core/session/cursor-adapter.ts` | Spawns `agent` CLI, sends prompt via stdin, reads NDJSON events from stdout |
| `src/core/session/event-parser.ts` | Parses `NIBBLER_EVENT {...}` lines from agent output |
| `src/templates/bootstrap-prompt.ts` | Builds the Architect's instructions |
| `src/templates/contract-examples/index.ts` | Example contracts given to the Architect (all use generic "worker" — this is a problem) |
| `src/workspace/scanner.ts` | Workspace scanning + project classification |
| `src/discovery/ingestion.ts` | Reads project docs (case-insensitive: architecture.md, ARCHITECTURE.md, PRD.md, etc.) |
| `src/discovery/classification.ts` | Score-based project type detection from doc keywords |
| `src/discovery/traits.ts` | Trait detection (auth, database, realtime, etc.) from docs |
| `src/core/contract/types.ts` | Zod schema for Contract (roles, phases, gates, budget, etc.) |
| `src/core/contract/validator.ts` | Validates contract against constitutional meta-rules |
| `src/core/contract/reader.ts` | Reads team.yaml + phases.yaml into a Contract object |

## Cursor Agent CLI details

Binary: `/home/buger/.local/bin/agent` (version `2026.01.28-fd13201`)

Key flags used by nibbler:
```
agent --print --force --output-format stream-json
```

- `--print`: Non-interactive, reads prompt from stdin, outputs to stdout
- `--force`: Force allow commands unless explicitly denied
- `--output-format stream-json`: NDJSON output where each line is a JSON object
- `--plan`: Available but only used for build plan sessions, NOT for init
- `--workspace <path>`: NOT used (nibbler uses `cwd` instead)

Environment variables set:
- `CURSOR_CONFIG_DIR` = `.nibbler/config/cursor-profiles/init/` — May or may not be recognized by the agent binary. This needs verification.

The agent writes its own runtime state (model config, statsig data, chat history) into the config dir, which is why `cli-config.json` balloons from ~200 bytes to ~198KB.

## Permissions config written by nibbler for init sessions

```json
{
  "version": 1,
  "editor": { "vimMode": false },
  "permissions": {
    "allow": ["Read(**/*)", "Write(.nibbler-staging/**)"],
    "deny": ["Write(.nibbler/**)", "Write(.cursor/**)", "Read(.env*)", "Read(**/.env*)", "Write(**/*.key)"]
  }
}
```

The Architect can read all files but can only write to `.nibbler-staging/**`. The contract YAML files must be written to `.nibbler-staging/contract/team.yaml` and `.nibbler-staging/contract/phases.yaml`.

## Event protocol

The Architect must emit exactly this line (in stdout or within NDJSON text content) when done:
```
NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"init contract proposed"}
```

Nibbler's event parser (`src/core/session/event-parser.ts`) scans every stdout line for the `NIBBLER_EVENT ` prefix. It also extracts text from NDJSON `{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}` envelopes and scans those.

If the agent never emits this event, `waitForInitCompletion()` hangs until the agent process exits (which it does when stdin closes and processing completes).

## Contract schema (what the Architect must produce)

### team.yaml
```yaml
roles:
  - id: <string>           # Role identifier (e.g., "architect", "frontend", "backend")
    scope: [<glob>...]      # File patterns this role can touch
    authority:
      allowedCommands: [<string>...]
      allowedPaths: [<string>...]
    outputExpectations: [<string>...]
    verificationMethod:
      kind: "none" | "command" | "script"
      command: <string>     # optional
    budget:
      maxIterations: <int>
      exhaustionEscalation: <string>  # REQUIRED: "architect", "exception_gate", etc.
sharedScopes:
  - roles: [<string>, <string>...]  # min 2
    patterns: [<glob>...]
escalationChain: []
```

### phases.yaml
```yaml
phases:
  - id: <string>
    preconditions: [{ type: "always" }]
    actors: [<roleId>...]         # min 1
    inputBoundaries: [<glob>...]   # min 1
    outputBoundaries: [<glob>...]  # min 1
    completionCriteria:            # min 1
      - type: "artifact_exists" | "command_succeeds" | "diff_non_empty" | ...
        pattern: <string>          # for artifact_exists
    successors: [{ on: "done", next: "<phaseId>" }]
    isTerminal: true               # exactly one phase must be terminal
gates:
  - id: <string>
    trigger: "<phase>-><phase>"
    audience: "PO"                 # at least one PO gate required
    requiredInputs: [{ name: <string>, kind: "path", value: <string> }]
    outcomes: { approve: "<phase>", reject: "<phase>" }  # BOTH required
globalLifetime:
  maxTimeMs: <int>                 # REQUIRED
```

## Common validation failures

These are the constitutional rules most frequently violated by the Architect:

| Rule | Issue | Fix |
|------|-------|-----|
| 1.3 | Overlapping scopes without `sharedScopes` declaration | Add `sharedScopes` entry for any pair of roles with overlapping glob patterns |
| 3.3 | Phase graph has no terminal phase | Set `isTerminal: true` on the last phase |
| 3.3 | Successor references unknown phase | Check phase IDs match |
| 3.4 | Gate missing `approve` or `reject` outcome | Both keys required in `outcomes` |
| 4.2 | Budget has no `exhaustionEscalation` | Add `exhaustionEscalation` to every role's budget |
| 5.3 | Scope includes protected path `.nibbler/**` or `.cursor/rules/00-nibbler-protocol.mdc` | Exclude these from all scopes |
| 5.5 | No PO gate | At least one gate must have `audience: "PO"` |

## Known issue: example contracts use generic "worker" role

The example contracts in `src/templates/contract-examples/index.ts` all use `architect` + `worker`. The bootstrap prompt tells the Architect "NEVER use generic role IDs like 'worker'" but the examples contradict this. The Architect tends to copy the examples. Consider updating the examples to use specialized roles, or adding a stronger caveat about examples being generic templates.

## Debugging steps

1. **Check if classification works**: Run `nibbler init --verbose` and observe the scan output. It should show:
   ```
   architecture.md:  found
   PRD.md:           found
   Project type:     web-app
   Traits:           auth, database, realtime, search
   Mode: Existing project initialization
   ```
   If these are wrong, the bug is in `scanner.ts` / `ingestion.ts` / `classification.ts`.

2. **Check if the Architect session starts**: The spinner should say "Generating contract..." and eventually succeed or fail. If it hangs indefinitely, the `agent` binary may not be emitting the `NIBBLER_EVENT`. Enable session logging by setting `NIBBLER_SESSION_LOG_PATH` env var in the spawn.

3. **Check what the Architect produces**: Look at `.nibbler-staging/contract/team.yaml` and `phases.yaml` after a run. If these don't exist, the Architect didn't write them (permissions issue or prompt wasn't followed).

4. **Check validation errors**: If the spinner says "Contract validation failed", look at `.nibbler-staging/init-feedback.txt` for the exact errors.

5. **Check the overlay written to disk**: Read `.cursor/rules/20-role-architect.mdc` in the target project to see what instructions the Architect actually received.

6. **Test the agent binary directly**: Run a minimal agent session to verify the binary works:
   ```bash
   cd /home/buger/workspace/todo-sample
   echo 'Read PRD.md and ARCHITECTURE.md. Then write a file called /tmp/test-output.txt with one line: "hello". When done, print: NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"test"}' | agent --print --force --output-format stream-json
   ```
   This should produce NDJSON output containing the event. If it doesn't work, the agent CLI integration is broken.

7. **Check CURSOR_CONFIG_DIR**: The nibbler code sets `CURSOR_CONFIG_DIR` as an env var. Verify the agent binary actually respects this. If not, the permissions config is ignored and the agent may use its default config instead. Try checking agent docs or source for the correct env var name.

8. **Check if stdin prompt delivery works**: The `send()` method writes the prompt to the agent's stdin and closes it. Some agent versions may expect the prompt as a CLI argument instead. Try:
   ```bash
   cd /home/buger/workspace/todo-sample
   agent --print --force --output-format stream-json "Say hello and then print: NIBBLER_EVENT {\"type\":\"PHASE_COMPLETE\",\"summary\":\"test\"}"
   ```
   Compare with the stdin approach to see which one actually works.

## What needs to happen for a successful init

1. Scanner detects `ARCHITECTURE.md` (found) + `PRD.md` (found) → classifies as `web-app` with traits `auth, database, realtime, search`
2. Bootstrap prompt tells Architect to read the docs and propose specialized roles
3. Agent CLI spawns correctly, receives the prompt, and can read/write files
4. Architect reads PRD.md and ARCHITECTURE.md, proposes e.g. `architect` + `frontend` + `sdet` (or similar specialized roles)
5. Architect writes `team.yaml` + `phases.yaml` to `.nibbler-staging/contract/`
6. Architect emits `NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"init contract proposed"}`
7. Nibbler validates the contract — passes all constitutional rules
8. User approves → contract committed to `.nibbler/contract/`
