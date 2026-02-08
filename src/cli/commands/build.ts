import { mkdir, readdir, stat, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { EvidenceCollector } from '../../core/evidence/collector.js';
import { GateController } from '../../core/gate/controller.js';
import { JobManager } from '../../core/job-manager.js';
import { LedgerWriter } from '../../core/ledger/writer.js';
import { SessionController } from '../../core/session/controller.js';
import { CursorRunnerAdapter } from '../../core/session/cursor-adapter.js';
import type { RunnerAdapter } from '../../core/session/runner.js';
import { readContract } from '../../core/contract/reader.js';
import type { Contract } from '../../core/contract/types.js';
import { JobIdGenerator } from '../../utils/id.js';
import { fileExists, readText } from '../../utils/fs.js';
import { createBranch, getCurrentBranch, git, isClean } from '../../git/operations.js';
import { initJob, initWorkspace } from '../../workspace/layout.js';
import type { JobState } from '../../core/job/types.js';
import { getRenderer } from '../ui/renderer.js';
import { theme } from '../ui/theme.js';
import { roleLabel } from '../ui/format.js';
import type { SpinnerHandle } from '../ui/spinner.js';
import { installCliCancellation } from '../cancel.js';

export interface BuildCommandOptions {
  repoRoot?: string;
  requirement?: string;
  files?: string[];
  dryRun?: boolean;
  skipScaffold?: boolean;
  runner?: RunnerAdapter;
  startedAtIso?: string;
}

export async function runBuildCommand(opts: BuildCommandOptions): Promise<{ ok: boolean; jobId?: string; details?: unknown }> {
  const r = getRenderer();
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const requirement = opts.requirement?.trim() || '';
  const _providedFiles = (opts.files ?? []).map((p) => resolve(p));

  const jobId = new JobIdGenerator().next(new Date());

  // ── Pre-flight checks ────────────────────────────────────────────────────
  const repo = git(repoRoot);
  if (!(await isClean(repo))) {
    return { ok: false, details: 'Working tree is not clean. Commit/stash changes before running nibbler build.' };
  }

  const contract = await safeReadContract(join(repoRoot, '.nibbler', 'contract'));
  if (!contract) return { ok: false, details: 'No contract found. Run `nibbler init` first.' };
  const gitignoreOk = await hasRequiredGitignore(repoRoot);
  if (!gitignoreOk) return { ok: false, details: 'Missing .gitignore entries. Run `nibbler init` (it writes required ignores).' };

  // Discovery is now performed during `nibbler init`. Build requires these artifacts.
  const hasVision = await fileExists(join(repoRoot, 'vision.md'));
  const hasArchitecture = await fileExists(join(repoRoot, 'architecture.md'));
  if (!hasVision || !hasArchitecture) {
    return {
      ok: false,
      details: `Missing required artifacts: ${!hasVision ? 'vision.md ' : ''}${!hasArchitecture ? 'architecture.md' : ''}. Run \`nibbler init\` first.`,
    };
  }

  // ── Dry-run mode ─────────────────────────────────────────────────────────
  if (opts.dryRun) {
    r.phaseBanner('Dry Run');
    summarizeContractPath(contract);
    return { ok: true, jobId, details: { dryRun: true } };
  }

  // ── Set up job ───────────────────────────────────────────────────────────
  const branchSpinner = r.spinner(`Creating branch nibbler/job-${jobId}...`);
  await createBranch(repo, `nibbler/job-${jobId}`);
  branchSpinner.succeed(`Branch nibbler/job-${jobId}`);

  await initWorkspace(repoRoot);
  const jobPaths = await initJob(repoRoot, jobId);

  const evidence = new EvidenceCollector({
    evidenceDir: jobPaths.evidenceDir,
    diffsDir: jobPaths.evidenceDiffsDir,
    checksDir: jobPaths.evidenceChecksDir,
    commandsDir: jobPaths.evidenceCommandsDir,
    gatesDir: jobPaths.evidenceGatesDir,
  });
  const ledger = await LedgerWriter.open(jobPaths.ledgerPath);
  const gates = new GateController(ledger, evidence);

  const runner = opts.runner ?? new CursorRunnerAdapter();
  const sessions = new SessionController(runner, repoRoot, { inactivityTimeoutMs: 120_000 });

  const jobStartTime = Date.now();
  const job: JobState = {
    repoRoot,
    jobId,
    mode: 'build' as const,
    description: requirement,
    currentPhaseId: contract.phases[0]?.id ?? 'start',
    startedAtIso: opts.startedAtIso ?? process.env.NIBBLER_TEST_STARTED_AT_ISO ?? new Date().toISOString(),
    enginePid: process.pid,
    globalBudgetLimitMs: contract.globalLifetime.maxTimeMs,
    statusPath: jobPaths.statusPath,
  };

  if (requirement) {
    r.blank();
    r.dim(`Requirement: "${requirement}"`);
  }

  // ── Engine hooks: orchestration + rendering ──────────────────────────────
  // Keep a single live spinner for the currently active role attempt.
  // This creates the “premium CLI” feel during long agent waits.
  let activeRoleSpinner: SpinnerHandle | null = null;
  let activeRoleId: string | null = null;

  const stopActiveRoleSpinner = (roleId: string, ok: boolean) => {
    if (!activeRoleSpinner || activeRoleId !== roleId) return;
    const prefix = roleLabel(roleId);
    if (ok) activeRoleSpinner.succeed(`${prefix}Session complete`);
    else activeRoleSpinner.fail(`${prefix}Session needs revision`);
    activeRoleSpinner = null;
    activeRoleId = null;
  };

  const jm = new JobManager(sessions, gates, evidence, ledger, {
    onPhaseEnter: async ({ phaseId }) => {
      r.phaseBanner(phaseId);
    },

    beforeVerifyCompletion: async ({ job: j, roleId }) => {
      if (j.currentPhaseId === 'planning' && roleId === 'architect') {
        const staged = join(repoRoot, '.nibbler-staging', 'plan', jobId);
        await copyDirIfExists(staged, jobPaths.planDir);
      }
    },

    // ── Rendering hooks ──────────────────────────────────────────────────
    onRoleStart: ({ roleId, attempt, maxAttempts }) => {
      // If a previous spinner is still active (unexpected), stop it cleanly.
      activeRoleSpinner?.stop();
      activeRoleId = roleId;
      activeRoleSpinner = r.spinner(`${roleLabel(roleId)}Starting session (attempt ${attempt}/${maxAttempts})...`);
    },

    onRoleComplete: ({ roleId, durationMs, diff }) => {
      const fileCount = diff.summary.filesChanged;
      const lines = diff.summary.additions + diff.summary.deletions;
      r.roleComplete(roleId, `${fileCount} file${fileCount !== 1 ? 's' : ''} changed (${lines} lines)`, durationMs);
    },

    onVerification: ({ roleId, scopePassed, completionPassed, scopeViolations, diff }) => {
      stopActiveRoleSpinner(roleId, scopePassed && completionPassed);

      r.verificationStart(roleId);
      r.verificationResult(roleId, [
        {
          name: 'Scope check',
          passed: scopePassed,
          detail: scopePassed
            ? `${diff.summary.filesChanged} files, 0 violations`
            : `${scopeViolations?.length ?? 0} violation(s)`,
        },
        {
          name: 'Completion',
          passed: completionPassed,
          detail: completionPassed ? 'all criteria met' : 'criteria not met',
        },
      ]);
    },

    onRoleReverted: ({ roleId, scopePassed, completionPassed }) => {
      if (!scopePassed) {
        r.roleMessage(roleId, `${theme.warning('Reverted')} — scope violation. Retrying with feedback...`);
      } else if (!completionPassed) {
        r.roleMessage(roleId, `${theme.warning('Reverted')} — completion criteria not met. Retrying...`);
      }
    },

    onEscalation: ({ roleId, reason }) => {
      stopActiveRoleSpinner(roleId, false);
      r.roleEscalation(roleId, reason);
    },

    onHandoff: ({ fromRole, toRole }) => {
      r.handoff(fromRole, toRole);
    },
  });

  // ── Run ──────────────────────────────────────────────────────────────────
  const cancellation = installCliCancellation({
    onCancel: async ({ signal }) => {
      r.warn('Cancelling job...');
      await jm.cancel(job, { signal, reason: 'signal' });
    },
  });
  try {
    const out = await jm.runContractJob(job, contract);
    if (out.ok) {
      // ── Completion summary ───────────────────────────────────────────────
      const durationMs = Date.now() - jobStartTime;
      const branch = await getCurrentBranch(repo).catch(() => `nibbler/job-${jobId}`);

      r.jobComplete({
        jobId,
        durationMs,
        roles: job.rolesCompleted ?? [],
        commits: (job.rolesCompleted ?? []).length,
        filesChanged: job.lastDiff?.summary.filesChanged ?? 0,
        linesAdded: job.lastDiff?.summary.additions ?? 0,
        linesRemoved: job.lastDiff?.summary.deletions ?? 0,
        branch,
        evidencePath: `.nibbler/jobs/${jobId}/evidence/`,
        ledgerPath: `.nibbler/jobs/${jobId}/ledger.jsonl`,
      });
      return { ok: true, jobId };
    }
    return { ok: false, jobId, details: out };
  } finally {
    cancellation.dispose();
  }
}

// ── Dry-run summary ─────────────────────────────────────────────────────────

function summarizeContractPath(contract: Contract): void {
  const r = getRenderer();

  r.text('');
  r.text(theme.bold('  Execution Plan'));
  r.text('');

  for (const role of contract.roles) {
    const color = theme.role(role.id);
    r.text(`  ${color(theme.bold(role.id.padEnd(14)))}scope: ${theme.dim(role.scope.join(', '))}`);
  }

  r.text('');
  r.text(theme.bold('  Phases'));
  for (const p of contract.phases) {
    const terminal = p.isTerminal ? theme.dim(' (terminal)') : '';
    r.text(`  ${theme.dim('•')} ${p.id}: actors=[${p.actors.join(', ')}]${terminal}`);
    for (const s of p.successors ?? []) {
      r.text(`    ${theme.arrow} on=${s.on} next=${s.next}`);
    }
  }

  if (contract.gates.length) {
    r.text('');
    r.text(theme.bold('  Gates'));
    for (const g of contract.gates) {
      r.text(`  ${theme.dim('•')} ${g.id}: trigger=${g.trigger} audience=${String(g.audience)}`);
    }
  }

  r.text('');
}

// ── Internal Helpers ────────────────────────────────────────────────────────

async function hasRequiredGitignore(repoRoot: string): Promise<boolean> {
  const p = join(repoRoot, '.gitignore');
  const desired = ['.nibbler/jobs/', '.nibbler-staging/', '.cursor/rules/20-role-*.mdc'];
  const exists = await fileExists(p);
  if (!exists) return false;
  const current = await readText(p);
  const lines = new Set(current.split('\n').map((l) => l.trim()).filter(Boolean));
  for (const d of desired) {
    if (!lines.has(d)) return false;
  }
  return true;
}

async function copyDirIfExists(fromDir: string, toDir: string): Promise<void> {
  if (!(await existsDir(fromDir))) return;
  await mkdir(toDir, { recursive: true });
  await copyDir(fromDir, toDir);
}

async function existsDir(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function copyDir(fromDir: string, toDir: string): Promise<void> {
  const entries = await readdir(fromDir, { withFileTypes: true });
  for (const e of entries) {
    const src = join(fromDir, e.name);
    const dst = join(toDir, e.name);
    if (e.isDirectory()) {
      await mkdir(dst, { recursive: true });
      await copyDir(src, dst);
    } else if (e.isFile()) {
      await mkdir(toDir, { recursive: true });
      await copyFile(src, dst);
    }
  }
}

async function safeReadContract(contractDir: string): Promise<Contract | null> {
  try {
    return await readContract(contractDir);
  } catch {
    return null;
  }
}
