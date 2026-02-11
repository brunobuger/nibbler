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
import { pickFixStartPhase } from '../../core/contract/helpers.js';
import { JobIdGenerator } from '../../utils/id.js';
import { fileExists, readText, resolveDocVariant } from '../../utils/fs.js';
import { getCurrentBranch, git, isClean } from '../../git/operations.js';
import { initJob, initWorkspace } from '../../workspace/layout.js';
import type { JobState } from '../../core/job/types.js';
import { getRenderer } from '../ui/renderer.js';
import { theme } from '../ui/theme.js';
import { formatMs, roleLabel } from '../ui/format.js';
import type { SpinnerHandle } from '../ui/spinner.js';
import { installCliCancellation } from '../cancel.js';
import { cleanupJobWorktreeBestEffort, mergeBackIfSafe, prepareJobWorktree } from '../worktrees.js';
import { listJobIds, readJobStatus, isPidAlive, readLedgerTail } from '../jobs.js';
import { promptInput, promptSelect } from '../ui/prompts.js';
import type { JobOutcome } from '../../core/job-manager.js';
import { formatFailureForArchitect } from './recovery.js';
import { runExistingJob } from './existing-job.js';
import { resolveSessionInactivityTimeoutMs } from '../session-timeout.js';

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

  const jobId = await allocateJobId(repoRoot, new Date());

  // ── Pre-flight checks ────────────────────────────────────────────────────
  const repo = git(repoRoot);
  // Note: builds run in an isolated worktree. We don't require a clean working tree up-front.
  // We will attempt a transparent auto-stash only if/when we need to merge results back.
  // (This keeps the user’s current workspace intact during long-running builds.)
  const startedDirty = !(await isClean(repo, { ignoreNibblerEngineArtifacts: true }).catch(() => true));
  if (startedDirty && process.env.NIBBLER_VERBOSE === '1') {
    r.warn('Working tree has local changes; build will run in a worktree and preserve them.');
  }

  const contract = await safeReadContract(join(repoRoot, '.nibbler', 'contract'));
  if (!contract) {
    return { ok: false, details: 'No contract found. Run `nibbler init` first.' };
  }
  const gitignoreOk = await hasRequiredGitignore(repoRoot);
  if (!gitignoreOk) {
    return { ok: false, details: 'Missing .gitignore entries. Run `nibbler init` (it writes required ignores).' };
  }

  // Discovery is now performed during `nibbler init`. Build requires these artifacts.
  const visionRel = await resolveDocVariant(repoRoot, ['vision.md', 'VISION.md', 'Vision.md'], 'vision.md');
  const architectureRel = await resolveDocVariant(repoRoot, ['architecture.md', 'ARCHITECTURE.md', 'Architecture.md'], 'architecture.md');
  const hasVision = await fileExists(join(repoRoot, visionRel));
  const hasArchitecture = await fileExists(join(repoRoot, architectureRel));
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

  // ── Stale job detection (resume-or-new) ─────────────────────────────────
  const quiet = process.env.NIBBLER_QUIET === '1';
  const inTest = process.env.VITEST != null || process.env.VITEST_WORKER_ID != null || process.env.NODE_ENV === 'test';
  const promptsEnabled =
    !quiet &&
    !inTest &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    process.env.NIBBLER_TEST_AUTO_APPROVE !== '1' &&
    process.env.NIBBLER_TEST_NO_PROMPTS !== '1';

  if (!inTest) {
    const latest = await findLatestRecoverableJobForBuild(repoRoot);
    if (latest) {
      const { jobId: lastJobId, status } = latest;
      const state = String(status.state);
      const phase = status.current_phase ?? 'unknown';
      const role = status.current_role ?? null;
      const completed = status.progress.roles_completed.length;
      const total = completed + status.progress.roles_remaining.length;

      const running = status.engine_pid && isPidAlive(status.engine_pid);

      // Quiet mode: auto-resume the latest job (no prompts).
      if (quiet) {
        return await runExistingJob({
          repoRoot,
          jobId: lastJobId,
          contract,
          runner: opts.runner,
          allowFailed: true,
          afterOutcome: async ({ jm, job, contract }, out) => {
            return await runWithRecovery({ jm, job, contract, initialOutcome: out });
          },
        });
      }

      if (promptsEnabled) {
        const budgetLine = formatBudgetLineFromStatus(status);
        const pathsLine = `Evidence: .nibbler/jobs/${lastJobId}/evidence/ | Ledger: .nibbler/jobs/${lastJobId}/ledger.jsonl`;
        const recentLine = await formatRecentLedgerLine(repoRoot, lastJobId);
        const resumeWarning =
          state === 'budget_exceeded'
            ? `${theme.warning('Note:')} this job exceeded its global budget; resuming it will likely fail immediately.\n`
            : '';

        const message =
          `Previous job found: ${theme.bold(lastJobId)} (${theme.bold(state)})\n` +
          `Phase: ${theme.bold(phase)}${role ? ` | Role: ${theme.bold(role)}` : ''} | ${completed}/${total} roles completed\n` +
          (running ? `Engine: running (pid=${status.engine_pid})\n` : '') +
          (budgetLine ? `${budgetLine}\n` : '') +
          `${pathsLine}\n` +
          (recentLine ? `${recentLine}\n` : '') +
          resumeWarning +
          'How would you like to proceed?';

        const choice = await promptSelect<'resume' | 'new'>({
          message,
          choices: [
            { name: 'Resume the previous job', value: 'resume' },
            { name: 'Start a new build', value: 'new' },
          ],
        });

        if (choice === 'resume') {
          return await runExistingJob({
            repoRoot,
            jobId: lastJobId,
            contract,
            runner: opts.runner,
            allowFailed: true,
            afterOutcome: async ({ jm, job, contract }, out) => {
              return await runWithRecovery({ jm, job, contract, initialOutcome: out });
            },
          });
        }
      }
    }
  }

  // ── Set up job ───────────────────────────────────────────────────────────
  const jobBranch = `nibbler/job-${jobId}`;
  const branchSpinner = r.spinner('Preparing job worktree...');
  let sourceBranch = 'HEAD';
  let worktreePath = '';
  try {
    const res = await prepareJobWorktree({ repoRoot, jobId, jobBranch });
    sourceBranch = res.sourceBranch;
    worktreePath = res.worktreePath;
    branchSpinner.succeed(`Worktree ready: ${theme.bold(jobBranch)} (base: ${theme.bold(sourceBranch)})`);
  } catch (err: any) {
    branchSpinner.fail('Failed to prepare job worktree');
    return { ok: false, details: `Failed to prepare worktree for job. ${String(err?.message ?? err)}` };
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
  const sessions = new SessionController(runner, worktreePath, { inactivityTimeoutMs: resolveSessionInactivityTimeoutMs() });

  const jobStartTime = Date.now();
  const job: JobState = {
    repoRoot,
    jobId,
    mode: 'build' as const,
    description: requirement,
    currentPhaseId: contract.phases[0]?.id ?? 'start',
    worktreePath,
    sourceBranch,
    jobBranch,
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
    onPhaseEnter: async ({ phaseId }) => {
      r.phaseBanner(phaseId);
    },

    beforeVerifyCompletion: async ({ job: j, roleId }) => {
      if (j.currentPhaseId === 'planning' && roleId === 'architect') {
        const staged = join(worktreePath, '.nibbler-staging', 'plan', jobId);
        await copyDirIfExists(staged, jobPaths.planDir);

        // Planning contracts often require staged contract snapshots; ensure they exist.
        // If the Architect already wrote staged contract files, keep them as-is.
        // NOTE: .nibbler/ is gitignored so contract files live in repoRoot, not the worktree.
        const stagedContractDir = join(worktreePath, '.nibbler-staging', 'contract');
        await mkdir(stagedContractDir, { recursive: true });
        const stagedTeam = join(stagedContractDir, 'team.yaml');
        const stagedPhases = join(stagedContractDir, 'phases.yaml');
        if (!(await fileExists(stagedTeam))) {
          const srcTeam = join(repoRoot, '.nibbler', 'contract', 'team.yaml');
          if (await fileExists(srcTeam)) await copyFile(srcTeam, stagedTeam);
        }
        if (!(await fileExists(stagedPhases))) {
          const srcPhases = join(repoRoot, '.nibbler', 'contract', 'phases.yaml');
          if (await fileExists(srcPhases)) await copyFile(srcPhases, stagedPhases);
        }
      }
    },

    // ── Rendering hooks ──────────────────────────────────────────────────
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
      stopActiveRoleSpinner(roleId, { ok: scopePassed && completionPassed });

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
      stopActiveRoleSpinner(roleId, { ok: false });
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
    onForceExit: async () => {
      await jm.stopActiveSession();
    }
  });
  try {
    let out = await jm.runContractJob(job, contract);
    out = await runWithRecovery({ jm, job, contract, initialOutcome: out });
    if (out.ok) {
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
    // Failure: preserve worktree and branch for inspection.
    r.warn(`Job failed. Worktree preserved at: ${theme.bold(worktreePath)}`);
    r.warn(`Branch: ${theme.bold(jobBranch)}`);
    return { ok: false, jobId, details: out };
  } finally {
    cancellation.dispose();
  }
}

async function runWithRecovery(args: {
  jm: JobManager;
  job: JobState;
  contract: Contract;
  initialOutcome: JobOutcome;
}): Promise<JobOutcome> {
  let out = args.initialOutcome;
  if (out.ok) return out;
  if (out.reason === 'cancelled') return out;

  const r = getRenderer();
  const quiet = process.env.NIBBLER_QUIET === '1';
  const inTest = process.env.VITEST != null || process.env.VITEST_WORKER_ID != null || process.env.NODE_ENV === 'test';
  const promptsEnabled =
    !quiet &&
    !inTest &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    process.env.NIBBLER_TEST_AUTO_APPROVE !== '1' &&
    process.env.NIBBLER_TEST_NO_PROMPTS !== '1';
  const MAX_RECOVERY_ATTEMPTS = 2;

  let guidance: string | null = null;
  for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
    r.phaseBanner('Recovery (autonomous)');
    r.warn(`Build failed (${String(out.reason)}). Architect agent is reviewing...`);

    args.jm.resetForRecovery();
    args.job.mode = 'fix';
    args.job.state = 'executing';
    args.job.feedbackByRole ??= {};
    (args.job.feedbackByRole as any).architect = {
      kind: 'fix',
      issue: formatFailureForArchitect(out, args.job),
      ...(guidance ? { userGuidance: guidance } : {}),
    };

    // Recovery should restart from the failing phase when possible, to avoid re-triggering
    // earlier PO gates (e.g. PLAN) unless the plan artifacts actually changed.
    const validPhaseIds = new Set(args.contract.phases.map((p) => p.id));
    const failingPhase = args.job.currentPhaseId && validPhaseIds.has(args.job.currentPhaseId) ? args.job.currentPhaseId : null;
    const recoveryStart = failingPhase ?? pickFixStartPhase(args.contract);

    out = await args.jm.runContractJobFromPhase(args.job, args.contract, recoveryStart);
    if (out.ok) return out;
    if (out.reason === 'cancelled') return out;

    // Tier 2: user prompt as last resort.
    if (!promptsEnabled) return out;
    if (attempt >= MAX_RECOVERY_ATTEMPTS) return out;

    r.blank();
    r.warn(`Autonomous recovery did not resolve the failure (${String(out.reason)}).`);
    const detailLines = formatOutcomeDetailsForUser(out);
    for (const line of detailLines) r.dim(line);
    r.dim(`Evidence: .nibbler/jobs/${args.job.jobId}/evidence/`);
    r.dim(`Ledger: .nibbler/jobs/${args.job.jobId}/ledger.jsonl`);
    const recent = await formatRecentLedgerLine(args.job.repoRoot, args.job.jobId);
    if (recent) r.dim(recent);
    if (out.reason === 'budget_exceeded') {
      r.warn('Global budget is exhausted; retries cannot succeed unless you start a new job (new budget) or increase `globalLifetime.maxTimeMs` in the contract.');
    }

    const action = await promptSelect<'retry' | 'abort'>({
      message: 'How would you like to proceed?',
      choices: [
        { name: 'Provide guidance and retry', value: 'retry' },
        { name: 'Abort (preserve worktree for manual inspection)', value: 'abort' },
      ],
    });
    if (action === 'abort') return out;

    guidance = await promptInput({
      message: 'Guidance for the Architect (what should be changed / where to look):',
    });
  }

  return out;
}

function formatBudgetLineFromStatus(status: Awaited<ReturnType<typeof readJobStatus>>): string | null {
  const state = String((status as any).state ?? '');
  if (state !== 'budget_exceeded') return null;
  const elapsed = (status as any)?.budget?.global?.elapsed_ms;
  const limit = (status as any)?.budget?.global?.limit_ms;
  if (typeof elapsed !== 'number') return null;
  if (typeof limit !== 'number') return `Budget: global time ${formatMs(elapsed)} (limit: unknown)`;
  const over = elapsed - limit;
  const suffix = over > 0 ? ` (exceeded by ${formatMs(over)})` : '';
  return `Budget: global time ${formatMs(elapsed)} / ${formatMs(limit)}${suffix}`;
}

async function formatRecentLedgerLine(repoRoot: string, jobId: string): Promise<string | null> {
  try {
    const tail = await readLedgerTail(repoRoot, jobId, 8);
    const entries = Array.isArray(tail.entries) ? tail.entries : [];
    const short = entries
      .slice(-6)
      .map((e: any) => {
        const type = String(e?.type ?? 'event');
        const role = e?.data?.role ? String(e.data.role) : null;
        return role ? `${type}(${role})` : type;
      })
      .filter(Boolean);
    if (!short.length) return null;
    return `Recent: ${short.join(', ')}`;
  } catch {
    return null;
  }
}

function formatOutcomeDetailsForUser(out: JobOutcome): string[] {
  if (out.ok) return [];
  if (out.reason === 'budget_exceeded') {
    const exceeded = (out.details as any)?.exceeded;
    const timeMs = exceeded?.timeMs;
    if (timeMs && typeof timeMs.limit === 'number' && typeof timeMs.actual === 'number') {
      const over = timeMs.actual - timeMs.limit;
      return [
        `Why: global time budget exceeded (${formatMs(timeMs.actual)} > ${formatMs(timeMs.limit)}${over > 0 ? `, over by ${formatMs(over)}` : ''})`,
      ];
    }
    return ['Why: global time budget exceeded'];
  }
  if (out.reason === 'cancelled') return ['Why: cancelled'];
  if (out.reason === 'escalated') return ['Why: escalated (manual intervention needed)'];
  return [];
}

async function findLatestRecoverableJobForBuild(
  repoRoot: string
): Promise<{ jobId: string; status: Awaited<ReturnType<typeof readJobStatus>> } | null> {
  const ids = await listJobIds(repoRoot);
  if (!ids.length) return null;

  const jobId = ids[ids.length - 1]!;
  try {
    const status = await readJobStatus(repoRoot, jobId);
    const state = String(status.state);
    if (state === 'completed') return null;
    return { jobId, status };
  } catch {
    return null;
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
  const exists = await existsDir(fromDir);
  if (!exists) return;
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

async function allocateJobId(repoRoot: string, now: Date): Promise<string> {
  const yyyyMMdd = (() => {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  })();

  const jobsDir = join(repoRoot, '.nibbler', 'jobs');
  let maxSeq = 0;

  try {
    const entries = await readdir(jobsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = new RegExp(`^j-${yyyyMMdd}-(\\d{3})$`).exec(e.name);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n)) maxSeq = Math.max(maxSeq, n);
    }
  } catch {
    // ignore: repo may not have .nibbler/jobs yet
  }

  const jobId = new JobIdGenerator().next(now);
  const chosen = maxSeq > 0 ? `j-${yyyyMMdd}-${String(maxSeq + 1).padStart(3, '0')}` : jobId;
  return chosen;
}
