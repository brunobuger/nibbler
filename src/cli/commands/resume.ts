import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CursorRunnerAdapter } from '../../core/session/cursor-adapter.js';
import type { RunnerAdapter } from '../../core/session/runner.js';
import { SessionController } from '../../core/session/controller.js';
import { GateController } from '../../core/gate/controller.js';
import { EvidenceCollector } from '../../core/evidence/collector.js';
import { JobManager } from '../../core/job-manager.js';
import { LedgerReader } from '../../core/ledger/reader.js';
import { LedgerWriter } from '../../core/ledger/writer.js';
import { readContract } from '../../core/contract/reader.js';
import { initJob, initWorkspace } from '../../workspace/layout.js';
import { git, isClean } from '../../git/operations.js';

import { isPidAlive, joinRepoPath, jobLedgerPath, readJobStatus } from '../jobs.js';
import { getRenderer } from '../ui/renderer.js';
import { theme } from '../ui/theme.js';
import { installCliCancellation } from '../cancel.js';
import { roleLabel } from '../ui/format.js';
import type { SpinnerHandle } from '../ui/spinner.js';

export interface ResumeCommandOptions {
  repoRoot?: string;
  jobId: string;
  runner?: RunnerAdapter;
}

/**
 * `nibbler resume <job-id>` — attaches to a running job when possible; otherwise resumes from the
 * persisted checkpoint (`current_phase` + `current_phase_actor_index`) in `status.json`.
 */
export async function runResumeCommand(opts: ResumeCommandOptions): Promise<{ ok: boolean; details?: unknown }> {
  const r = getRenderer();
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const jobId = opts.jobId;

  const status = await readJobStatus(repoRoot, jobId);
  const enginePid = status.engine_pid;

  if (enginePid && isPidAlive(enginePid)) {
    r.info(`Attaching to running job (engine_pid=${enginePid})...`);
    await attachToRunningJob(repoRoot, jobId, status);
    return { ok: true };
  }

  if (String(status.state) === 'completed') return { ok: true, details: 'Job already completed.' };
  if (String(status.state) === 'failed') return { ok: false, details: 'Job already failed (see history/status for evidence).' };
  if (String(status.state) === 'cancelled') return { ok: false, details: 'Job was cancelled (cannot resume automatically).' };
  if (String(status.state) === 'budget_exceeded') return { ok: false, details: 'Job exceeded budget (cannot resume automatically).' };

  // Restart the engine from the persisted checkpoint.
  const repo = git(repoRoot);
  if (!(await isClean(repo))) {
    return { ok: false, details: 'Working tree is not clean. Clean/stash changes before resuming a job.' };
  }

  r.info(`Resuming job ${theme.bold(jobId)} from phase ${theme.bold(status.current_phase ?? 'start')}...`);

  await initWorkspace(repoRoot);
  const jobPaths = await initJob(repoRoot, jobId);

  const contract = await safeReadContract(resolve(repoRoot, '.nibbler', 'contract'));
  if (!contract) return { ok: false, details: 'No contract found. Run `nibbler init` first.' };

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

  const job = {
    repoRoot,
    jobId,
    mode: status.mode ?? ('resume' as const),
    description: status.description ?? undefined,
    enginePid: process.pid,
    globalBudgetLimitMs: contract.globalLifetime.maxTimeMs,
    currentPhaseId: status.current_phase ?? (contract.phases[0]?.id ?? 'start'),
    currentPhaseActorIndex: status.current_phase_actor_index ?? 0,
    currentRoleId: status.current_role ?? null,
    startedAtIso: status.started_at,
    statusPath: jobPaths.statusPath,
    rolesCompleted: status.progress.roles_completed ?? [],
    rolesPlanned: [...(status.progress.roles_completed ?? []), ...(status.progress.roles_remaining ?? [])],
    state: 'executing' as const,
  };

  const cancellation = installCliCancellation({
    onCancel: async ({ signal }) => {
      r.warn('Cancelling job...');
      await jm.cancel(job, { signal, reason: 'signal' });
    },
  });
  try {
    const out = await jm.resumeContractJob(job, contract);
    if (out.ok) {
      r.success(`Job ${jobId} resumed and completed successfully.`);
    }
    return out.ok ? { ok: true } : { ok: false, details: out };
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
