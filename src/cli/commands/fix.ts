import { mkdir, readFile, rename, rm, stat, readdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { EvidenceCollector } from '../../core/evidence/collector.js';
import { GateController } from '../../core/gate/controller.js';
import { JobManager, type JobOutcome } from '../../core/job-manager.js';
import { LedgerWriter } from '../../core/ledger/writer.js';
import { SessionController } from '../../core/session/controller.js';
import { CursorRunnerAdapter } from '../../core/session/cursor-adapter.js';
import type { RunnerAdapter } from '../../core/session/runner.js';
import { readContract } from '../../core/contract/reader.js';
import type { Contract } from '../../core/contract/types.js';
import { pickFixStartPhase } from '../../core/contract/helpers.js';
import type { JobState } from '../../core/job/types.js';
import { JobIdGenerator } from '../../utils/id.js';
import { fileExists, readText } from '../../utils/fs.js';
import { addWorktree, createBranchAt, deleteBranch, getCurrentBranch, git, isClean, resolveWorktreePath } from '../../git/operations.js';
import { initJob, initWorkspace } from '../../workspace/layout.js';
import { getRenderer } from '../ui/renderer.js';
import { theme } from '../ui/theme.js';
import { roleLabel } from '../ui/format.js';
import type { SpinnerHandle } from '../ui/spinner.js';
import { installCliCancellation } from '../cancel.js';
import { cleanupJobWorktreeBestEffort, mergeBackIfSafe } from '../worktrees.js';
import { isPidAlive, listJobIds, readJobStatus } from '../jobs.js';
import { promptInput, promptSelect } from '../ui/prompts.js';
import { resolveSessionInactivityTimeoutMs } from '../session-timeout.js';

export interface FixCommandOptions {
  repoRoot?: string;
  /** Existing job id to fix. If omitted, prompts user to select. */
  job?: string;
  /** Fix instructions (positional arg). */
  instructions?: string;
  /** Optional file containing fix instructions. */
  file?: string;
  runner?: RunnerAdapter;
  startedAtIso?: string;
}

export async function runFixCommand(opts: FixCommandOptions): Promise<{ ok: boolean; jobId?: string; details?: unknown }> {
  const r = getRenderer();
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());

  // Load contract
  const contract = await safeReadContract(join(repoRoot, '.nibbler', 'contract'));
  if (!contract) return { ok: false, details: 'No contract found. Run `nibbler init` first.' };

  // Pick job
  const jobIdToFix = opts.job?.trim() || (await selectJobToFix(repoRoot));
  if (!jobIdToFix) return { ok: false, details: 'No jobs found to fix.' };

  const status = await readJobStatus(repoRoot, jobIdToFix);
  // In real CLI usage, a live engine pid usually implies the job is still running.
  // In tests, commands may execute within the same Node process, so `engine_pid` can be alive even for completed jobs.
  const terminalStates = new Set(['completed', 'failed', 'cancelled', 'budget_exceeded']);
  const state = String(status.state ?? 'unknown');
  if (!terminalStates.has(state) && status.engine_pid && isPidAlive(status.engine_pid)) {
    return { ok: false, details: `Job ${jobIdToFix} is still running (engine_pid=${status.engine_pid}). Stop it or use \`nibbler resume\`.` };
  }

  const baseRef =
    (status.job_branch ? String(status.job_branch) : null) ??
    (status.source_branch ? String(status.source_branch) : null) ??
    'HEAD';

  const sourceBranch = status.source_branch ? String(status.source_branch) : await getCurrentBranch(git(repoRoot)).catch(() => 'HEAD');

  // Collect instructions
  const instructions = await resolveFixInstructions(opts);
  if (!instructions.trim()) return { ok: false, details: 'Fix instructions are empty.' };

  // Allocate new job + worktree
  const newJobId = await allocateJobId(repoRoot, new Date());
  const fixBranch = `nibbler/job-${newJobId}`;
  const worktreePath = resolveWorktreePath(repoRoot, newJobId);

  const branchSpinner = r.spinner(`Preparing fix worktree from ${theme.bold(baseRef)}...`);
  try {
    await prepareWorktreeFromRef({ repoRoot, worktreePath, branch: fixBranch, baseRef, fallbackRef: sourceBranch });
    branchSpinner.succeed(`Worktree ready: ${theme.bold(fixBranch)} (base: ${theme.bold(baseRef)})`);
  } catch (err: any) {
    branchSpinner.fail('Failed to prepare fix worktree');
    return { ok: false, details: `Failed to prepare fix worktree. ${String(err?.message ?? err)}` };
  }

  await initWorkspace(repoRoot);
  const jobPaths = await initJob(repoRoot, newJobId);

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
  const sessions = new SessionController(runner, worktreePath, { inactivityTimeoutMs: resolveSessionInactivityTimeoutMs() });

  // Rendering hooks: keep a single live spinner per role attempt.
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
      // Materialize staged planning artifacts into the job's durable plan dir.
      if (j.currentPhaseId === 'planning' && roleId === 'architect') {
        const staged = join(worktreePath, '.nibbler-staging', 'plan', newJobId);
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
    onHandoff: ({ fromRole, toRole }) => r.handoff(fromRole, toRole),
    onEscalation: ({ roleId, reason }) => {
      stopActiveRoleSpinner(roleId, { ok: false });
      r.roleEscalation(roleId, reason);
    },
  });

  const jobStartTime = Date.now();
  const validPhaseIds = new Set(contract.phases.map((p) => p.id));
  const failingPhase =
    status.current_phase && validPhaseIds.has(status.current_phase) ? String(status.current_phase) : null;
  const startPhase = failingPhase ?? pickFixStartPhase(contract);
  const job: JobState = {
    repoRoot,
    jobId: newJobId,
    mode: 'fix' as const,
    description: `Fix ${jobIdToFix}: ${truncateOneLine(instructions, 80)}`,
    currentPhaseId: startPhase,
    worktreePath,
    sourceBranch,
    jobBranch: fixBranch,
    startedAtIso: opts.startedAtIso ?? process.env.NIBBLER_TEST_STARTED_AT_ISO ?? new Date().toISOString(),
    enginePid: process.pid,
    globalBudgetLimitMs: contract.globalLifetime.maxTimeMs,
    statusPath: jobPaths.statusPath,
    state: 'executing' as const,
  };

  // Provide the user instructions to the Architect as fix feedback.
  job.feedbackByRole ??= {};
  (job.feedbackByRole as any).architect = {
    kind: 'fix',
    issue: instructions,
    priorJobId: jobIdToFix,
    baseRef,
  };

  // Cancellation
  const cancellation = installCliCancellation({
    onCancel: async ({ signal }) => {
      r.warn('Cancelling job...');
      await jm.cancel(job, { signal, reason: 'signal' });
    },
    onForceExit: async () => {
      await jm.stopActiveSession();
    }
  });

  try {
    let out: JobOutcome = await jm.runContractJobFromPhase(job, contract, startPhase);
    if (out.ok) {
      const mergeSpinner = r.spinner(`Merging ${theme.bold(fixBranch)} into ${theme.bold(sourceBranch)}...`);
      try {
        const merged = await mergeBackIfSafe({ repoRoot, sourceBranch, jobBranch: fixBranch, allowNoFf: true });
        if (!merged.merged) {
          mergeSpinner.fail('Auto-merge skipped');
          r.warn(`Fix completed on ${theme.bold(fixBranch)} but was not merged automatically (${merged.reason}).`);
          r.warn(`Worktree preserved at: ${theme.bold(worktreePath)}`);
          return { ok: false, jobId: newJobId, details: `Auto-merge skipped (${merged.reason}). Merge ${fixBranch} manually.` };
        }
        mergeSpinner.succeed(`Merged into ${theme.bold(sourceBranch)}`);
        if (merged.reason === 'autostash_pop_conflicts') {
          r.warn('Your local changes were stashed for the merge, but could not be fully restored cleanly.');
          r.warn('Resolve the merge conflicts in your working tree (the stash entry should still exist).');
        }
        if (merged.reason === 'autostash_pop_failed') {
          r.warn('Merged successfully, but restoring your local changes failed.');
          r.warn('Your stash entry should still exist; you can re-apply it manually.');
        }
      } catch {
        mergeSpinner.fail('Merge failed');
        r.warn(`Fix completed on ${theme.bold(fixBranch)} but could not be merged automatically.`);
        r.warn(`Worktree preserved at: ${theme.bold(worktreePath)}`);
        return { ok: false, jobId: newJobId, details: `Merge failed. Resolve conflicts and merge ${fixBranch} manually.` };
      }

      const cleanupSpinner = r.spinner('Cleaning up worktree...');
      try {
        const cleaned = await cleanupJobWorktreeBestEffort({ repoRoot, worktreePath, jobBranch: fixBranch });
        cleanupSpinner.succeed('Worktree cleaned up');
        if (!cleaned.removedWorktree || !cleaned.deletedBranch) {
          r.warn(`Cleanup incomplete. Worktree: ${theme.bold(worktreePath)} branch: ${theme.bold(fixBranch)}`);
        }
      } catch {
        cleanupSpinner.fail('Cleanup incomplete');
        r.warn(`Cleanup incomplete. Worktree: ${theme.bold(worktreePath)} branch: ${theme.bold(fixBranch)}`);
      }

      // Completion summary (reuse renderer)
      const durationMs = Date.now() - jobStartTime;
      const branch = await getCurrentBranch(git(repoRoot)).catch(() => fixBranch);
      r.jobComplete({
        jobId: newJobId,
        durationMs,
        roles: job.rolesCompleted ?? [],
        commits: (job.rolesCompleted ?? []).length,
        filesChanged: job.lastDiff?.summary.filesChanged ?? 0,
        linesAdded: job.lastDiff?.summary.additions ?? 0,
        linesRemoved: job.lastDiff?.summary.deletions ?? 0,
        branch,
        evidencePath: `.nibbler/jobs/${newJobId}/evidence/`,
        ledgerPath: `.nibbler/jobs/${newJobId}/ledger.jsonl`,
      });
      return { ok: true, jobId: newJobId };
    }

    r.warn(`Fix job failed. Worktree preserved at: ${theme.bold(worktreePath)}`);
    r.warn(`Branch: ${theme.bold(fixBranch)}`);
    return { ok: false, jobId: newJobId, details: out };
  } finally {
    cancellation.dispose();
  }
}

async function resolveFixInstructions(opts: FixCommandOptions): Promise<string> {
  const fromArg = opts.instructions?.trim();
  if (fromArg) return fromArg;
  if (opts.file) {
    const abs = resolve(opts.file);
    const content = await readText(abs).catch(() => '');
    return content;
  }

  const quiet = process.env.NIBBLER_QUIET === '1';
  const inTest = process.env.VITEST != null || process.env.VITEST_WORKER_ID != null || process.env.NODE_ENV === 'test';
  const promptsEnabled =
    !quiet &&
    !inTest &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    process.env.NIBBLER_TEST_AUTO_APPROVE !== '1' &&
    process.env.NIBBLER_TEST_NO_PROMPTS !== '1';

  if (!promptsEnabled) return '';

  return await promptInput({ message: 'Fix instructions (what should be changed):', default: '' });
}

async function selectJobToFix(repoRoot: string): Promise<string | null> {
  const ids = (await listJobIds(repoRoot)).slice().reverse();
  if (!ids.length) return null;

  const quiet = process.env.NIBBLER_QUIET === '1';
  const inTest = process.env.VITEST != null || process.env.VITEST_WORKER_ID != null || process.env.NODE_ENV === 'test';
  const promptsEnabled =
    !quiet &&
    !inTest &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    process.env.NIBBLER_TEST_AUTO_APPROVE !== '1' &&
    process.env.NIBBLER_TEST_NO_PROMPTS !== '1';

  // Non-interactive: default to latest.
  if (!promptsEnabled) return ids[0] ?? null;

  const sample = ids.slice(0, 30);
  const statuses = await Promise.all(sample.map(async (id) => ({ id, status: await readJobStatus(repoRoot, id).catch(() => null) })));
  const choices = statuses
    .filter((x) => x.status)
    .map((x) => {
      const st = x.status!;
      const state = String(st.state ?? 'unknown');
      const phase = st.current_phase ?? 'unknown';
      const desc = st.description ? truncateOneLine(String(st.description), 50) : '';
      const label = `${theme.bold(x.id)} ${theme.dim(`(${state})`)} ${theme.dim(`phase=${phase}`)}${desc ? theme.dim(` — ${desc}`) : ''}`;
      return { name: label, value: x.id };
    });

  if (!choices.length) return ids[0] ?? null;

  return await promptSelect<string>({
    message: 'Select job to fix',
    choices,
  });
}

async function allocateJobId(repoRoot: string, now: Date): Promise<string> {
  // Keep the build-like stable ID scheme so `.nibbler/jobs/` remains consistent.
  const yyyyMMdd = (() => {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  })();

  const jobsDir = join(repoRoot, '.nibbler', 'jobs');
  let maxSeq = 0;
  try {
    // Best-effort: if jobs dir doesn't exist, ignore.
    const entries = await readdir(jobsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = new RegExp(`^j-${yyyyMMdd}-(\\d{3})$`).exec(e.name);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n)) maxSeq = Math.max(maxSeq, n);
    }
  } catch {
    // ignore
  }

  const generated = new JobIdGenerator().next(now);
  return maxSeq > 0 ? `j-${yyyyMMdd}-${String(maxSeq + 1).padStart(3, '0')}` : generated;
}

async function safeReadContract(contractDir: string): Promise<Contract | null> {
  try {
    return await readContract(contractDir);
  } catch {
    return null;
  }
}

async function prepareWorktreeFromRef(args: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  fallbackRef: string;
}): Promise<void> {
  const repo = git(args.repoRoot);

  // If the worktree path already exists, it may be a stale leftover; remove it to unblock.
  const exists = await pathExists(args.worktreePath);
  if (exists) {
    const inspected = await isActiveWorktreeDir(args.worktreePath);
    if (inspected.active) {
      // Safe reuse (same behavior as prepareJobWorktree).
      return;
    }
    await moveAsideStaleWorktreeDir(args.worktreePath);
  }

  // Create branch at baseRef (ignore if already exists).
  let createdBranch = false;
  try {
    await createBranchAt(repo, args.branch, args.baseRef);
    createdBranch = true;
  } catch {
    // keep going: either branch already exists, or baseRef is invalid.
  }

  try {
    await addWorktree(repo, args.worktreePath, args.branch);
  } catch (err) {
    // If we couldn't create the branch (baseRef invalid) and worktree add failed,
    // retry by creating the branch at a safe fallback ref (usually the source branch).
    if (!createdBranch && args.fallbackRef && args.fallbackRef !== args.baseRef) {
      try {
        await createBranchAt(repo, args.branch, args.fallbackRef);
        createdBranch = true;
        await addWorktree(repo, args.worktreePath, args.branch);
      } catch (retryErr) {
        // Best-effort rollback if we created the branch in this path.
        if (createdBranch) {
          try {
            await deleteBranch(repo, args.branch, { force: true });
          } catch {
            // ignore
          }
        }
        throw retryErr;
      }
      // Success on retry.
      return;
    }

    // Best-effort rollback if worktree creation fails after creating the branch.
    if (createdBranch) {
      try {
        await deleteBranch(repo, args.branch, { force: true });
      } catch {
        // ignore
      }
    }
    throw err;
  }

  // Ensure the new worktree is clean for deterministic sessions.
  const clean = await isClean(repo, { ignoreNibblerEngineArtifacts: true }).catch(() => true);
  if (!clean && process.env.NIBBLER_VERBOSE === '1') {
    // This refers to the primary repo working tree; fix runs in the worktree, so it's okay.
    // We surface it in verbose mode because merge-back may need autostash.
    getRenderer().warn('Working tree has local changes; fix will run in a worktree and preserve them.');
  }

  await mkdir(args.worktreePath, { recursive: true }).catch(() => {});
}

function truncateOneLine(text: string, max: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + '…';
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
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

async function readWorktreeGitdir(worktreePath: string): Promise<string | null> {
  try {
    const raw = await readFile(join(worktreePath, '.git'), 'utf8');
    const m = /^gitdir:\\s*(.+)\\s*$/m.exec(raw);
    if (!m) return null;
    const candidate = m[1].trim();
    // git may write either absolute or relative paths here
    return resolve(worktreePath, candidate);
  } catch {
    return null;
  }
}

async function isActiveWorktreeDir(worktreePath: string): Promise<{ active: boolean; gitdir: string | null; gitdirExists: boolean }> {
  const gitdir = await readWorktreeGitdir(worktreePath);
  const gitdirExists = gitdir ? await pathExists(gitdir) : false;
  return { active: !!gitdir && gitdirExists, gitdir, gitdirExists };
}

async function moveAsideStaleWorktreeDir(worktreePath: string): Promise<void> {
  const movedTo = `${worktreePath}.stale-${Date.now()}-${process.pid}`;
  try {
    await rename(worktreePath, movedTo);
  } catch {
    // Last resort: remove the directory to unblock worktree creation.
    await rm(worktreePath, { recursive: true, force: true });
  }
}

