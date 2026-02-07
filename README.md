# nibbler

Nibbler is a TypeScript CLI that orchestrates Cursor Agent sessions to run a governed “job” over your repo (discovery → planning → execution → ship), with an append-only ledger and evidence capture.

## Install / build

```bash
npm install
npm run build
```

Run the CLI in dev mode:

```bash
npm run dev -- --help
```

Or run the built binary:

```bash
node dist/cli.js --help
```

## Quickstart

1) Initialize the governance contract:

```bash
nibbler init
```

2) Run a full job:

```bash
nibbler build "Implement feature X"
```

3) Run a targeted fix using existing `vision.md` + `architecture.md`:

```bash
nibbler fix "Bug: login redirect loop"
```

## Commands

### `nibbler init [options]`

Generates or reviews the governance contract under `.nibbler/contract/`.

- `--review`: re-evaluate/update an existing contract
- `--dry-run`: validate without writing contract/committing

### `nibbler build "<requirement>" [options]`

Runs a full job (contract-defined phase graph).

- `--file <path>`: supporting documents (repeatable)
- `--dry-run`: prints execution plan only (no sessions)
- `--skip-discovery`: skip running discovery engine hooks
- `--skip-scaffold`: reserved for future scaffold logic

### `nibbler fix "<issue>" [options]`

Runs a targeted fix job.

- `--file <path>`: supporting documents (repeatable). Copied into `.nibbler-staging/fix-inputs/<job-id>/` so agents can read them.
- `--scope <role>`: limit execution phases to a single role (when that role is present in a phase’s actor list)

### `nibbler status [job-id] [options]`

Shows current job phase/state + budgets + ledger tail.

- `--tail <n>`: number of ledger entries to print (default 10)

### `nibbler list`

Lists active/paused jobs found under `.nibbler/jobs/`.

### `nibbler history [--detail <job-id>]`

Lists completed jobs (and optionally prints the full ledger for a job).

### `nibbler resume <job-id>`

Reattaches to a running job if `engine_pid` is alive, otherwise restarts orchestration from the persisted checkpoint in `status.json`.

## Artifacts

Each job writes:

- **Status**: `.nibbler/jobs/<job-id>/status.json`
- **Ledger** (append-only): `.nibbler/jobs/<job-id>/ledger.jsonl`
- **Evidence**: `.nibbler/jobs/<job-id>/evidence/` (diffs, checks, commands, gates, final state, session logs)

## Global flags

- `--verbose`: more detailed error output (JSON)
- `--quiet`: suppress non-essential success messages (scripting)

## Troubleshooting

### Cursor agent binary not found

Nibbler defaults to running `agent`. If your system uses a different binary, set:

```bash
export NIBBLER_CURSOR_BINARY=cursor
```

### “Working tree is not clean”

For safety and traceability, `build/fix/resume` require a clean git working tree. Commit or stash your changes first.

### Ledger integrity warnings

If `nibbler status` warns about ledger integrity, the ledger may contain a partial/garbled line (e.g. crash mid-write). Nibbler will still read valid entries, but sequence gaps indicate corruption.

### Resume limitations

`nibbler resume` can restart from the last persisted phase + actor index in `status.json`. If the repo is dirty or the contract changed significantly since the job started, resume may fail.

## Contract examples

See `docs/contracts/` for commented examples.
