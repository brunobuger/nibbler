import { mkdir, copyFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

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
import { createBranch, git, isClean } from '../../git/operations.js';
import { initJob, initWorkspace } from '../../workspace/layout.js';
import { getRenderer } from '../ui/renderer.js';
import { theme } from '../ui/theme.js';
import { roleLabel } from '../ui/format.js';
import type { SpinnerHandle } from '../ui/spinner.js';
import { installCliCancellation } from '../cancel.js';

export interface FixCommandOptions {
  repoRoot?: string;
  issue: string;
  files?: string[];
  scopeRole?: string;
  runner?: RunnerAdapter;
  startedAtIso?: string;
}

/**
 * `nibbler fix "<issue>"` — runs a targeted job on an existing repo.
 */
export async function runFixCommand(opts: FixCommandOptions): Promise<{ ok: boolean; jobId?: string; details?: unknown }> {
  const r = getRenderer();
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const issue = opts.issue.trim();
  const providedFiles = (opts.files ?? []).map((p) => resolve(p));

  const repo = git(repoRoot);
  if (!(await isClean(repo))) {
    return { ok: false, details: 'Working tree is not clean. Commit/stash changes before running nibbler fix.' };
  }

  const contract = await safeReadContract(join(repoRoot, '.nibbler', 'contract'));
  if (!contract) return { ok: false, details: 'No contract found. Run `nibbler init` first.' };

  const jobId = new JobIdGenerator().next(new Date());

  const branchSpinner = r.spinner(`Creating branch nibbler/fix-${jobId}...`);
  await createBranch(repo, `nibbler/fix-${jobId}`);
  branchSpinner.succeed(`Branch nibbler/fix-${jobId}`);

  r.blank();
  r.dim(`Issue: "${issue}"`);
  if (opts.scopeRole) {
    r.dim(`Scoped to role: ${theme.role(opts.scopeRole)(opts.scopeRole)}`);
  }

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

  const stagedFiles = await stageSupportingFiles(repoRoot, jobId, providedFiles);

  const job = {
    repoRoot,
    jobId,
    mode: 'fix' as const,
    description: issue,
    currentPhaseId: contract.phases[0]?.id ?? 'start',
    currentPhaseActorIndex: 0,
    startedAtIso: opts.startedAtIso ?? process.env.NIBBLER_TEST_STARTED_AT_ISO ?? new Date().toISOString(),
    enginePid: process.pid,
    globalBudgetLimitMs: contract.globalLifetime.maxTimeMs,
    statusPath: jobPaths.statusPath,
    feedbackByRole: {
      architect: {
        kind: 'fix',
        issue,
        supportingFiles: stagedFiles,
      },
    },
  };

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
    beforeVerifyCompletion: async ({ job: j, roleId }) => {
      if (j.currentPhaseId === 'planning' && roleId === 'architect') {
        const staged = join(repoRoot, '.nibbler-staging', 'plan', jobId);
        await copyDirIfExists(staged, jobPaths.planDir);
      }
    },
    onRoleStart: ({ roleId, attempt, maxAttempts }) => {
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
        { name: 'Scope check', passed: scopePassed, detail: scopePassed ? `${diff.summary.filesChanged} files, 0 violations` : `${scopeViolations?.length ?? 0} violation(s)` },
        { name: 'Completion', passed: completionPassed, detail: completionPassed ? 'all criteria met' : 'criteria not met' },
      ]);
    },
    onHandoff: ({ fromRole, toRole }) => {
      r.handoff(fromRole, toRole);
    },
    onEscalation: ({ roleId, reason }) => {
      stopActiveRoleSpinner(roleId, false);
      r.roleEscalation(roleId, reason);
    },
  });

  const startPhaseId = pickFixStartPhase(contract);
  const effectiveContract = opts.scopeRole ? scopeContractActors(contract, opts.scopeRole) : contract;

  const cancellation = installCliCancellation({
    onCancel: async ({ signal }) => {
      r.warn('Cancelling job...');
      await jm.cancel(job, { signal, reason: 'signal' });
    },
  });
  try {
    const out = await jm.runContractJobFromPhase(job, effectiveContract, startPhaseId);
    if (out.ok) {
      r.success(`Fix complete: job ${jobId}`);
    }
    return out.ok ? { ok: true, jobId } : { ok: false, jobId, details: out };
  } finally {
    cancellation.dispose();
  }
}

// ── Internal Helpers ────────────────────────────────────────────────────────

function pickFixStartPhase(contract: Contract): string {
  const ids = new Set(contract.phases.map((p) => p.id));
  if (ids.has('planning')) return 'planning';
  if (ids.has('execution')) return 'execution';
  return contract.phases[0]?.id ?? 'start';
}

function scopeContractActors(contract: Contract, roleId: string): Contract {
  const phases = contract.phases.map((p) => {
    const has = p.actors.includes(roleId);
    if (!has) return p;
    return { ...p, actors: [roleId] };
  });
  return { ...contract, phases };
}

async function stageSupportingFiles(repoRoot: string, jobId: string, absFiles: string[]): Promise<string[]> {
  if (absFiles.length === 0) return [];

  const stageDir = join(repoRoot, '.nibbler-staging', 'fix-inputs', jobId);
  await mkdir(stageDir, { recursive: true });

  const stagedRel: string[] = [];
  for (const abs of absFiles) {
    try {
      const name = basename(abs);
      const dst = join(stageDir, name);
      await copyFile(abs, dst);
      stagedRel.push(`.nibbler-staging/fix-inputs/${jobId}/${name}`);
    } catch {
      // ignore missing/unreadable files
    }
  }
  return stagedRel;
}

async function safeReadContract(contractDir: string): Promise<Contract | null> {
  try {
    return await readContract(contractDir);
  } catch {
    return null;
  }
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
