import { mkdir, readdir, readFile, stat, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { execa } from 'execa';

import { CursorRunnerAdapter } from '../../core/session/cursor-adapter.js';
import type { RunnerAdapter } from '../../core/session/runner.js';
import { SessionController } from '../../core/session/controller.js';
import { GateController } from '../../core/gate/controller.js';
import { EvidenceCollector } from '../../core/evidence/collector.js';
import { JobManager, type JobOutcome } from '../../core/job-manager.js';
import { LedgerReader } from '../../core/ledger/reader.js';
import { LedgerWriter } from '../../core/ledger/writer.js';
import { readContract } from '../../core/contract/reader.js';
import type { Contract } from '../../core/contract/types.js';
import type { JobState } from '../../core/job/types.js';
import { readDelegationPlanYaml } from '../../core/delegation/parser.js';
import { initJob, initWorkspace } from '../../workspace/layout.js';
import { git, isClean, resolveWorktreePath } from '../../git/operations.js';

import { isPidAlive, joinRepoPath, jobLedgerPath, readJobStatus } from '../jobs.js';
import { getRenderer } from '../ui/renderer.js';
import { theme } from '../ui/theme.js';
import { installCliCancellation } from '../cancel.js';
import { roleLabel } from '../ui/format.js';
import type { SpinnerHandle } from '../ui/spinner.js';
import { cleanupJobWorktreeBestEffort, ensureWorktreeForExistingBranch, mergeBackIfSafe } from '../worktrees.js';
import { resolveSessionInactivityTimeoutMs } from '../session-timeout.js';

export interface RunExistingJobArgs {
  repoRoot?: string;
  jobId: string;
  runner?: RunnerAdapter;
  /**
   * If provided, skips reading `.nibbler/contract` again.
   * Useful when `build` already performed preflight + contract loading.
   */
  contract?: Contract;
  /**
   * If true, allow resuming/continuing jobs even if status.state is `failed` or `budget_exceeded`.
   * This is used by `build` to offer recovery when the user re-runs `build`.
   */
  allowFailed?: boolean;
  /**
   * Optional hook to transform/augment the outcome before final merge/cleanup.
   * Used by `build` to run autonomous recovery after a failed resume attempt.
   */
  afterOutcome?: (ctx: { jm: JobManager; job: JobState; contract: Contract }, out: JobOutcome) => Promise<JobOutcome>;
}

/**
 * Shared implementation for continuing a job from `.nibbler/jobs/<id>/status.json`.
 * - If engine_pid is alive, attaches and streams logs/ledger until the engine ends.
 * - Otherwise, resumes orchestration from the persisted checkpoint via JobManager.resumeContractJob().
 * - Optionally allows continuing failed jobs (build flow) and running a recovery step via `afterOutcome`.
 */
export async function runExistingJob(args: RunExistingJobArgs): Promise<{ ok: boolean; jobId?: string; details?: unknown }> {
  const r = getRenderer();
  const repoRoot = resolve(args.repoRoot ?? process.cwd());
  const jobId = args.jobId;

  const status = await readJobStatus(repoRoot, jobId);
  const enginePid = status.engine_pid;

  if (enginePid && isPidAlive(enginePid)) {
    r.info(`Attaching to running job (engine_pid=${enginePid})...`);
    await attachToRunningJob(repoRoot, jobId, status);
    const finalStatus = await readJobStatus(repoRoot, jobId).catch(() => status);
    const finalState = String(finalStatus.state ?? 'unknown');
    const jobBranch = finalStatus.job_branch ? String(finalStatus.job_branch) : null;
    const sourceBranch = finalStatus.source_branch ? String(finalStatus.source_branch) : null;
    const wt = finalStatus.worktree_path ? String(finalStatus.worktree_path) : null;

    // Only report success if the job completed and the job branch is merged into the source branch.
    if (finalState === 'completed' && jobBranch && sourceBranch) {
      const merged = await isBranchMergedInto(repoRoot, jobBranch, sourceBranch);

      if (merged.merged) return { ok: true, jobId };

      r.warn(`Job completed on ${theme.bold(jobBranch)} but was not merged into ${theme.bold(sourceBranch)} (${merged.reason ?? 'not_merged'}).`);
      if (wt) r.warn(`Worktree preserved at: ${theme.bold(wt)}`);
      return { ok: false, jobId, details: `Auto-merge skipped (${merged.reason ?? 'not_merged'}). Merge ${jobBranch} into ${sourceBranch}.` };
    }

    // Not completed (or insufficient info): treat as failure for CLI transparency.
    if (finalState !== 'completed') {
      if (jobBranch) r.warn(`Job ended with state ${theme.bold(finalState)} on ${theme.bold(jobBranch)}.`);
      else r.warn(`Job ended with state ${theme.bold(finalState)}.`);
      if (wt) r.warn(`Worktree preserved at: ${theme.bold(wt)}`);
    }

    return {
      ok: false,
      jobId,
      details:
        finalState === 'completed'
          ? 'Job completed, but merge status could not be verified.'
          : `Job ended with state ${finalState}.`,
    };
  }

  const state = String(status.state);
  if (state === 'completed') return { ok: true, jobId, details: 'Job already completed.' };
  if (!args.allowFailed) {
    if (state === 'failed') return { ok: false, jobId, details: 'Job already failed (see history/status for evidence).' };
    if (state === 'cancelled') return { ok: false, jobId, details: 'Job was cancelled (cannot resume automatically).' };
    if (state === 'budget_exceeded') return { ok: false, jobId, details: 'Job exceeded budget (cannot resume automatically).' };
  }

  r.info(`Continuing job ${theme.bold(jobId)} from phase ${theme.bold(status.current_phase ?? 'start')}...`);

  const jobBranch = status.job_branch ? String(status.job_branch) : null;
  const sourceBranch = status.source_branch ? String(status.source_branch) : null;
  const statusWorktree = status.worktree_path ? String(status.worktree_path) : null;

  const worktreePath = jobBranch ? (statusWorktree ?? resolveWorktreePath(repoRoot, jobId)) : null;
  // If the job has a dedicated worktree, we can safely resume even if the user's
  // main working tree has local changes. We only require cleanliness when we
  // must run sessions directly in the repo root (rare for build jobs).
  const repo = git(repoRoot);
  const needsRepoRootSessions = !worktreePath;
  if (needsRepoRootSessions) {
    if (!(await isClean(repo, { ignoreNibblerEngineArtifacts: true }).catch(() => false))) {
      return {
        ok: false,
        jobId,
        details: 'Working tree is not clean. Commit/stash changes before resuming this job (it runs in the repo root).',
      };
    }
  } else if (process.env.NIBBLER_VERBOSE === '1') {
    const clean = await isClean(repo, { ignoreNibblerEngineArtifacts: true }).catch(() => true);
    if (!clean) r.warn('Working tree has local changes; resuming job in its worktree and preserving them.');
  }
  if (jobBranch && worktreePath) {
    const wtSpinner = r.spinner(`Preparing worktree for ${theme.bold(jobBranch)}...`);
    try {
      const ensured = await ensureWorktreeForExistingBranch({ repoRoot, worktreePath, jobBranch });
      wtSpinner.succeed(`Worktree ready: ${theme.bold(worktreePath)}`);
      if (process.env.NIBBLER_VERBOSE === '1' && ensured.movedStaleTo) {
        r.dim(`Moved stale worktree dir to: ${ensured.movedStaleTo}`);
      }
    } catch (err: any) {
      wtSpinner.fail('Failed to prepare worktree');
      return {
        ok: false,
        jobId,
        details: `Failed to prepare worktree at ${worktreePath} for branch ${jobBranch}. ${String(err?.message ?? err)}`
      };
    }
  }

  await initWorkspace(repoRoot);
  const jobPaths = await initJob(repoRoot, jobId);

  const contract = args.contract ?? (await safeReadContract(resolve(repoRoot, '.nibbler', 'contract')));
  if (!contract) return { ok: false, jobId, details: 'No contract found. Run `nibbler init` first.' };

  const evidence = new EvidenceCollector({
    evidenceDir: jobPaths.evidenceDir,
    diffsDir: jobPaths.evidenceDiffsDir,
    checksDir: jobPaths.evidenceChecksDir,
    commandsDir: jobPaths.evidenceCommandsDir,
    gatesDir: jobPaths.evidenceGatesDir,
  });
  const ledger = await LedgerWriter.open(jobPaths.ledgerPath);
  const gates = new GateController(ledger, evidence);
  const runner = args.runner ?? new CursorRunnerAdapter();
  const sessionsWorkspace = worktreePath ?? repoRoot;
  const sessions = new SessionController(runner, sessionsWorkspace, { inactivityTimeoutMs: resolveSessionInactivityTimeoutMs() });

  let activeRoleSpinner: SpinnerHandle | null = null;
  let activeRoleId: string | null = null;
  const stopActiveRoleSpinner = (
    roleId: string,
    args: { ok: boolean; successText?: string; failText?: string }
  ) => {
    if (!activeRoleSpinner || activeRoleId !== roleId) return;
    const prefix = roleLabel(roleId);
    if (args.ok) activeRoleSpinner.succeed(`${prefix}${args.successText ?? 'Session complete'}`);
    else activeRoleSpinner.fail(`${prefix}${args.failText ?? 'Session needs revision'}`);
    activeRoleSpinner = null;
    activeRoleId = null;
  };

  const jm = new JobManager(sessions, gates, evidence, ledger, {
    beforeVerifyCompletion: async ({ job: j, roleId }) => {
      if (j.currentPhaseId === 'planning' && roleId === 'architect') {
        const staged = join(sessionsWorkspace, '.nibbler-staging', 'plan', jobId);
        await copyDirIfExists(staged, jobPaths.planDir);
      }
    },
    onRolePlanStart: ({ roleId, attempt, maxAttempts }) => {
      activeRoleSpinner?.stop();
      activeRoleId = roleId;
      activeRoleSpinner = r.spinner(`${roleLabel(roleId)}Preparing implementation plan (attempt ${attempt}/${maxAttempts})...`);
    },
    onRolePlanComplete: ({ roleId }) => {
      stopActiveRoleSpinner(roleId, { ok: true, successText: 'Implementation plan ready' });
    },
    onRolePlanFailed: ({ roleId }) => {
      stopActiveRoleSpinner(roleId, { ok: false, failText: 'Implementation plan failed; retrying...' });
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
      stopActiveRoleSpinner(roleId, { ok: scopePassed && completionPassed });
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
      stopActiveRoleSpinner(roleId, { ok: false });
      r.roleEscalation(roleId, reason);
    },
  });

  const job: JobState = {
    repoRoot,
    jobId,
    // IMPORTANT: when continuing an existing job we must enable resume semantics
    // (rehydrate attempts, scope overrides, feedback) regardless of the job's original mode.
    // Otherwise we risk repeating attempts and "retry storms" after pauses/crashes.
    mode: 'resume' as const,
    description: status.description ?? undefined,
    worktreePath: worktreePath ?? undefined,
    sourceBranch: sourceBranch ?? undefined,
    jobBranch: jobBranch ?? undefined,
    enginePid: process.pid,
    globalBudgetLimitMs: contract.globalLifetime.maxTimeMs,
    currentPhaseId: status.current_phase ?? (contract.phases[0]?.id ?? 'start'),
    currentPhaseActorIndex: status.current_phase_actor_index ?? 0,
    currentRoleId: status.current_role ?? null,
    startedAtIso: status.started_at,
    statusPath: jobPaths.statusPath,
    rolesCompleted: status.progress.roles_completed ?? [],
    rolesPlanned: [...(status.progress.roles_completed ?? []), ...(status.progress.roles_remaining ?? [])],
    // Preserve engine checkpoint state (paused-at-gate is a first-class resume case).
    state: (status.state ?? 'executing') as any,
    pendingGateId: (status.pending_gate_id ?? null) as any,
  };

  // Rehydrate delegation plan so execution remains plan-driven after resume.
  // The plan artifacts on disk are the source of truth; JobState stores the parsed form for orchestration.
  try {
    const delegationAbs = join(repoRoot, '.nibbler', 'jobs', jobId, 'plan', 'delegation.yaml');
    job.delegationPlan = await readDelegationPlanYaml(delegationAbs);
  } catch {
    // Best-effort: older jobs or incomplete planning may not have a delegation plan.
  }

  const cancellation = installCliCancellation({
    onCancel: async ({ signal }) => {
      r.warn('Cancelling job...');
      await jm.cancel(job, { signal, reason: 'signal' });
    },
    onForceExit: async () => {
      await jm.stopActiveSession();
    }
  });
  const jobStartTime = Date.now();
  try {
    let out = await jm.resumeContractJob(job, contract);
    if (args.afterOutcome) {
      out = await args.afterOutcome({ jm, job, contract }, out);
    }

    if (out.ok) {
      if (jobBranch && sourceBranch && worktreePath) {
        const mergeSpinner = r.spinner(`Merging ${theme.bold(jobBranch)} into ${theme.bold(sourceBranch)}...`);
        try {
          const merged = await mergeBackIfSafe({ repoRoot, sourceBranch, jobBranch, allowNoFf: true });
          if (!merged.merged) {
            mergeSpinner.fail('Auto-merge skipped');
            r.warn(`Job completed on ${theme.bold(jobBranch)} but was not merged automatically (${merged.reason}).`);
            r.warn(`Worktree preserved at: ${theme.bold(worktreePath)}`);
            return { ok: false, jobId, details: `Auto-merge skipped (${merged.reason}). Merge ${jobBranch} manually.` };
          }
          mergeSpinner.succeed(`Merged into ${theme.bold(sourceBranch)}`);
          if (merged.reason === 'autostash_pop_conflicts') {
            r.warn('Your local changes were stashed for the merge, but could not be fully restored cleanly.');
            r.warn('Resolve the merge conflicts in your working tree (the stash entry should still exist).');
            // The merge itself succeeded — don't fail the build for a stash-pop conflict.
          }
          if (merged.reason === 'autostash_pop_failed') {
            r.warn('Merged successfully, but restoring your local changes failed.');
            r.warn('Your stash entry should still exist; you can re-apply it manually.');
          }
        } catch {
          mergeSpinner.fail('Merge failed');
          r.warn(`Job completed on ${theme.bold(jobBranch)} but could not be merged automatically.`);
          r.warn(`Worktree preserved at: ${theme.bold(worktreePath)}`);
          return { ok: false, jobId, details: `Merge failed. Resolve conflicts and merge ${jobBranch} manually.` };
        }

        const cleanupSpinner = r.spinner('Cleaning up worktree...');
        try {
          const cleaned = await cleanupJobWorktreeBestEffort({ repoRoot, worktreePath, jobBranch });
          cleanupSpinner.succeed('Worktree cleaned up');
          if (!cleaned.removedWorktree || !cleaned.deletedBranch) {
            r.warn(`Cleanup incomplete. Worktree: ${theme.bold(worktreePath)} branch: ${theme.bold(jobBranch)}`);
          }
        } catch {
          cleanupSpinner.fail('Cleanup incomplete');
          r.warn(`Cleanup incomplete. Worktree: ${theme.bold(worktreePath)} branch: ${theme.bold(jobBranch)}`);
        }
      }

      const durationMs = Date.now() - jobStartTime;
      r.jobComplete({
        jobId,
        durationMs,
        roles: job.rolesCompleted ?? [],
        commits: (job.rolesCompleted ?? []).length,
        filesChanged: job.lastDiff?.summary.filesChanged ?? 0,
        linesAdded: job.lastDiff?.summary.additions ?? 0,
        linesRemoved: job.lastDiff?.summary.deletions ?? 0,
        branch: jobBranch ?? 'unknown',
        evidencePath: `.nibbler/jobs/${jobId}/evidence/`,
        ledgerPath: `.nibbler/jobs/${jobId}/ledger.jsonl`,
      });

      return { ok: true, jobId };
    }

    if (!out.ok) {
      const wt = worktreePath ?? '(unknown)';
      const br = jobBranch ?? '(unknown)';
      r.warn(`Job failed. Worktree preserved at: ${theme.bold(wt)}`);
      r.warn(`Branch: ${theme.bold(br)}`);
    }

    return out.ok ? { ok: true, jobId } : { ok: false, jobId, details: out };
  } finally {
    cancellation.dispose();
  }
}

async function attachToRunningJob(repoRoot: string, jobId: string, status: any): Promise<void> {
  const r = getRenderer();
  const ledger = new LedgerReader(jobLedgerPath(repoRoot, jobId));
  const logRel: string | undefined = status.session?.log_path;
  const logAbs = logRel ? joinRepoPath(repoRoot, logRel) : null;

  let lastLogLen = 0;
  let lastSeq = 0;

  if (logAbs) {
    try {
      const content = await readFile(logAbs, 'utf8');
      lastLogLen = content.length;
      const tail = content.slice(Math.max(0, content.length - 8_000));
      if (tail.trim()) process.stderr.write(tail.endsWith('\n') ? tail : `${tail}\n`);
    } catch {
      r.warn(`Session log missing: ${logRel}`);
    }
  } else {
    r.warn('No session log path in status');
  }

  r.dim('Streaming ledger events...');

  const start = Date.now();
  while (true) {
    const st = await readJobStatus(repoRoot, jobId);
    if (!st.engine_pid || !isPidAlive(st.engine_pid)) {
      r.dim('Engine process ended; detaching.');
      return;
    }

    // Stream new log output
    if (logAbs) {
      try {
        const content = await readFile(logAbs, 'utf8');
        if (content.length > lastLogLen) {
          process.stderr.write(content.slice(lastLogLen));
          lastLogLen = content.length;
        }
      } catch {
        // ignore transient errors
      }
    }

    // Stream new ledger events
    try {
      const { entries } = await ledger.readAllSafe();
      for (const e of entries as any[]) {
        const seq = typeof e?.seq === 'number' ? e.seq : 0;
        if (seq > lastSeq) {
          const type = String(e?.type ?? 'event').padEnd(20);
          const role = e?.data?.role ? theme.role(String(e.data.role))(String(e.data.role)) : '';
          r.dim(`  ${type}  ${role}`);
          lastSeq = Math.max(lastSeq, seq);
        }
      }
    } catch {
      // ignore
    }

    if (Date.now() - start > 24 * 60 * 60 * 1000) return; // safety: 24h
    await sleep(1000);
  }
}

async function isBranchMergedInto(
  repoRoot: string,
  fromBranch: string,
  intoBranch: string
): Promise<{ merged: boolean; reason?: string }> {
  try {
    await execa('git', ['rev-parse', '--verify', fromBranch], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  } catch {
    // If the job branch no longer exists, it was likely cleaned up after a successful merge.
    return { merged: true, reason: 'job_branch_missing' };
  }

  try {
    await execa('git', ['rev-parse', '--verify', intoBranch], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  } catch {
    return { merged: false, reason: 'source_branch_missing' };
  }

  try {
    await execa('git', ['merge-base', '--is-ancestor', fromBranch, intoBranch], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { merged: true };
  } catch (err: any) {
    const exit = typeof err?.exitCode === 'number' ? err.exitCode : null;
    if (exit === 1) return { merged: false, reason: 'not_merged' };
    return { merged: false, reason: 'git_error' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadContract(contractDir: string) {
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

