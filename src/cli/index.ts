import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runInitCommand } from './commands/init.js';
import { runBuildCommand } from './commands/build.js';
import { runFixCommand } from './commands/fix.js';
import { runStatusCommand } from './commands/status.js';
import { runListCommand } from './commands/list.js';
import { runHistoryCommand } from './commands/history.js';
import { runResumeCommand } from './commands/resume.js';
import { createRenderer, getRenderer } from './ui/renderer.js';

export function buildCli(argv: string[]) {
  const program = new Command();

  let globalFlags: { verbose: boolean; quiet: boolean } = { verbose: false, quiet: false };

  const version = detectVersionSync() ?? '0.0.0';

  program
    .name('nibbler')
    .description('Constitutional AI orchestration — govern multi-agent workflows with deterministic guardrails')
    .version(version, '-v, --version');

  program
    .option('--verbose', 'Show debug output')
    .option('--quiet', 'Machine-friendly output (no formatting)');

  program.hook('preAction', (thisCommand) => {
    const o = thisCommand.opts() as any;
    globalFlags = { verbose: !!o.verbose, quiet: !!o.quiet };
    process.env.NIBBLER_VERBOSE = globalFlags.verbose ? '1' : '0';
    process.env.NIBBLER_QUIET = globalFlags.quiet ? '1' : '0';
    createRenderer({ quiet: globalFlags.quiet });
  });

  // ── Primary Commands (Workflow) ──────────────────────────────────────────

  program
    .command('init')
    .description('Generate or review the governance contract')
    .option('--file <path>', 'Input document for discovery (repeatable)', collectRepeatable, [])
    .option('--review', 'Review/update an existing contract')
    .option('--skip-discovery', 'Skip discovery (use existing vision.md + architecture.md)')
    .option('--dry-run', 'Validate without writing contract/committing')
    .action(async (opts: { file: string[]; review?: boolean; skipDiscovery?: boolean; dryRun?: boolean }) => {
      const res = await runInitCommand({
        review: !!opts.review,
        dryRun: !!opts.dryRun,
        skipDiscovery: !!opts.skipDiscovery,
        files: opts.file ?? [],
      });
      if (!res.ok) {
        if ((res.errors as any)?.reason === 'cancelled') {
          const r = getRenderer();
          r.warn('Cancelled.');
          process.exitCode = 130;
          return;
        }
        const r = getRenderer();
        r.error(
          'Init failed',
          String(res.errors ?? 'unknown error'),
          'Try running with --verbose for more details.',
        );
        process.exitCode = 1;
      }
    });

  program
    .command('build')
    .description('Run a full job: plan → execute → ship')
    .argument('[requirement]', 'Requirement string')
    .option('--file <path>', 'Input document (repeatable)', collectRepeatable, [])
    .option('--dry-run', 'Planning only (prints plan)')
    .option('--skip-scaffold', 'Skip scaffolding even if repo appears empty')
    .action(async (requirement: string | undefined, opts: { file: string[]; dryRun?: boolean; skipScaffold?: boolean }) => {
      const res = await runBuildCommand({
        requirement,
        files: opts.file ?? [],
        dryRun: !!opts.dryRun,
        skipScaffold: !!opts.skipScaffold,
      });
      if (!res.ok) {
        if ((res.details as any)?.reason === 'cancelled') {
          const r = getRenderer();
          r.warn('Cancelled.');
          process.exitCode = 130;
          return;
        }
        const r = getRenderer();
        r.error(
          'Build failed',
          String(res.details ?? 'unknown error'),
          'Check the evidence directory for details, or run with --verbose.',
        );
        process.exitCode = 1;
        return;
      }
      if (!globalFlags.quiet) {
        const r = getRenderer();
        r.success(`Build complete: job ${res.jobId}`);
      }
    });

  program
    .command('fix')
    .description('Run a targeted fix job')
    .argument('<issue>', 'Issue description')
    .option('--file <path>', 'Supporting document (repeatable)', collectRepeatable, [])
    .option('--scope <role>', "Limit fix to a specific role's scope")
    .action(async (issue: string, opts: { file: string[]; scope?: string }) => {
      const res = await runFixCommand({ issue, files: opts.file ?? [], scopeRole: opts.scope });
      if (!res.ok) {
        if ((res.details as any)?.reason === 'cancelled') {
          const r = getRenderer();
          r.warn('Cancelled.');
          process.exitCode = 130;
          return;
        }
        const r = getRenderer();
        r.error(
          'Fix failed',
          String(res.details ?? 'unknown error'),
          'Check the evidence directory for details, or run with --verbose.',
        );
        process.exitCode = 1;
        return;
      }
      if (!globalFlags.quiet) {
        const r = getRenderer();
        r.success(`Fix complete: job ${res.jobId}`);
      }
    });

  // ── Observability Commands ───────────────────────────────────────────────

  program
    .command('status')
    .description('Show current job state')
    .argument('[job-id]', 'Job id (defaults to latest)')
    .option('--tail <n>', 'Ledger tail entries', (v) => Number(v), 10)
    .action(async (jobId: string | undefined, opts: { tail?: number }) => {
      const res = await runStatusCommand({ jobId, tail: opts.tail });
      if (!res.ok) {
        const r = getRenderer();
        r.error('Status failed', String(res.details ?? 'unknown error'));
        process.exitCode = 1;
      }
    });

  program
    .command('list')
    .description('List active jobs')
    .action(async () => {
      const res = await runListCommand({});
      if (!res.ok) {
        const r = getRenderer();
        r.error('List failed', String(res.details ?? 'unknown error'));
        process.exitCode = 1;
      }
    });

  program
    .command('history')
    .description('Show completed jobs')
    .option('--detail <job-id>', 'Print full ledger for a job')
    .action(async (opts: { detail?: string }) => {
      const res = await runHistoryCommand({ detailJobId: opts.detail });
      if (!res.ok) {
        const r = getRenderer();
        r.error('History failed', String(res.details ?? 'unknown error'));
        process.exitCode = 1;
      }
    });

  program
    .command('resume')
    .description('Reattach to a running or paused job')
    .argument('<job-id>', 'Job id')
    .action(async (jobId: string) => {
      const res = await runResumeCommand({ jobId });
      if (!res.ok) {
        if ((res.details as any)?.reason === 'cancelled') {
          const r = getRenderer();
          r.warn('Cancelled.');
          process.exitCode = 130;
          return;
        }
        const r = getRenderer();
        r.error(
          'Resume failed',
          String(res.details ?? 'unknown error'),
          'Use `nibbler status <job-id>` to inspect the job state.',
        );
        process.exitCode = 1;
      }
    });

  program.parse(argv);
}

buildCli(process.argv);

function detectVersionSync(): string | null {
  try {
    const startDir = dirname(fileURLToPath(import.meta.url));

    let current = startDir;
    for (let i = 0; i < 8; i++) {
      const candidate = resolve(current, 'package.json');
      if (existsSync(candidate)) {
        const content = readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(content) as { version?: unknown };
        return typeof parsed.version === 'string' ? parsed.version : null;
      }
      const parent = resolve(current, '..');
      if (parent === current) break;
      current = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}
