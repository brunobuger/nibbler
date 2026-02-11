import type { Contract, RoleDefinition } from './contract/types.js';
import { checkBudget, checkGlobalBudget, shouldEnforceGate, verifyCompletion, verifyScope } from './policy-engine.js';
import type { CompletionResult, ScopeResult } from './policy-engine.js';
import type { EvidenceCollector } from './evidence/collector.js';
import type { LedgerWriter } from './ledger/writer.js';
import { LedgerReader } from './ledger/reader.js';
import type { GateController } from './gate/controller.js';
import type { JobState, SessionFeedbackSummaryV1, SessionUsage } from './job/types.js';
import { buildJobStatusSnapshotV1 } from './job/status.js';
import type { SessionController } from './session/controller.js';
import { fileExists, readJson, writeJson } from '../utils/fs.js';
import { addWorktree, commit, clean, diff, getCurrentBranch, getCurrentCommit, git, lsFiles, resetHard } from '../git/operations.js';
import type { DiffResult } from '../git/diff-parser.js';
import type { SessionHandle, SessionOutcome } from './session/types.js';
import { buildEffectiveContractForSession, isStructuralOutOfScopeViolation } from './scope/overrides.js';
import { readDelegationPlanYaml } from './delegation/parser.js';
import { validateDelegation } from './delegation/validator.js';
import type { DelegationTask } from './delegation/types.js';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { computeGateFingerprint } from './gate/fingerprint.js';
import picomatch from 'picomatch';

export interface ExecutionPlan {
  roles: string[];
}

export interface JobManagerHooks {
  onPhaseEnter?: (args: { job: JobState; phaseId: string; contract: Contract }) => Promise<void>;
  /**
   * Called after the role session completes, but before completion criteria are evaluated.
   * This enables engine-only materialization steps (e.g., copying staged artifacts into `.nibbler/jobs/<id>/plan/`).
   */
  beforeVerifyCompletion?: (args: { job: JobState; roleId: string; contract: Contract }) => Promise<void>;

  // ── Rendering hooks (CLI UX) ──────────────────────────────────────────
  /** Called when a role session starts. */
  onRoleStart?: (args: { roleId: string; job: JobState; attempt: number; maxAttempts: number }) => void;
  /** Called when a delegated role-planning session starts (execution phase). */
  onRolePlanStart?: (args: { roleId: string; job: JobState; attempt: number; maxAttempts: number }) => void;
  /** Called when a delegated role-planning session succeeds and plan is materialized. */
  onRolePlanComplete?: (args: { roleId: string; job: JobState; attempt: number; maxAttempts: number; implPlanRel: string }) => void;
  /** Called when a delegated role-planning session fails and will be retried. */
  onRolePlanFailed?: (args: { roleId: string; job: JobState; attempt: number; maxAttempts: number; details: unknown }) => void;
  /** Called when a role session completes successfully (before commit). */
  onRoleComplete?: (args: { roleId: string; job: JobState; durationMs: number; diff: DiffResult }) => void;
  /** Called when verification results are available. */
  onVerification?: (args: { roleId: string; scopePassed: boolean; completionPassed: boolean; scopeViolations?: Array<{ file: string }>; diff: DiffResult }) => void;
  /** Called when a role session is reverted due to failure. */
  onRoleReverted?: (args: { roleId: string; attempt: number; maxAttempts: number; scopePassed: boolean; completionPassed: boolean }) => void;
  /** Called when escalation is triggered. */
  onEscalation?: (args: { roleId: string; reason: string }) => void;
  /** Called when a role hand-off occurs (one role ends, next begins). */
  onHandoff?: (args: { fromRole: string; toRole: string }) => void;
}

export type JobOutcome =
  | { ok: true }
  | { ok: false; reason: 'failed' | 'budget_exceeded' | 'escalated' | 'cancelled'; details?: unknown };

export class JobManager {
  private cancelInfo: { signal?: string; reason?: string } | null = null;
  private activeHandle: SessionHandle | null = null;
  private finalized = false;

  constructor(
    private sessionController: SessionController,
    private gateController: GateController,
    private evidenceCollector: EvidenceCollector,
    private ledger: LedgerWriter,
    private hooks: JobManagerHooks = {}
  ) {}

  /**
   * Allow re-running orchestration on the same JobManager instance after a previous run
   * finalized (job_failed/job_completed/etc).
   *
   * Used by build-level recovery flows that intentionally retry after failure.
   */
  resetForRecovery(): void {
    this.finalized = false;
    this.cancelInfo = null;
  }

  /**
   * Stop only the active runner handle (best-effort), without finalization.
   * Used by force-exit cancellation paths where we must tear down children quickly.
   */
  async stopActiveSession(): Promise<void> {
    const active = this.activeHandle;
    if (!active) return;
    this.activeHandle = null;
    try {
      await this.sessionController.stopSession(active);
    } catch {
      // best-effort
    }
  }

  /**
   * Best-effort cancellation entrypoint for SIGINT/SIGTERM.
   * Captures evidence and writes `job_cancelled` to the ledger.
   */
  async cancel(job: JobState, info: { signal?: string; reason?: string } = {}): Promise<void> {
    this.cancelInfo = info;
    job.state = 'cancelled';
    job.sessionActive = false;
    job.sessionHandleId = null;
    job.sessionPid = null;
    await this.persist(job);

    if (this.activeHandle) {
      const active = this.activeHandle;
      this.activeHandle = null;
      try {
        await this.sessionController.stopSession(active);
      } catch {
        // best-effort
      }
    }

    await this.finalize(job, 'job_cancelled', { info });
  }

  /**
   * Phase-graph runner (Phase 9).
   * Follows successors starting from the contract start phase, enforcing gates by trigger `<from>-><to>`.
   */
  async runContractJob(job: JobState, contract: Contract): Promise<JobOutcome> {
    const start = findStartPhaseId(contract);
    if (!start) return { ok: false, reason: 'failed', details: 'No start phase found (phase graph invalid)' };
    job.currentPhaseId = start;
    job.currentPhaseActorIndex = 0;
    return await this.runContractJobInternal(job, contract, { startPhaseId: start, startActorIndex: 0, appendJobCreated: true });
  }

  async runContractJobFromPhase(job: JobState, contract: Contract, startPhaseId: string): Promise<JobOutcome> {
    job.currentPhaseId = startPhaseId;
    job.currentPhaseActorIndex = 0;
    return await this.runContractJobInternal(job, contract, { startPhaseId, startActorIndex: 0, appendJobCreated: true });
  }

  async resumeContractJob(job: JobState, contract: Contract): Promise<JobOutcome> {
    const start = job.currentPhaseId || findStartPhaseId(contract);
    if (!start) return { ok: false, reason: 'failed', details: 'No start phase found (phase graph invalid)' };
    // If the job was paused at a gate, resume by resolving that gate first.
    // This avoids re-running phase actors and prevents duplicate work/prompts after pauses/crashes.
    if (job.state === 'paused' && job.pendingGateId) {
      return await this.resumeFromPendingGate(job, contract);
    }
    return await this.runContractJobInternal(job, contract, {
      startPhaseId: start,
      startActorIndex: job.currentPhaseActorIndex ?? 0,
      appendJobCreated: false
    });
  }

  private async resumeFromPendingGate(job: JobState, contract: Contract): Promise<JobOutcome> {
    const gateId = String(job.pendingGateId ?? '').trim();
    if (!gateId) {
      job.state = 'executing';
      job.pendingGateId = null;
      await this.persist(job);
      return await this.runContractJobInternal(job, contract, {
        startPhaseId: job.currentPhaseId,
        startActorIndex: job.currentPhaseActorIndex ?? 0,
        appendJobCreated: false
      });
    }

    const gateDef = contract.gates.find((g) => g.id === gateId);
    if (!gateDef) {
      const out: JobOutcome = { ok: false, reason: 'failed', details: `Unknown pending gate '${gateId}'` };
      await this.finalizeForOutcome(job, out);
      return out;
    }

    // If we already have an approved resolution for this exact gate state, skip re-prompting.
    const auto = await this.tryAutoApproveGate(job, gateDef, contract);
    const resolution = auto ?? (await this.gateController.presentGate(gateDef, job, contract));
    const mappedRaw = gateDef.outcomes?.[resolution.decision];
    if (!mappedRaw) {
      const out: JobOutcome = {
        ok: false,
        reason: 'failed',
        details: { message: 'Gate outcome missing', gate: gateDef, resolution }
      };
      await this.finalizeForOutcome(job, out);
      return out;
    }
    const mapped = normalizeTransitionTarget(mappedRaw, contract);

    job.state = 'executing';
    job.pendingGateId = null;
    await this.persist(job);

    if (mapped === '__END__') {
      job.state = 'completed';
      job.currentRoleId = null;
      job.currentPhaseActorIndex = undefined;
      await this.persist(job);
      await this.finalize(job, 'job_completed', {});
      return { ok: true };
    }

    if (!phaseExists(contract, mapped)) {
      const out: JobOutcome = {
        ok: false,
        reason: 'failed',
        details: {
          message: 'Gate outcome points to unknown phase',
          gateId: gateDef.id,
          mappedRaw,
          mapped
        }
      };
      await this.finalizeForOutcome(job, out);
      return out;
    }

    // Continue orchestration from the mapped phase.
    return await this.runContractJobInternal(job, contract, {
      startPhaseId: mapped,
      startActorIndex: 0,
      appendJobCreated: false
    });
  }

  private jobLedgerPath(job: JobState): string {
    return join(job.repoRoot, '.nibbler', 'jobs', job.jobId, 'ledger.jsonl');
  }

  private async readLastGateResolution(job: JobState, gateId: string): Promise<{
    gateId: string;
    decision?: 'approve' | 'reject' | 'exception';
    fingerprint?: string;
  } | null> {
    try {
      const ledger = new LedgerReader(this.jobLedgerPath(job));
      const { entries } = await ledger.readAllSafe();
      for (let i = entries.length - 1; i >= 0; i--) {
        const e: any = entries[i];
        if (!e || e.type !== 'gate_resolved') continue;
        const data: any = e.data;
        if (!data || String(data.gateId ?? '') !== gateId) continue;
        const decisionRaw = data.decision ? String(data.decision) : undefined;
        const decision =
          decisionRaw === 'approve' || decisionRaw === 'reject' || decisionRaw === 'exception' ? decisionRaw : undefined;
        return {
          gateId,
          decision,
          fingerprint: data.fingerprint ? String(data.fingerprint) : undefined,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * If the most recent resolution for this gate was APPROVE and the gate fingerprint still matches,
   * we can safely re-apply approval without prompting (recovery/resume dedupe).
   *
   * IMPORTANT: we intentionally do NOT auto-apply REJECT to avoid creating silent loops.
   */
  private async tryAutoApproveGate(
    job: JobState,
    gateDef: Contract['gates'][number],
    contract: Contract
  ): Promise<{ decision: 'approve'; notes?: string } | null> {
    const last = await this.readLastGateResolution(job, gateDef.id);
    if (!last || last.decision !== 'approve' || !last.fingerprint) return null;
    const current = await computeGateFingerprint({ gateDef, job, contract });
    if (current.fingerprint !== last.fingerprint) return null;
    return { decision: 'approve', notes: 'auto-approved (unchanged)' };
  }

  private async runContractJobInternal(
    job: JobState,
    contract: Contract,
    opts: { startPhaseId: string; startActorIndex: number; appendJobCreated: boolean }
  ): Promise<JobOutcome> {
    const startPhaseId = opts.startPhaseId;
    const initialActorIndex = Math.max(0, opts.startActorIndex ?? 0);

    try {
      job.rolesPlanned ??= Array.from(new Set(contract.phases.flatMap((p) => p.actors)));
      job.rolesCompleted ??= [];
      job.state = 'executing';
      job.currentRoleId = null;
      job.currentPhaseId = startPhaseId;
      job.currentPhaseActorIndex = initialActorIndex;
      await this.persist(job);

      if (opts.appendJobCreated) {
        await this.ledger.append({ type: 'job_created', data: { jobId: job.jobId, repoRoot: job.repoRoot, mode: 'contract' } });
      }

      let phaseId: string = startPhaseId;
      let transitions = 0;
      let firstPhase = true;

      while (true) {
        if (this.cancelInfo) {
          const out: JobOutcome = { ok: false, reason: 'cancelled', details: { info: this.cancelInfo } };
          await this.finalizeForOutcome(job, out);
          return out;
        }

        transitions += 1;
        if (transitions > 50) {
          const out: JobOutcome = { ok: false, reason: 'failed', details: 'Too many phase transitions (possible loop)' };
          await this.finalizeForOutcome(job, out);
          return out;
        }

        const phase = contract.phases.find((p) => p.id === phaseId);
        if (!phase) {
          const out: JobOutcome = { ok: false, reason: 'failed', details: `Unknown phase '${phaseId}'` };
          await this.finalizeForOutcome(job, out);
          return out;
        }

        job.currentPhaseId = phaseId;
        if (!firstPhase) job.currentPhaseActorIndex = 0;
        await this.persist(job);
        if (this.hooks.onPhaseEnter) await this.hooks.onPhaseEnter({ job, phaseId, contract });

        // Delegation-driven execution: replace phase.actors[] iteration when we have a validated plan.
        if (phaseId === 'execution' && job.delegationPlan) {
          const { roleOrder, tasksByRole } = resolveDelegation(job.delegationPlan.tasks);
          job.rolesPlanned = roleOrder;
          job.rolesCompleted ??= [];
          await this.persist(job);

          const startIdx = firstPhase ? initialActorIndex : 0;
          let prevRoleId: string | null = startIdx > 0 ? (roleOrder[startIdx - 1] ?? null) : null;

          for (let i = startIdx; i < roleOrder.length; i++) {
            const roleId = roleOrder[i]!;

            if (prevRoleId && prevRoleId !== roleId) {
              this.hooks.onHandoff?.({ fromRole: prevRoleId, toRole: roleId });
            }

            job.currentPhaseActorIndex = i;
            job.currentRoleId = roleId;
            await this.persist(job);

            const tasks = tasksByRole.get(roleId) ?? [];
            const res = await this.runRoleSession(roleId, job, contract, { delegatedTasks: tasks });
            if (!res.ok) {
              await this.finalizeForOutcome(job, res);
              return res;
            }

            job.rolesCompleted.push(roleId);
            job.currentPhaseActorIndex = i + 1;
            prevRoleId = roleId;
            await this.persist(job);
          }

          firstPhase = false;
        } else {
        const startIdx = firstPhase ? initialActorIndex : 0;
        let prevRoleId: string | null = startIdx > 0 ? (phase.actors[startIdx - 1] ?? null) : null;
        for (let i = startIdx; i < phase.actors.length; i++) {
          const roleId = phase.actors[i]!;

          // Rendering hook: hand-off between roles
          if (prevRoleId && prevRoleId !== roleId) {
            this.hooks.onHandoff?.({ fromRole: prevRoleId, toRole: roleId });
          }

          job.currentPhaseActorIndex = i;
          job.currentRoleId = roleId;
          await this.persist(job);

          const delegatedTasks = (job.delegationPlan?.tasks ?? [])
            .filter((t) => t.roleId === roleId)
            .slice()
            .sort((a, b) => (a.priority ?? 9_999) - (b.priority ?? 9_999));

          const res = await this.runRoleSession(roleId, job, contract, {
            delegatedTasks: delegatedTasks.length > 0 ? delegatedTasks : undefined
          });
          if (!res.ok) {
            await this.finalizeForOutcome(job, res);
            return res;
          }

          // Mark as completed (for status/list/history UX).
          job.rolesCompleted ??= [];
          job.rolesCompleted.push(roleId);
          job.currentPhaseActorIndex = i + 1;
          prevRoleId = roleId;
          await this.persist(job);
        }

        firstPhase = false;
        }

        // Terminal phase ends the job, but may still have a terminal gate.
        // Convention: gates can target `${phaseId}->__END__` to run after the final phase completes.
        if (phase.isTerminal === true || phase.successors.length === 0) {
          const terminalTransition = `${phaseId}->__END__`;
          const terminalGate = shouldEnforceGate(terminalTransition, contract);
          if (terminalGate) {
            // Dedupe: if this exact gate was already approved and nothing relevant changed, skip re-prompting.
            const auto = await this.tryAutoApproveGate(job, terminalGate, contract);
            if (auto) {
            const mappedRaw = terminalGate.outcomes?.[auto.decision];
            if (mappedRaw) {
              const mapped = normalizeTransitionTarget(mappedRaw, contract);
              if (mapped === '__END__') break; // approve->__END__ is the common case
              if (!phaseExists(contract, mapped)) {
                const out: JobOutcome = {
                  ok: false,
                  reason: 'failed',
                  details: {
                    message: 'Gate outcome points to unknown phase',
                    gateId: terminalGate.id,
                    mappedRaw,
                    mapped
                  }
                };
                await this.finalizeForOutcome(job, out);
                return out;
              }
              phaseId = mapped;
              continue;
            }
            }

            job.state = 'paused';
            job.pendingGateId = terminalGate.id;
            await this.persist(job);

            const resolution = await this.gateController.presentGate(terminalGate, job, contract);
            const mappedRaw = terminalGate.outcomes?.[resolution.decision];
            if (!mappedRaw) {
              const out: JobOutcome = {
                ok: false,
                reason: 'failed',
                details: { message: 'Gate outcome missing', gate: terminalGate, resolution }
              };
              await this.finalizeForOutcome(job, out);
              return out;
            }
            const mapped = normalizeTransitionTarget(mappedRaw, contract);

            job.state = 'executing';
            job.pendingGateId = null;
            await this.persist(job);

            if (mapped === '__END__') break;
            if (!phaseExists(contract, mapped)) {
              const out: JobOutcome = {
                ok: false,
                reason: 'failed',
                details: {
                  message: 'Gate outcome points to unknown phase',
                  gateId: terminalGate.id,
                  mappedRaw,
                  mapped
                }
              };
              await this.finalizeForOutcome(job, out);
              return out;
            }
            phaseId = mapped;
            continue;
          }
          break;
        }

        // Default transition: choose successor with `on=done`, else first successor.
        const next = (phase.successors.find((s) => s.on === 'done') ?? phase.successors[0])?.next;
        if (!next) {
          const out: JobOutcome = { ok: false, reason: 'failed', details: `Phase '${phaseId}' has no successors` };
          await this.finalizeForOutcome(job, out);
          return out;
        }

        const transition = `${phaseId}->${next}`;
        const gateDef = shouldEnforceGate(transition, contract);
        if (gateDef) {
          // Dedupe: if this exact gate was already approved and nothing relevant changed, skip re-prompting.
          const auto = await this.tryAutoApproveGate(job, gateDef, contract);
          if (auto) {
            const mappedRaw = gateDef.outcomes?.[auto.decision];
            if (!mappedRaw) {
              const out: JobOutcome = {
                ok: false,
                reason: 'failed',
                details: { message: 'Gate outcome missing', gate: gateDef, resolution: auto }
              };
              await this.finalizeForOutcome(job, out);
              return out;
            }
            const mapped = normalizeTransitionTarget(mappedRaw, contract);
            if (mapped === '__END__') break;
            if (!phaseExists(contract, mapped)) {
              const out: JobOutcome = {
                ok: false,
                reason: 'failed',
                details: {
                  message: 'Gate outcome points to unknown phase',
                  gateId: gateDef.id,
                  mappedRaw,
                  mapped
                }
              };
              await this.finalizeForOutcome(job, out);
              return out;
            }
            phaseId = mapped;
            continue;
          }

          job.state = 'paused';
          job.pendingGateId = gateDef.id;
          await this.persist(job);

          const resolution = await this.gateController.presentGate(gateDef, job, contract);
          const mappedRaw = gateDef.outcomes?.[resolution.decision];
          if (!mappedRaw) {
            const out: JobOutcome = {
              ok: false,
              reason: 'failed',
              details: { message: 'Gate outcome missing', gate: gateDef, resolution }
            };
            await this.finalizeForOutcome(job, out);
            return out;
          }
          const mapped = normalizeTransitionTarget(mappedRaw, contract);
          job.state = 'executing';
          job.pendingGateId = null;
          await this.persist(job);
          if (mapped === '__END__') break;
          if (!phaseExists(contract, mapped)) {
            const out: JobOutcome = {
              ok: false,
              reason: 'failed',
              details: {
                message: 'Gate outcome points to unknown phase',
                gateId: gateDef.id,
                mappedRaw,
                mapped
              }
            };
            await this.finalizeForOutcome(job, out);
            return out;
          }
          phaseId = mapped;
          continue;
        }

        phaseId = next;
      }

      job.state = 'completed';
      job.currentRoleId = null;
      job.currentPhaseActorIndex = undefined;
      await this.persist(job);
      await this.finalize(job, 'job_completed', {});
      return { ok: true };
    } catch (err: any) {
      await this.stopActiveSession();
      job.sessionActive = false;
      job.sessionHandleId = null;
      job.sessionPid = null;
      job.state = job.state === 'cancelled' ? 'cancelled' : 'failed';
      await this.persist(job);
      const out: JobOutcome = {
        ok: false,
        reason: job.state === 'cancelled' ? 'cancelled' : 'failed',
        details: { message: String(err?.message ?? err) }
      };
      await this.finalizeForOutcome(job, out);
      return out;
    }
  }

  async runJob(job: JobState, contract: Contract, plan: ExecutionPlan): Promise<JobOutcome> {
    try {
      job.rolesPlanned ??= plan.roles;
      job.rolesCompleted ??= [];

      job.state = 'executing';
      await this.persist(job);
      await this.ledger.append({ type: 'job_created', data: { jobId: job.jobId, repoRoot: job.repoRoot } });

      for (const roleId of plan.roles) {
        job.currentRoleId = roleId;
        await this.persist(job);

        const res = await this.runRoleSession(roleId, job, contract);
        if (!res.ok) {
          await this.finalizeForOutcome(job, res);
          return res;
        }

        job.rolesCompleted ??= [];
        job.rolesCompleted.push(roleId);
        await this.persist(job);
      }

      job.state = 'completed';
      job.currentRoleId = null;
      await this.persist(job);
      await this.finalize(job, 'job_completed', {});
      return { ok: true };
    } catch (err: any) {
      await this.stopActiveSession();
      job.sessionActive = false;
      job.sessionHandleId = null;
      job.sessionPid = null;
      job.state = job.state === 'cancelled' ? 'cancelled' : 'failed';
      await this.persist(job);
      const out: JobOutcome = { ok: false, reason: job.state === 'cancelled' ? 'cancelled' : 'failed', details: { message: String(err?.message ?? err) } };
      await this.finalizeForOutcome(job, out);
      return out;
    }
  }

  private async runRoleSession(
    roleId: string,
    job: JobState,
    contract: Contract,
    options: { delegatedTasks?: DelegationTask[] } = {}
  ): Promise<JobOutcome> {
    const roleDef = mustRole(contract, roleId);
    job.attemptsByRole ??= {};
    job.feedbackByRole ??= {};
    let maxIterations = roleDef.budget.maxIterations ?? 1;
    job.currentRoleMaxIterations = maxIterations;
    let scopeExceptionBonusRetryUsed = false;
    // Resume durability: only on `nibbler resume` do we rehydrate attempts and scope overrides
    // from the ledger. For fresh builds and fix-mode recovery, each role invocation starts at attempt=1.
    const isResume = job.mode === 'resume';
    if (isResume) {
      await this.rehydrateRoleStateFromLedger(job, roleId);
    }

    // Clear stale feedback from a previous phase so the overlay doesn't show
    // irrelevant failure details (e.g. planning failure in scaffold overlay).
    if (!isResume && job.feedbackByRole[roleId]) {
      delete job.feedbackByRole[roleId];
      await this.persist(job);
    }
    if (!isResume) {
      job.feedbackHistoryByRole ??= {};
      delete job.feedbackHistoryByRole[roleId];
    }

    const prevAttempt = isResume ? (job.attemptsByRole?.[roleId] ?? 0) : 0;
    let attempt = prevAttempt > 0 ? prevAttempt + 1 : 1;
    while (attempt <= maxIterations) {
      job.attemptsByRole[roleId] = attempt;
      await this.persist(job);

      const globalBudget = checkGlobalBudget(job, contract);
      if (!globalBudget.passed) {
        job.state = 'budget_exceeded';
        await this.persist(job);
        await this.finalize(job, 'job_budget_exceeded', { exceeded: globalBudget.exceeded });
        return { ok: false, reason: 'budget_exceeded', details: globalBudget };
      }

      // Defensive: if the git worktree metadata was removed (stale worktree),
      // repair it before any git operations so orchestration can continue.
      await this.ensureWorktreeHealthy(job).catch(() => undefined);
      const repo = git(jobWorkspaceRoot(job));
      const attemptStart = Date.now();

      const preSessionCommit = await getCurrentCommit(repo);
      job.preSessionCommit = preSessionCommit;
      await this.persist(job);

      // Delegation-driven execution runs a plan-step before implementation.
      let implPlanRel: string | null = null;
      if (job.currentPhaseId === 'execution' && options.delegatedTasks && options.delegatedTasks.length > 0) {
        this.hooks.onRolePlanStart?.({ roleId, job, attempt, maxAttempts: maxIterations });
        const planRes = await this.runDelegatedPlanStep(roleId, job, contract, {
          attempt,
          delegatedTasks: options.delegatedTasks
        });
        if (!planRes.ok) {
          // Reset to pre-session commit (plan mode should not change tracked files; this is best-effort safety).
          await resetHard(repo, preSessionCommit);
          await clean(repo);
          job.feedbackByRole[roleId] = {
            kind: 'delegated_plan_failed',
            attempt,
            details: planRes.details
          };
          this.hooks.onRolePlanFailed?.({
            roleId,
            job,
            attempt,
            maxAttempts: maxIterations,
            details: planRes.details
          });
          await this.persist(job);
          attempt += 1;
          continue;
        }
        implPlanRel = planRes.implPlanRel;
        this.hooks.onRolePlanComplete?.({
          roleId,
          job,
          attempt,
          maxAttempts: maxIterations,
          implPlanRel
        });
      }

      await this.ledger.append({ type: 'session_start', data: { role: roleId, commit: preSessionCommit, mode: 'implement' } } as any);

      // Rendering hook: role session starting
      this.hooks.onRoleStart?.({ roleId, job, attempt, maxAttempts: maxIterations });

      job.sessionActive = true;
      job.sessionStartedAtIso = new Date().toISOString();
      job.sessionHandleId = null;
      job.sessionPid = null;
      job.sessionLastActivityAtIso = null;
      job.sessionSeq = (job.sessionSeq ?? 0) + 1;
      job.sessionLogPath = `.nibbler/jobs/${job.jobId}/evidence/sessions/${job.sessionSeq}-${roleId}-${job.currentPhaseId}-${attempt}.log`;
      await this.persist(job);

      const effectiveContract = buildEffectiveContractForSession(contract, job, roleId, {
        phaseId: job.currentPhaseId,
        attempt
      });

      const planningPhase = effectiveContract.phases.find((p) => p.id === 'planning');
      const planningOutputBoundaries = planningPhase?.outputBoundaries ?? [];
      const executionPhase = effectiveContract.phases.find((p) => p.id === 'execution');
      const executionActors = executionPhase?.actors ?? [];
      const executionActorSet = new Set(executionActors);
      const roleScopeSummary = effectiveContract.roles
        .filter((r) => executionActorSet.size === 0 || executionActorSet.has(r.id))
        .map((r) => {
          const max = 8;
          const shown = r.scope.slice(0, max);
          const suffix = r.scope.length > max ? `, ... (+${r.scope.length - max} more)` : '';
          return `- ${r.id}: ${shown.join(', ')}${suffix}`;
        })
        .join('\n');

      const sharedScopeSummary = (effectiveContract.sharedScopes ?? [])
        .map((s) => `- Shared by [${s.roles.join(', ')}]: ${s.patterns.join(', ')}`)
        .join('\n');
      const retryFeedbackLines = buildPromptRetryFeedbackLines(job.feedbackByRole?.[roleId]);

      const planningBootstrapPrompt =
        roleId === 'architect' && job.currentPhaseId === 'planning'
          ? [
              'You are in the PLANNING phase.',
              '',
              '## Requirement',
              job.description?.trim()
                ? job.description.trim()
                : '(not provided — read @vision.md and @architecture.md for context)',
              ...(retryFeedbackLines.length ? ['', ...retryFeedbackLines] : []),
              '',
              '## Planning principles',
              'Right-size the plan: cover the requirement thoroughly, but do not gold-plate.',
              '- IMPORTANT: Before planning, examine the existing codebase (@package.json, source directories, and relevant files). If the project already has implementations, ONLY plan tasks for what is actually missing, broken, or needs improvement. Do NOT re-plan work that is already done and working.',
              '- Each task MUST require the agent to create or modify at least one file matching its scopeHints. If the code already exists and works, do NOT include that as a task — the delegation coverage check will fail because the agent has nothing to change.',
              '- Deliver a complete, working result — include error handling, validation, and tests when the requirement implies them.',
              '- Use sound engineering judgment: good abstractions are fine when they serve the requirement; premature abstractions are not.',
              '- Do NOT add features, services, or infrastructure the requirement does not ask for.',
              '- Do NOT introduce new frameworks or tooling unless the requirement or existing codebase clearly calls for it.',
              '- Keep each task focused on one clear deliverable. Prefer <= 6 total tasks and <= 3 roles unless more are genuinely needed.',
              '- If the requirement is broad, prioritize a single-session MVP slice first. Defer optional/advanced integrations unless explicitly required for this build.',
              '- Do NOT implement or scaffold code. Only write the delegation plan.',
              '',
              '## Output',
              `Write these files under: .nibbler-staging/plan/${job.jobId}/`,
              '1. `delegation.yaml` (REQUIRED — engine validates schema + scopeHints)',
              '2. `acceptance.md` (REQUIRED — summarize what "done" looks like for this build)',
              '',
              'The engine copies them to .nibbler/jobs/<id>/plan/ before verification.',
              '',
              'Output boundaries (engine-verified):',
              ...planningOutputBoundaries.map((b) => `- ${b}`),
              '',
              '## Schema',
              '```yaml',
              'version: 1',
              'tasks:',
              '  - taskId: t1',
              '    roleId: <role>',
              '    description: "<specific, single deliverable>"',
              '    scopeHints: ["<folder>/**"]',
              '    priority: 1',
              '    dependsOn: []',
              '```',
              'Rules:',
              '- Each scopeHint MUST match a pattern in the assigned role\'s scope or shared scope (validated by engine). Use the exact role scope patterns listed below — do NOT invent paths.',
              executionActors.length
                ? `- Delegation tasks MUST target execution-phase actors only: ${executionActors.join(', ')}. Do NOT assign tasks to other roles (architect, docs, etc.) unless they are execution-phase actors.`
                : '- Delegation tasks MUST target execution-phase actors only (do NOT assign tasks to architect/docs/scaffold).',
              '- Delegation coverage is enforced: each assigned role must produce file changes matching its scopeHints. Choose scopeHints that correspond to files the role will actually create or modify.',
              '- Include `dependsOn: []` (empty array) when a task has no dependencies. Reference taskIds for ordering dependencies.',
              '- IMPORTANT: if a completion criterion includes `command_succeeds: npm test`, tasks must NOT modify the root `"test"` script in package.json. E2E/integration test tools should use separate scripts (e.g. `"test:e2e"`).',
              '- SDET/test roles: ONLY assign tasks with scopeHints inside the test role\'s own scope (e.g. `tests/**`, `playwright.config.*`). Do NOT assign tasks that require modifying frontend/backend source files (e.g. adding data-testid attributes). If E2E tests need specific attributes in source code, assign that work to the owning role (frontend/backend) instead, or include the specific files in sharedScopes.',
              '',
              'Role scopes (execution-phase roles only):',
              roleScopeSummary,
              ...(sharedScopeSummary ? ['', 'Shared scopes:', sharedScopeSummary] : []),
              '',
              '## Finishing up',
              'After writing the delegation plan and acceptance criteria, signal completion by outputting this as plain text in your response (NOT inside any file):',
              '',
              '```',
              'NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"planning artifacts written"}',
              '```',
              '',
              'CRITICAL: The NIBBLER_EVENT line is a protocol signal. NEVER write it into any file.'
            ].join('\n')
          : undefined;

      const scaffoldBootstrapPrompt =
        roleId === 'architect' && job.currentPhaseId === 'scaffold'
          ? (() => {
              const scaffoldPhase = effectiveContract.phases.find((p) => p.id === 'scaffold');
              const scaffoldRole = mustRole(effectiveContract, 'architect');
              const scopeList = scaffoldRole.scope.map((s) => `\`${s}\``).join(', ');
              const allowedPathsList = (scaffoldRole.authority.allowedPaths ?? []).map((s) => `\`${s}\``).join(', ');
              const sharedForArchitect = (effectiveContract.sharedScopes ?? [])
                .filter((s) => s.roles.includes('architect'))
                .flatMap((s) => s.patterns)
                .map((s) => `\`${s}\``);
              const sharedLine = sharedForArchitect.length ? sharedForArchitect.join(', ') : '(none)';
              const outputBounds = scaffoldPhase?.outputBoundaries ?? [];
              const criteriaLines = (scaffoldPhase?.completionCriteria ?? []).map((c: any) => {
                if (c.type === 'artifact_exists') return `- File must exist: \`${c.pattern}\``;
                if (c.type === 'command_succeeds') return `- Command must pass: \`${c.command}\``;
                return `- ${c.type}`;
              });
              return [
                'You are in the SCAFFOLD phase.',
                '',
                '## Goal',
                'Create the minimum viable project scaffold so execution roles can implement features.',
                ...(retryFeedbackLines.length ? ['', ...retryFeedbackLines] : []),
                '',
                '## Your scope (engine-verified — files outside these patterns cause REVERT)',
                `Direct scope: ${scopeList}`,
                ...(allowedPathsList ? [`Allowed paths (extra write access): ${allowedPathsList}`] : []),
                `Shared scope: ${sharedLine}`,
                'Files outside these combined patterns will be treated as scope violations and the ENTIRE session is reverted.',
                '',
                '## Completion criteria (engine-verified — ALL must pass or session is reverted)',
                ...criteriaLines,
                '',
                '## Output boundaries',
                ...outputBounds.map((b) => `- \`${b}\``),
                '',
                '## CRITICAL: Do not create out-of-scope files',
                '- Only create/modify files within: Direct scope + Allowed paths + Shared scope.',
                '- If any output boundary appears to fall outside your allowed write paths, IGNORE it and do not create placeholders there.',
                '',
                '## Guidelines',
                '- Read `@ARCHITECTURE.md` and `@vision.md` first to understand the intended tech stack, directory layout, and tooling.',
                '- Create project files at paths that satisfy the completion criteria above.',
                '- The root `package.json` MUST include a `"test"` script that exits 0. Use `"test": "echo ok"` (simplest). Execution roles will add real tests later.',
                '- The root `package.json` MUST include a `"build"` script that performs a production build. This is used as a completion criterion to catch unresolved imports.',
                '- Keep scaffold minimal: project config, directory skeleton, placeholder entry points. Do NOT implement product features or domain logic.',
                '- Do NOT touch `README.md` (the docs role owns it in the ship phase).',
                '- Run `npm install` after writing `package.json` so `package-lock.json` is created.',
                '- Add build artifacts and generated files to `.gitignore`. This prevents scope violations from auto-generated files.',
                '- For multi-directory layouts, run `npm install` in each directory that has a `package.json`.',
                '- Ensure only the directories WITHIN your allowed write paths exist (create placeholders only when needed). Do NOT create placeholders outside your allowed write paths.',
                '',
                '## Tooling config completeness (CRITICAL)',
                '- Read `@ARCHITECTURE.md` to identify every tool, framework, and build dependency the project uses.',
                '- For EACH tool/framework, create ALL required config files. If a dependency requires a config file to function (e.g. CSS preprocessors need their config, bundlers need their config, linters need their config), that file MUST exist.',
                '- Without proper config files, tools will silently fail or produce broken output (blank screens, unstyled pages, missing transpilation).',
                '- After writing configs, run the build and dev server to verify they work end-to-end. If either fails, diagnose and fix the config.',
                '',
                '## Dev server (CRITICAL for local_http_smoke)',
                '- The root `package.json` MUST include a `"dev"` script that starts the dev server.',
                '- If the project has a nested/non-standard directory structure, the `"dev"` and `"build"` scripts MUST be configured so they resolve paths correctly. Test BOTH `npm run dev` and `npm run build` before finishing.',
                '- Verify `npm run dev` actually starts and serves HTTP before finishing scaffold.',
                '- The dev server should only watch its source directory (not the entire project root) to avoid file-watcher exhaustion in worktrees.',
                '',
                '## Dependency completeness (CRITICAL)',
                '- Every `import` in every source file MUST resolve after `npm install`.',
                '- After writing `package.json`, run `npm install` and verify it succeeds.',
                '- Run the project\'s build command and type-checker to verify everything resolves before finishing.',
                '',
                '## Output',
                'Implement scaffold changes now. After all files are written, signal completion by outputting this as plain text in your response (NOT inside any file):',
                '',
                '```',
                'NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"scaffold ready"}',
                '```',
                '',
                'CRITICAL: The NIBBLER_EVENT line is a protocol signal. NEVER write it into any file.'
              ].join('\n');
            })()
          : undefined;

      const docsBootstrapPrompt =
        roleId === 'docs' && job.currentPhaseId === 'ship'
          ? (() => {
              const phase = effectiveContract.phases.find((p) => p.id === job.currentPhaseId);
              const md = phase?.completionCriteria?.find((c: any) => c?.type === 'markdown_has_headings') as any;
              const required = Array.isArray(md?.requiredHeadings) ? (md.requiredHeadings as string[]) : [];
              const minChars = typeof md?.minChars === 'number' ? md.minChars : null;
              const requiredLines = required.length ? required.map((h) => `- ${h}`).join('\n') : '(none)';
              return [
                'You are in the SHIP phase (docs).',
                '',
                '## Goal',
                'Produce a ship-ready `README.md` that passes the engine checks.',
                ...(retryFeedbackLines.length ? ['', ...retryFeedbackLines] : []),
                '',
                '## IMPORTANT: Required headings (engine-verified)',
                'Your `README.md` MUST contain these EXACT headings (plain text, NO emoji prefixes):',
                requiredLines,
                '',
                'Use exactly these markdown headings, for example:',
                ...required.map((h) => `  \`## ${h}\``),
                '',
                ...(minChars != null ? [`Minimum total file length: ${minChars} characters. Write substantive content under each heading.`, ''] : []),
                '## Content guidelines',
                '- Read the codebase (`@package.json`, `@vision.md`, `@ARCHITECTURE.md`) to write accurate instructions.',
                '- The "Install" section should list ALL prerequisites and exact commands to install dependencies.',
                '- The "Quickstart" section should show how to start the app and what URL to visit.',
                '- The "Local development" section (if required) should cover how to run the full stack locally (frontend + backend/database).',
                '- Do NOT invent commands that don\'t exist in `package.json`. Reference ACTUAL scripts.',
                '',
                '## Scope',
                'Only write `README.md`. Do NOT modify any other files.',
                '',
                '## Finishing up',
                'After writing README.md, signal completion by outputting this line as plain text in your response (NOT inside the file):',
                '',
                '```',
                'NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"README ready"}',
                '```',
                '',
                'CRITICAL: The NIBBLER_EVENT line is a protocol signal. It must NEVER appear inside README.md or any other file content.'
              ].join('\n');
            })()
          : undefined;

      const sessionMode: 'plan' | 'implement' =
        roleId === 'architect' && job.currentPhaseId === 'planning' ? 'plan' : 'implement';

      const executionBootstrapPrompt = implPlanRel
        ? (() => {
            const execPhase = effectiveContract.phases.find((p) => p.id === job.currentPhaseId);
            const hasCommandCriterion = (execPhase?.completionCriteria ?? []).some((c: any) => c.type === 'command_succeeds');
            const commandCriteria = (execPhase?.completionCriteria ?? []).filter((c: any) => c.type === 'command_succeeds').map((c: any) => c.command);
            const hasLocalHttpSmoke = (execPhase?.completionCriteria ?? []).some((c: any) => c.type === 'local_http_smoke');
            const execCriteria = (execPhase?.completionCriteria ?? []).map((c: any) => {
              if (c.type === 'command_succeeds') return `- \`${c.command}\` must pass`;
              if (c.type === 'diff_non_empty') return '- diff must be non-empty (you must change files)';
              if (c.type === 'artifact_exists') return `- File must exist: \`${c.pattern}\``;
              if (c.type === 'local_http_smoke') return `- Dev server must start and respond HTTP 200 at \`${c.url}\` (command: \`${c.startCommand}\`, timeout: ${c.timeoutMs ?? 60000}ms)`;
              return `- ${c.type}`;
            });
            const commandWarning = hasCommandCriterion
              ? [
                  '',
                  '## Command stability',
                  `The engine runs ${commandCriteria.map(c => `\`${c}\``).join(', ')} after your session; keep them passing.`,
                  'Do not replace the root `"test"` script. Add separate scripts for extra test suites (for example `"test:e2e"`).',
                ]
              : [];
            const httpSmokeWarning = hasLocalHttpSmoke
              ? [
                  '',
                  '## Dev server stability',
                  'The engine runs `local_http_smoke` and expects HTTP 200. Keep the `"dev"` script and dev config working end-to-end.',
                ]
              : [];
            const delegatedTasksSummary = options.delegatedTasks?.length
              ? options.delegatedTasks.map((t) =>
                  `- [${t.taskId}] ${t.description}${t.scopeHints?.length ? ` → files must match: ${t.scopeHints.join(', ')}` : ''}`
                ).join('\n')
              : null;
            return [
              `Execute the implementation plan at: ${implPlanRel}`,
              '',
              'Follow the plan closely. Implement each step thoroughly but do not add features or refactors the plan does not call for.',
              ...(retryFeedbackLines.length ? ['', ...retryFeedbackLines] : []),
              '',
              '## Scope constraint',
              'Only create/modify files within your declared scope and shared scope (shown in the overlay above). Out-of-scope files cause the ENTIRE session to be reverted.',
              '- "Test-related" does NOT mean in-scope by default. Config files (for example Playwright/Jest/Vitest configs) are only allowed if their exact path matches your declared scope/shared patterns.',
              ...commandWarning,
              ...httpSmokeWarning,
              '',
              '## Completion criteria (ALL must pass)',
              ...execCriteria,
              '- Delegation coverage: for EACH assigned task, you must create/modify at least one file matching its scopeHints (listed below).',
              ...(delegatedTasksSummary ? ['', '## Your assigned tasks (must have file changes for each)', delegatedTasksSummary] : []),
              '',
              '',
              '## CRITICAL: Write files FIRST, run commands SECOND',
              '- You MUST create/modify source files BEFORE running any test or validation commands.',
              '- Running long commands (e.g. `npm run test:e2e`, `npx playwright test`, `npm test`) BEFORE writing files risks an inactivity timeout that kills your session with 0 file changes.',
              '- Pattern to follow: 1) Read plan → 2) Write/edit all files → 3) Run validation commands → 4) Fix issues if any.',
              '- NEVER run E2E tests or dev servers as your first action. Write code first.',
              '- The `diff_non_empty` criterion requires at least one file change. If you believe the code is already correct, find a meaningful improvement to make (e.g. better types, explicit qualifiers, documentation).',
              '',
              '## Quality bar',
              '- Run `npm install` after any dependency changes and verify it succeeds.',
              '- Every import in your code MUST resolve. Do not reference packages not in package.json. If you add an import, add the dependency to package.json AND run `npm install`.',
              '- After writing all your code, run `npm run build` (if the script exists) to verify no unresolved imports or build errors. Fix any errors before finishing.',
              '- If you create new files, make sure they are importable from existing code paths.',
              '- Do NOT modify files outside your declared scope — the ENTIRE session will be reverted.',
              '- Do NOT modify build/dev server configuration files unless your plan explicitly requires it.',
              '- Read `@ARCHITECTURE.md` and `@package.json` before adding any new dependency. Do NOT introduce frameworks or tooling that conflict with the existing stack.',
              '',
              'If you hit a blocker, output this as plain text in your response (NOT inside any file):',
              '',
              '```',
              'NIBBLER_EVENT {"type":"NEEDS_ESCALATION","reason":"<what blocked you>"}',
              '```',
            ].join('\n');
          })()
        : undefined;

      let handle: SessionHandle | null = null;
      let outcome: SessionOutcome | null = null;
      try {
        handle = await this.sessionController.startSession(roleId, job, effectiveContract, {
          mode: sessionMode,
          delegatedTasks: options.delegatedTasks,
          implementationPlanRel: implPlanRel ?? undefined,
          bootstrapPrompt: executionBootstrapPrompt
            ?? planningBootstrapPrompt ?? scaffoldBootstrapPrompt ?? docsBootstrapPrompt
        });
        this.activeHandle = handle;
        job.sessionHandleId = handle.id;
        job.sessionPid = handle.pid ?? null;
        job.sessionLastActivityAtIso = handle.lastActivityAtIso ?? null;
        await this.persist(job);
        outcome = await this.sessionController.waitForCompletion(handle, roleDef.budget, {
          onHeartbeat: ({ lastActivityAtIso }) => this.persistSessionHeartbeat(job, lastActivityAtIso)
        });
      } finally {
        await this.closeSession(job, handle);
      }
      if (!outcome) {
        throw new Error(`Session for role '${roleId}' ended without an outcome`);
      }

      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/25aab501-c72a-437e-b834-e0245fea140d',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'build-e2e-retry',hypothesisId:'H5',location:'src/core/job-manager.ts:runRoleSession',message:'session outcome captured',data:{jobId:job.jobId,phaseId:job.currentPhaseId,roleId,attempt,outcomeKind:outcome.kind,eventType:outcome.kind==='event' ? outcome.event.type : null,eventSummary:outcome.kind==='event' ? (outcome.event as any).summary ?? null : null,exitCode:outcome.kind==='process_exit' ? outcome.exitCode ?? null : null,signal:outcome.kind==='process_exit' ? outcome.signal ?? null : null},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      // Best-effort: materialize handoff artifact for this session (all sessions, plan or implement).
      // This is not enforced as a completion criterion.
      await this.materializeHandoffBestEffort(job, roleId, job.currentPhaseId).catch(() => undefined);

      if (job.state === 'cancelled' || this.cancelInfo) {
        return { ok: false, reason: 'cancelled', details: { cancelled: true, info: this.cancelInfo } };
      }

      // Delegation-driven escalation: worker can request Architect guidance.
      if (outcome.kind === 'event' && outcome.event.type === 'NEEDS_ESCALATION' && roleId !== 'architect') {
        await this.ledger.append({
          type: 'session_escalated',
          data: {
            jobId: job.jobId,
            role: roleId,
            reason: 'needs_escalation',
            attempt,
            event: outcome.event
          }
        });

        // Revert any partial changes before escalation.
        await resetHard(repo, preSessionCommit);
        await clean(repo);

        const guidance = await this.runEscalationResolutionByArchitect(job, contract, {
          failedRoleId: roleId,
          attempt,
          event: outcome.event,
          delegatedTasks: options.delegatedTasks ?? [],
          implementationPlanRel: implPlanRel
        });

        job.feedbackByRole ??= {};
        job.feedbackByRole[roleId] = {
          kind: 'architect_guidance',
          event: outcome.event,
          guidance
        };
        await this.persist(job);

        attempt += 1;
        continue;
      }

      if (outcome.kind === 'budget_exceeded') {
        await resetHard(repo, preSessionCommit);
        await clean(repo);
        await this.ledger.append({
          type: 'session_reverted',
          data: { role: roleId, attempt, reason: 'session_budget_exceeded' }
        });
        job.feedbackByRole ??= {};
        job.feedbackByRole[roleId] = {
          kind: 'session_timeout',
          reason: 'budget_exceeded',
          attempt,
          message: 'Session exceeded its maxTimeMs budget and was terminated.'
        } as any;
        await this.persist(job);
        return { ok: false, reason: 'budget_exceeded', details: { roleId, attempt, outcome } };
      }

      if (outcome.kind === 'inactive_timeout') {
        await resetHard(repo, preSessionCommit);
        await clean(repo);
        await this.ledger.append({
          type: 'session_reverted',
          data: { role: roleId, attempt, reason: 'session_inactive_timeout' }
        });
        job.feedbackByRole ??= {};
        job.feedbackByRole[roleId] = {
          kind: 'session_timeout',
          reason: 'inactive_timeout',
          attempt,
          message: 'Session produced no activity before the inactivity timeout and was terminated.'
        } as any;
        await this.persist(job);
        return { ok: false, reason: 'failed', details: { roleId, attempt, outcome } };
      }

      if (outcome.kind === 'process_exit') {
        const hasSignal = typeof outcome.signal === 'string' && outcome.signal.trim().length > 0;
        const hasExitCode = typeof outcome.exitCode === 'number';
        const exitedWithErrorCode = hasExitCode && outcome.exitCode !== 0;
        const unexpectedDeath = hasSignal && outcome.signal !== null;
        const exitedWithoutProtocol =
          (hasExitCode && outcome.exitCode === 0 && !hasSignal) ||
          (!hasExitCode && !hasSignal);

        // Fallback path: Cursor exited without a protocol event.
        // Continue with deterministic post-session verification instead of failing immediately.
        if (exitedWithoutProtocol) {
          await this.ledger.append({
            type: 'custom_check',
            data: {
              kind: 'session_protocol_missing',
              role: roleId,
              attempt,
              exitCode: outcome.exitCode ?? null,
              signal: outcome.signal ?? null
            }
          } as any);
          job.feedbackByRole ??= {};
          job.feedbackByRole[roleId] = {
            ...(job.feedbackByRole?.[roleId] && typeof job.feedbackByRole[roleId] === 'object'
              ? (job.feedbackByRole[roleId] as any)
              : {}),
            kind: 'session_protocol_missing',
            attempt,
            exitCode: outcome.exitCode ?? null,
            signal: outcome.signal ?? null,
            engineHint:
              'Previous attempt exited without an explicit NIBBLER_EVENT completion signal. ' +
              'Do the work normally, then end your final response with a single `NIBBLER_EVENT {"type":"PHASE_COMPLETE",...}` line.'
          };
          await this.persist(job);
        } else if (exitedWithErrorCode || unexpectedDeath) {
          await resetHard(repo, preSessionCommit);
          await clean(repo);
          await this.ledger.append({
            type: 'session_reverted',
            data: {
              role: roleId,
              attempt,
              reason: 'session_process_exit',
              exitCode: outcome.exitCode ?? null,
              signal: outcome.signal ?? null
            }
          });
          job.feedbackByRole ??= {};
          job.feedbackByRole[roleId] = {
            ...(job.feedbackByRole?.[roleId] && typeof job.feedbackByRole[roleId] === 'object'
              ? (job.feedbackByRole[roleId] as any)
              : {}),
            kind: 'session_process_exit',
            attempt,
            exitCode: outcome.exitCode ?? null,
            signal: outcome.signal ?? null,
            engineHint:
              `Previous attempt exited before completion (exitCode=${String(outcome.exitCode ?? 'null')}, signal=${String(
                outcome.signal ?? 'null'
              )}). Keep changes focused, write files first, and end with a valid NIBBLER_EVENT line.`
          };
          await this.persist(job);
          attempt += 1;
          continue;
        }
      }

      // If the session (or environment) damaged worktree metadata, repair before diffing.
      const repairedAfterSession = await this.ensureWorktreeHealthy(job).catch(() => ({ repaired: false as const }));
      if (repairedAfterSession.repaired) {
        job.feedbackByRole ??= {};
        job.feedbackByRole[roleId] = {
          kind: 'worktree_repaired',
          attempt,
          message:
            'Engine repaired a broken git worktree (missing .git/worktrees metadata). ' +
            'Your uncommitted changes could not be verified and may have been discarded. ' +
            'Retry the session and do NOT modify `.git/**` or run `git worktree` commands.'
        } as any;
        await this.persist(job);
        attempt += 1;
        continue;
      }

      const dAll = await diff(repo, preSessionCommit);
      const d = filterEngineFiles(dAll);
      job.lastDiff = d;
      await this.persist(job);
      const prematurePhaseComplete = outcome.kind === 'event' && outcome.event.type === 'PHASE_COMPLETE';
      if (outcome.kind === 'event' && outcome.event.type === 'PHASE_COMPLETE' && d.files.length === 0) {
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/25aab501-c72a-437e-b834-e0245fea140d',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'build-e2e-retry',hypothesisId:'H5',location:'src/core/job-manager.ts:runRoleSession',message:'phase_complete event had empty diff',data:{jobId:job.jobId,phaseId:job.currentPhaseId,roleId,attempt,eventSummary:(outcome.event as any).summary ?? null},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      }

      const isEmptyDiff = d.files.length === 0;
      const effectiveRoleDef = mustRole(effectiveContract, roleId);
      const scope = verifyScope(d, effectiveRoleDef, effectiveContract);
      if (this.hooks.beforeVerifyCompletion) {
        await this.hooks.beforeVerifyCompletion({ job, roleId, contract });
      }
      const completion = await verifyCompletion(roleId, job, effectiveContract);

      // Engine-level completion extension: planning must produce a valid delegation plan.
      // This is intentionally contract-independent to enforce delegation-driven execution.
      if (roleId === 'architect' && job.currentPhaseId === 'planning') {
        const delegationCriterion = await this.verifyDelegationPlanIfPresent(job, effectiveContract);
        completion.criteriaResults.push(delegationCriterion);
        completion.passed = completion.criteriaResults.every((r) => r.passed);
      }

      const diffEvidence = await this.evidenceCollector.recordDiff(roleId, d);
      const scopeEvidencePath = await this.evidenceCollector.recordScopeCheck(roleId, scope);
      const completionEvidencePath = await this.evidenceCollector.recordCompletionCheck(roleId, completion);

      await this.ledger.append({
        type: 'scope_check',
        data: {
          role: roleId,
          attempt,
          passed: scope.passed,
          violations: scope.violations,
          diff: diffEvidence,
          scopeEvidencePath
        }
      });
      await this.ledger.append({
        type: 'completion_check',
        data: {
          role: roleId,
          attempt,
          passed: completion.passed,
          criteriaResults: (completion as any).criteriaResults,
          completionEvidencePath
        }
      });

      const usage: SessionUsage = {
        iterations: attempt,
        elapsedMs: Date.now() - attemptStart,
        diffLines: d.summary.additions + d.summary.deletions
      };
      const budget = checkBudget(usage, roleDef);

      // Rendering hook: verification results
      this.hooks.onVerification?.({
        roleId,
        scopePassed: scope.passed,
        completionPassed: completion.passed,
        scopeViolations: scope.passed ? undefined : (scope as any).violations,
        diff: d,
      });

      if (scope.passed && completion.passed) {
        const durationMs = Date.now() - attemptStart;
        await commit(repo, `[nibbler:${job.jobId}] ${roleId} complete`);
        await this.ledger.append({ type: 'session_complete', data: { role: roleId, outcome } });

        // Rendering hook: role completed
        this.hooks.onRoleComplete?.({ roleId, job, durationMs, diff: d });
        return { ok: true };
      }

      // Failure: revert and retry
      await resetHard(repo, preSessionCommit);
      await clean(repo);
      await this.ledger.append({
        type: 'session_reverted',
        data: { role: roleId, attempt, scopePassed: scope.passed, completionPassed: completion.passed }
      });

      // Rendering hook: role reverted
      this.hooks.onRoleReverted?.({
        roleId,
        attempt,
        maxAttempts: maxIterations,
        scopePassed: scope.passed,
        completionPassed: completion.passed,
      });

      const attemptSummary: SessionFeedbackSummaryV1 = buildAttemptSummary({
        attempt,
        scope,
        completion,
        isEmptyDiff,
      });
      if (prematurePhaseComplete && isEmptyDiff) {
        const extra =
          'You emitted PHASE_COMPLETE before producing required file changes. Do NOT emit NIBBLER_EVENT until delegation.yaml and acceptance.md are written to `.nibbler-staging/plan/<jobId>/`.';
        attemptSummary.engineHint = attemptSummary.engineHint ? `${attemptSummary.engineHint}\n\n${extra}` : extra;
      }

      job.feedbackHistoryByRole ??= {};
      const prevAttemptSummary =
        job.feedbackHistoryByRole[roleId] && job.feedbackHistoryByRole[roleId]!.length > 0
          ? job.feedbackHistoryByRole[roleId]![job.feedbackHistoryByRole[roleId]!.length - 1]!
          : null;
      const currentFailedCriteria = (attemptSummary.completion?.failedCriteria ?? []).slice().sort().join('||');
      const prevFailedCriteria = (prevAttemptSummary?.completion?.failedCriteria ?? []).slice().sort().join('||');
      const repeatedCompletionFailure =
        !!prevAttemptSummary &&
        prevAttemptSummary.scope?.passed === true &&
        prevAttemptSummary.completion?.passed === false &&
        scope.passed === true &&
        completion.passed === false &&
        currentFailedCriteria.length > 0 &&
        currentFailedCriteria === prevFailedCriteria;
      job.feedbackHistoryByRole[roleId] ??= [];
      job.feedbackHistoryByRole[roleId].push(attemptSummary);

      job.feedbackByRole[roleId] = {
        ...(job.feedbackByRole?.[roleId] && typeof job.feedbackByRole[roleId] === 'object'
          ? (job.feedbackByRole[roleId] as any)
          : {}),
        outcome,
        scope,
        completion,
        budget,
        attempt,
        engineHint: attemptSummary.engineHint,
      };
      await this.ledger.append({
        type: 'session_feedback',
        data: { jobId: job.jobId, role: roleId, ...attemptSummary }
      });
      await this.persist(job);

      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/25aab501-c72a-437e-b834-e0245fea140d',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'build-e2e-retry',hypothesisId:'H2',location:'src/core/job-manager.ts:runRoleSession',message:'session retry decision context',data:{jobId:job.jobId,phaseId:job.currentPhaseId,roleId,attempt,maxIterations,scopePassed:scope.passed,completionPassed:completion.passed,failedCriteria:attemptSummary.completion?.failedCriteria ?? [],repeatedCompletionFailure},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      // Budget exceeded after attempt → escalate.
      if (!budget.passed) {
        return await this.escalate(roleId, job, contract, budget, 'budget_exhausted');
      }

      // Completion-only failures that repeat with the exact same signature are usually not fixed by blind retries.
      // Escalate early to avoid burning the whole iteration budget on identical outcomes.
      if (repeatedCompletionFailure && scope.passed && !completion.passed) {
        const repeatedFailureDetails = {
          kind: 'repeated_completion_failure',
          roleId,
          attempt,
          failedCriteria: attemptSummary.completion?.failedCriteria ?? [],
          maxIterations
        };
        await this.ledger.append({
          type: 'session_escalated',
          data: {
            jobId: job.jobId,
            role: roleId,
            reason: 'repeated_completion_failure',
            attempt,
            failedCriteria: attemptSummary.completion?.failedCriteria ?? [],
          }
        });
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/25aab501-c72a-437e-b834-e0245fea140d',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'build-e2e-retry',hypothesisId:'H3',location:'src/core/job-manager.ts:runRoleSession',message:'early escalation on repeated completion failure',data:{jobId:job.jobId,phaseId:job.currentPhaseId,roleId,attempt,failedCriteria:attemptSummary.completion?.failedCriteria ?? []},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        return await this.escalate(roleId, job, contract, repeatedFailureDetails, 'repeated_completion_failure');
      }

      // Scope violations: severity-based escalation path (early decision).
      if (!scope.passed && roleId !== 'architect') {
        const outOfScopePaths = (scope.violations ?? [])
          .filter((v) => v.reason === 'out_of_scope')
          .map((v) => v.file);

        const protectedPaths = (scope.violations ?? [])
          .filter((v) => v.reason === 'protected_path')
          .map((v) => v.file);

        // Protected-path changes are always non-negotiable; we only allow triage/terminate here.
        const hasProtected = protectedPaths.length > 0;
        const structural = isStructuralOutOfScopeViolation(outOfScopePaths, roleId, contract, { manyThreshold: 3 });
        const shouldEscalateNow = hasProtected || (attempt === 1 && structural.structural) || attempt >= 2;

        if (shouldEscalateNow) {
          const hasArchitect = contract.roles.some((r) => r.id === 'architect');
          if (hasArchitect) {
            await this.ledger.append({
              type: 'session_escalated',
              data: {
                jobId: job.jobId,
                role: roleId,
                reason: hasProtected ? 'protected_path_violation' : 'scope_violation',
                attempt,
                protectedPaths,
                outOfScopePaths,
                ownerHints: structural.ownerHints
              }
            });

            const decision = await this.runScopeExceptionDecisionByArchitect(job, contract, {
              failedRoleId: roleId,
              attempt,
              protectedPaths,
              outOfScopePaths,
              ownerHints: structural.ownerHints
            });

            const decisionSummary: { decision: string; patterns?: string[]; notes?: string } =
              decision.decision === 'grant_narrow_access'
                ? { decision: decision.decision, patterns: decision.patterns, notes: decision.notes }
                : { decision: decision.decision, notes: (decision as any).notes };

            // Inject the Architect's decision into worker-visible feedback so the next attempt's overlay
            // clearly communicates what changed (especially for scope overrides).
            const hist = job.feedbackHistoryByRole?.[roleId];
            const last = hist && hist.length ? hist[hist.length - 1] : null;
            if (last) last.scopeDecision = decisionSummary;
            const fb = job.feedbackByRole?.[roleId];
            if (fb && typeof fb === 'object') (fb as any).scopeDecision = decisionSummary;

            if (decision.decision === 'terminate') {
              job.state = 'failed';
              await this.persist(job);
              return { ok: false, reason: 'failed', details: { roleId, decision } };
            }

            if (decision.decision === 'reroute_work') {
              job.state = 'failed';
              await this.persist(job);
              return { ok: false, reason: 'failed', details: { roleId, decision } };
            }

            // If granted, record into job state so the next retry can proceed with effective scope.
            if (decision.decision === 'grant_narrow_access') {
              job.scopeOverridesByRole ??= {};
              job.scopeOverridesByRole[roleId] ??= [];
              job.scopeOverridesByRole[roleId].push({
                kind: decision.kind,
                patterns: decision.patterns,
                ownerRoleId: decision.ownerRoleId,
                phaseId: job.currentPhaseId,
                grantedAtIso: new Date().toISOString(),
                expiresAfterAttempt: decision.expiresAfterAttempt,
                notes: decision.notes
              });
              const hint =
                `Scope override granted by Architect (${decision.kind}): ` +
                `${decision.patterns.map((p) => `\`${p}\``).join(', ')}.` +
                ` You must still satisfy BOTH scope and completion checks.`;
              if (last) last.engineHint = last.engineHint ? `${last.engineHint}\n\n${hint}` : hint;
              if (fb && typeof fb === 'object') {
                const prev = typeof (fb as any).engineHint === 'string' ? String((fb as any).engineHint) : '';
                (fb as any).engineHint = prev ? `${prev}\n\n${hint}` : hint;
              }

              // If this grant arrives on the final planned attempt, provide one bounded
              // extra retry so the worker can actually consume the granted exception.
              if (!scopeExceptionBonusRetryUsed && attempt >= maxIterations) {
                maxIterations += 1;
                scopeExceptionBonusRetryUsed = true;
                job.currentRoleMaxIterations = maxIterations;
                const bonusHint =
                  'Architect granted a narrow scope exception on your final planned iteration; one additional retry was granted to apply it.';
                if (last) last.engineHint = last.engineHint ? `${last.engineHint}\n\n${bonusHint}` : bonusHint;
                if (fb && typeof fb === 'object') {
                  const prev = typeof (fb as any).engineHint === 'string' ? String((fb as any).engineHint) : '';
                  (fb as any).engineHint = prev ? `${prev}\n\n${bonusHint}` : bonusHint;
                }
              }
              await this.persist(job);
            }
          }
        }
      }

      attempt += 1;
    }

    // Out of iterations.
    return await this.escalate(roleId, job, contract, { passed: false, escalation: roleDef.budget.exhaustionEscalation }, 'budget_exhausted');
  }

  private async verifyDelegationPlanIfPresent(
    job: JobState,
    contract: Contract
  ): Promise<{ passed: boolean; message: string; evidence?: unknown }> {
    const rel = `.nibbler/jobs/${job.jobId}/plan/delegation.yaml`;
    const abs = `${job.repoRoot.replace(/\/+$/, '')}/${rel}`;

    const exists = await fileExists(abs);
    if (!exists) {
      const evidencePath = await this.evidenceCollector.recordCustomCheck('architect', 'delegation-missing', { path: rel });
      await this.ledger.append({
        type: 'custom_check',
        data: { kind: 'delegation_plan', passed: false, reason: 'missing', evidencePath, path: rel }
      } as any);
      job.feedbackByRole ??= {};
      job.feedbackByRole.architect = {
        kind: 'delegation_missing',
        path: rel,
        message:
          'Planning must produce delegation.yaml so execution can be delegation-driven. ' +
          `Write it to: .nibbler-staging/plan/${job.jobId}/delegation.yaml (engine will materialize it). ` +
          'Schema: version: 1; tasks: [{ taskId, roleId, description, scopeHints, dependsOn?, priority? }]. ' +
          'YAML tip: quote any string values that start with punctuation (e.g. backticks).',
        example: [
          'version: 1',
          'tasks:',
          '  - taskId: t1',
          '    roleId: frontend',
          '    description: "Implement main UI components"',
          '    scopeHints: ["frontend/**"]',
          '    priority: 1',
          '',
        ].join('\n'),
      };
      await this.persist(job);
      return { passed: false, message: `delegation plan missing (${rel})`, evidence: { evidencePath } };
    }

    try {
      const plan = await readDelegationPlanYaml(abs);
      const errors = validateDelegation(plan, contract);
      const evidencePath = await this.evidenceCollector.recordCustomCheck('architect', 'delegation', {
        path: rel,
        passed: errors.length === 0,
        errors
      });
      await this.ledger.append({
        type: 'custom_check',
        data: { kind: 'delegation_plan', passed: errors.length === 0, evidencePath, errorsCount: errors.length }
      } as any);

      if (errors.length) {
        // Feed back to the Architect for the next attempt.
        job.feedbackByRole ??= {};
        job.feedbackByRole.architect = {
          kind: 'delegation_validation_failed',
          path: rel,
          errors,
          message:
            'Delegation plan is valid YAML but does not match required schema/constraints. ' +
            'Expected: version + tasks[] with taskId/roleId/description/scopeHints.',
        };
        await this.persist(job);
        return { passed: false, message: 'delegation plan invalid', evidence: { evidencePath, errors } };
      }

      job.delegationPlan = plan;
      await this.persist(job);
      return { passed: true, message: 'delegation plan valid', evidence: { evidencePath } };
    } catch (err: any) {
      const evidencePath = await this.evidenceCollector.recordCustomCheck('architect', 'delegation-parse-failed', {
        path: rel,
        error: String(err?.message ?? err)
      });
      await this.ledger.append({
        type: 'custom_check',
        data: { kind: 'delegation_plan', passed: false, reason: 'parse_failed', evidencePath }
      } as any);
      job.feedbackByRole ??= {};
      job.feedbackByRole.architect = {
        kind: 'delegation_parse_failed',
        path: rel,
        message:
          'Delegation plan must be valid YAML matching the required schema. ' +
          'Tip: if a YAML value starts with punctuation (like a backtick), wrap it in quotes.',
        error: String(err?.message ?? err),
        example: [
          'version: 1',
          'tasks:',
          '  - taskId: t1',
          '    roleId: backend',
          '    description: "Add RLS policy: `auth.uid() = user_id`"',
          '    scopeHints: ["supabase/migrations/**"]',
          '    priority: 1',
          '',
        ].join('\n'),
      };
      await this.persist(job);
      return { passed: false, message: `delegation plan parse failed`, evidence: { evidencePath } };
    }
  }

  private async rehydrateRoleStateFromLedger(job: JobState, roleId: string): Promise<void> {
    // Rehydrate feedback history (attempt summaries) for this role.
    job.feedbackHistoryByRole ??= {};
    if (!Array.isArray(job.feedbackHistoryByRole[roleId]) || job.feedbackHistoryByRole[roleId]!.length === 0) {
      const hist = await this.readSessionFeedbackHistoryFromLedger(job, roleId);
      if (hist.length > 0) {
        job.feedbackHistoryByRole[roleId] = hist;
        // Also restore attempt counter for budgeting + display.
        const lastAttempt = hist[hist.length - 1]?.attempt ?? 0;
        job.attemptsByRole ??= {};
        if (lastAttempt > 0) job.attemptsByRole[roleId] = lastAttempt;
      }
    }

    // Rehydrate scope overrides (grants) so retries after resume keep the expanded effective scope.
    await this.rehydrateScopeOverridesFromLedger(job);
  }

  private async readSessionFeedbackHistoryFromLedger(job: JobState, roleId: string): Promise<SessionFeedbackSummaryV1[]> {
    try {
      const reader = new LedgerReader(jobLedgerPathAbs(job));
      const entries = await reader.findByType('session_feedback');
      const items: SessionFeedbackSummaryV1[] = [];
      for (const e of entries as any[]) {
        const data = (e as any)?.data;
        if (!data || typeof data !== 'object') continue;
        if (String((data as any).role ?? '') !== roleId) continue;
        const { role: _role, jobId: _jobId, ...rest } = data as any;
        if (typeof rest.attempt !== 'number') continue;
        items.push(rest as SessionFeedbackSummaryV1);
      }

      // Decorate attempt summaries with any scope-exception decisions so the overlay can show
      // explicit Architect decisions even after `nibbler resume`.
      const decorate = async (type: 'scope_exception_granted' | 'scope_exception_denied') => {
        const scopeEntries = await reader.findByType(type);
        for (const env of scopeEntries as any[]) {
          const data = env?.data;
          if (!data || typeof data !== 'object') continue;
          if (String(data.role ?? '') !== roleId) continue;
          if (typeof data.attempt !== 'number') continue;
          const target = items.find((x) => x.attempt === data.attempt);
          if (!target) continue;

          if (type === 'scope_exception_granted') {
            const patterns: string[] = Array.isArray(data.patterns) ? data.patterns.map((p: any) => String(p)).filter(Boolean) : [];
            target.scopeDecision = { decision: 'grant_narrow_access', patterns, notes: data.notes ? String(data.notes) : undefined };
          } else {
            const reason = data.reason ? String(data.reason) : 'denied';
            target.scopeDecision = { decision: reason, notes: data.notes ? String(data.notes) : undefined };
          }
        }
      };
      await decorate('scope_exception_granted');
      await decorate('scope_exception_denied');

      return items;
    } catch {
      return [];
    }
  }

  private async rehydrateScopeOverridesFromLedger(job: JobState): Promise<void> {
    const existing = job.scopeOverridesByRole;
    if (existing && Object.keys(existing).length > 0) return;

    try {
      const reader = new LedgerReader(jobLedgerPathAbs(job));
      const entries = await reader.findByType('scope_exception_granted');
      const overridesByRole: NonNullable<JobState['scopeOverridesByRole']> = {};

      for (const e of entries as any[]) {
        const env = e as any;
        const data = env?.data;
        if (!data || typeof data !== 'object') continue;

        const roleId = String(data.role ?? '').trim();
        if (!roleId) continue;
        const kindRaw = String(data.kind ?? 'shared_scope');
        const kind = kindRaw === 'extra_scope' ? 'extra_scope' : 'shared_scope';
        const patterns: string[] = Array.isArray(data.patterns) ? data.patterns.map((p: any) => String(p)).filter(Boolean) : [];
        if (patterns.length === 0) continue;

        const phaseId = String(data.phaseId ?? job.currentPhaseId ?? 'execution');
        const ownerRoleId = data.ownerRoleId ? String(data.ownerRoleId) : undefined;
        const expiresAfterAttempt = data.expiresAfterAttempt !== undefined ? Number(data.expiresAfterAttempt) : undefined;
        const notes = data.notes ? String(data.notes) : undefined;
        const grantedAtIso = typeof env.timestamp === 'string' ? String(env.timestamp) : new Date().toISOString();

        overridesByRole[roleId] ??= [];
        overridesByRole[roleId]!.push({
          kind,
          patterns,
          ownerRoleId,
          phaseId,
          grantedAtIso,
          expiresAfterAttempt,
          notes,
        });
      }

      if (Object.keys(overridesByRole).length > 0) {
        job.scopeOverridesByRole = overridesByRole;
      }
    } catch {
      // ignore
    }
  }

  private async runScopeExceptionDecisionByArchitect(
    job: JobState,
    contract: Contract,
    req: {
      failedRoleId: string;
      attempt: number;
      protectedPaths: string[];
      outOfScopePaths: string[];
      ownerHints: Array<{ file: string; owners: string[] }>;
    }
  ): Promise<
    | { decision: 'deny'; notes?: string }
    | { decision: 'terminate'; notes?: string }
    | { decision: 'reroute_work'; toRoleId?: string; notes?: string }
    | {
        decision: 'grant_narrow_access';
        kind: 'shared_scope' | 'extra_scope';
        patterns: string[];
        ownerRoleId?: string;
        expiresAfterAttempt?: number;
        notes?: string;
      }
  > {
    const repo = git(jobWorkspaceRoot(job));
    const pre = await getCurrentCommit(repo);

    const decisionRel = `.nibbler-staging/${job.jobId}/scope-exception-decision.json`;
    const decisionAbs = `${jobWorkspaceRoot(job).replace(/\/+$/, '')}/${decisionRel}`;
    const proposalEvidenceRel = `.nibbler/jobs/${job.jobId}/evidence/checks/scope-exception-proposal.json`;
    const effectiveEvidenceRel = `.nibbler/jobs/${job.jobId}/evidence/checks/scope-exception-effective.json`;

    // Ensure the decision directory exists (helps the Architect).
    try {
      await mkdir(dirname(decisionAbs), { recursive: true });
    } catch {
      // ignore
    }

    // Provide the request to the Architect via feedback (rendered into overlay).
    job.feedbackByRole ??= {};
    job.feedbackByRole.architect = {
      kind: 'scope_exception_decision',
      jobId: job.jobId,
      phaseId: job.currentPhaseId,
      decisionFile: decisionRel,
      request: req,
      choices: ['deny', 'grant_narrow_access', 'reroute_work', 'terminate'],
      rules: {
        protectedPathsNonNegotiable: true,
        neverKeepViolatingDiff: true,
        recommendNarrowPatterns: true
      }
    };
    await this.persist(job);

    await writeJson(`${job.repoRoot.replace(/\/+$/, '')}/${proposalEvidenceRel}`, {
      kind: 'scope_exception_proposal_v1',
      timestamp: new Date().toISOString(),
      jobId: job.jobId,
      phaseId: job.currentPhaseId,
      failedRoleId: req.failedRoleId,
      attempt: req.attempt,
      protectedPaths: req.protectedPaths,
      outOfScopePaths: req.outOfScopePaths,
      ownerHints: req.ownerHints,
      decisionFile: decisionRel
    });

    await this.ledger.append({
      type: 'scope_exception_requested',
      data: {
        jobId: job.jobId,
        phaseId: job.currentPhaseId,
        role: req.failedRoleId,
        attempt: req.attempt,
        protectedPaths: req.protectedPaths,
        outOfScopePaths: req.outOfScopePaths,
        decisionFile: decisionRel,
        ownerHints: req.ownerHints
      }
    });

    // Restrict the Architect decision session to staging writes only.
    const restrictedContract: Contract = {
      ...contract,
      roles: contract.roles.map((r) => {
        if (r.id !== 'architect') return r;
        return {
          ...r,
          scope: ['.nibbler-staging/**'],
          authority: { allowedCommands: [], allowedPaths: [] }
        };
      })
    };

    const prevRoleId = job.currentRoleId;
    const prevSessionLogPath = job.sessionLogPath;

    job.currentRoleId = 'architect';
    job.sessionActive = true;
    job.sessionStartedAtIso = new Date().toISOString();
    job.sessionHandleId = null;
    job.sessionPid = null;
    job.sessionLastActivityAtIso = null;
    job.sessionSeq = (job.sessionSeq ?? 0) + 1;
    job.sessionLogPath =
      `.nibbler/jobs/${job.jobId}/evidence/sessions/` +
      `${job.sessionSeq}-architect-scope-exception-${req.failedRoleId}-${job.currentPhaseId}-${req.attempt}.log`;
    await this.persist(job);

    const ownerHintsLines =
      req.ownerHints.length > 0
        ? req.ownerHints
            .slice(0, 40)
            .map((h) => `- ${h.file}: ${h.owners.length ? h.owners.join(', ') : '(unknown)'}`)
            .join('\n')
        : '(none)';

    const protectedLines = req.protectedPaths.length ? req.protectedPaths.map((p) => `- ${p}`).join('\n') : '(none)';
    const outOfScopeLines = req.outOfScopePaths.length ? req.outOfScopePaths.map((p) => `- ${p}`).join('\n') : '(none)';

    // Offer a few "narrow but practical" suggestions the Architect can pick from.
    // NOTE: This is advisory only; the Architect still decides based on project intent.
    // The engine generates suggestions by grouping related paths into directory-level patterns
    // where appropriate, otherwise suggesting exact paths (narrowest).
    const suggestedPatterns = Array.from(
      new Set(
        req.outOfScopePaths.flatMap((p) => {
          // Group well-known generated/report directories into wildcards.
          const dir = p.split('/')[0];
          if (dir && p.includes('/') && ['playwright-report', 'test-results', 'coverage', '.nyc_output', 'dist', 'build'].includes(dir)) {
            return [`${dir}/**`];
          }
          // Default: allow the exact path (narrowest).
          return [p];
        })
      )
    )
      .slice(0, 12)
      .map((p) => `- ${p}`)
      .join('\n');

    const decisionBootstrapPrompt = [
      'You are the Architect. The engine requires a scope-exception decision for a worker role.',
      '',
      `Failed role: ${req.failedRoleId}`,
      `Phase: ${job.currentPhaseId}`,
      `Attempt: ${req.attempt}`,
      '',
      'The worker met completion criteria but violated scope.',
      '',
      '## Out-of-scope paths (from verification)',
      outOfScopeLines,
      '',
      '## Protected paths (non-negotiable; NEVER grant)',
      protectedLines,
      '',
      '## Ownership hints (file -> likely owning roles)',
      ownerHintsLines,
      '',
      '## What you should do',
      '- Prefer **grant_narrow_access** only when the violating files are necessary to achieve the requirement and cannot reasonably be moved into the worker scope.',
      '- Prefer kind: "shared_scope" (preferred) when multiple roles legitimately need the path. Use "extra_scope" for a one-off exception.',
      '- Keep patterns as narrow as possible (single files over directories).',
      '',
      'Suggested narrow patterns (optional; pick the minimum that resolves the blocker):',
      suggestedPatterns.length ? suggestedPatterns : '(none)',
      '',
      `Write a JSON decision file at: ${decisionRel}`,
      '',
      'Allowed decisions:',
      '- deny',
      '- grant_narrow_access',
      '- reroute_work',
      '- terminate',
      '',
      'If granting access, include:',
      '- kind: "shared_scope" (preferred) or "extra_scope"',
      '- patterns: string[] of narrow path globs to allow',
      '- optional: ownerRoleId, expiresAfterAttempt, notes',
      '',
      'Example:',
      '{"decision":"grant_narrow_access","kind":"shared_scope","patterns":[".gitignore","test-results/**"],"notes":"Allow generated test artifacts for E2E runs."}',
      '',
      'After writing the decision file, signal completion by outputting this as plain text in your response (NOT inside any file):',
      '',
      '```',
      'NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"scope exception decision written"}',
      '```',
      '',
    ].join('\n');

    // Run a single Architect session to produce the decision file.
    let handle: SessionHandle | null = null;
    try {
      handle = await this.sessionController.startSession('architect', job, restrictedContract, {
        bootstrapPrompt: decisionBootstrapPrompt
      });
      this.activeHandle = handle;
      job.sessionHandleId = handle.id;
      job.sessionPid = handle.pid ?? null;
      job.sessionLastActivityAtIso = handle.lastActivityAtIso ?? null;
      await this.persist(job);

      await this.sessionController.waitForCompletion(handle, mustRole(contract, 'architect').budget, {
        onHeartbeat: ({ lastActivityAtIso }) => this.persistSessionHeartbeat(job, lastActivityAtIso)
      });
    } finally {
      await this.closeSession(job, handle);
      job.currentRoleId = prevRoleId;
      job.sessionLogPath = prevSessionLogPath;
      await this.persist(job);
    }

    // Enforce: Architect decision must not modify non-engine paths.
    const dAll = await diff(repo, pre);
    const d = filterEngineFiles(dAll);
    if (d.files.length > 0) {
      await resetHard(repo, pre);
      await clean(repo);
      await this.ledger.append({
        type: 'scope_exception_denied',
        data: { jobId: job.jobId, phaseId: job.currentPhaseId, attempt: req.attempt, role: req.failedRoleId, reason: 'architect_modified_repo', diffSummary: d.summary }
      });
      return { decision: 'deny', notes: 'Architect decision session modified non-engine files; denied.' };
    }

    const exists = await fileExists(decisionAbs);
    if (!exists) {
      const evidencePath = await this.evidenceCollector.recordCustomCheck('architect', 'scope-exception-decision-missing', {
        decisionFile: decisionRel
      });
      await this.ledger.append({
        type: 'scope_exception_denied',
        data: { jobId: job.jobId, phaseId: job.currentPhaseId, attempt: req.attempt, role: req.failedRoleId, reason: 'missing_decision_file', evidencePath }
      });
      return { decision: 'deny', notes: `Missing decision file: ${decisionRel}` };
    }

    const raw = await readJson<any>(decisionAbs);
    const evidencePath = await this.evidenceCollector.recordCustomCheck('architect', 'scope-exception-decision', raw);

    const decision = String(raw?.decision ?? '').trim();
    if (decision !== 'deny' && decision !== 'grant_narrow_access' && decision !== 'reroute_work' && decision !== 'terminate') {
      await this.ledger.append({
        type: 'scope_exception_denied',
        data: { jobId: job.jobId, phaseId: job.currentPhaseId, attempt: req.attempt, role: req.failedRoleId, reason: 'invalid_decision', decision, evidencePath }
      });
      return { decision: 'deny', notes: `Invalid decision: ${decision}` };
    }

    if (decision === 'deny') {
      await this.ledger.append({
        type: 'scope_exception_denied',
        data: { jobId: job.jobId, phaseId: job.currentPhaseId, attempt: req.attempt, role: req.failedRoleId, reason: 'denied', evidencePath, notes: raw?.notes }
      });
      return { decision: 'deny', notes: raw?.notes };
    }

    if (decision === 'reroute_work') {
      const toRoleId = raw?.toRoleId ? String(raw.toRoleId) : undefined;
      await this.ledger.append({
        type: 'scope_exception_denied',
        data: { jobId: job.jobId, phaseId: job.currentPhaseId, attempt: req.attempt, role: req.failedRoleId, reason: 'reroute_work', toRoleId, evidencePath, notes: raw?.notes }
      });
      return { decision: 'reroute_work', toRoleId, notes: raw?.notes };
    }

    if (decision === 'terminate') {
      await this.ledger.append({
        type: 'scope_exception_denied',
        data: { jobId: job.jobId, phaseId: job.currentPhaseId, attempt: req.attempt, role: req.failedRoleId, reason: 'terminated', evidencePath, notes: raw?.notes }
      });
      return { decision: 'terminate', notes: raw?.notes };
    }

    const patterns: string[] = Array.isArray(raw?.patterns) ? raw.patterns.map((s: any) => String(s)).filter(Boolean) : [];
    const kindRaw = String(raw?.kind ?? 'shared_scope');
    const kind = kindRaw === 'extra_scope' ? 'extra_scope' : 'shared_scope';
    const ownerRoleId = raw?.ownerRoleId ? String(raw.ownerRoleId) : undefined;
    const expiresAfterAttempt = raw?.expiresAfterAttempt !== undefined ? Number(raw.expiresAfterAttempt) : undefined;

    if (patterns.length === 0) {
      await this.ledger.append({
        type: 'scope_exception_denied',
        data: { jobId: job.jobId, phaseId: job.currentPhaseId, attempt: req.attempt, role: req.failedRoleId, reason: 'missing_patterns', evidencePath }
      });
      return { decision: 'deny', notes: 'grant_narrow_access requires non-empty patterns[]' };
    }

    await this.ledger.append({
      type: 'scope_exception_granted',
      data: {
        jobId: job.jobId,
        phaseId: job.currentPhaseId,
        attempt: req.attempt,
        role: req.failedRoleId,
        kind,
        patterns,
        ownerRoleId,
        expiresAfterAttempt,
        evidencePath,
        notes: raw?.notes
      }
    });

    await writeJson(`${job.repoRoot.replace(/\/+$/, '')}/${effectiveEvidenceRel}`, {
      schema: 'scope_exception_effective_v1',
      timestamp: new Date().toISOString(),
      jobId: job.jobId,
      phaseId: job.currentPhaseId,
      failedRoleId: req.failedRoleId,
      decision: 'grant_narrow_access',
      overrideKind: kind,
      patterns,
      ownerRoleId,
      expiresAfterAttempt,
      notes: raw?.notes,
      decisionEvidencePath: evidencePath,
      proposalEvidencePath: proposalEvidenceRel
    });

    return { decision: 'grant_narrow_access', kind, patterns, ownerRoleId, expiresAfterAttempt, notes: raw?.notes };
  }

  private async escalate(
    roleId: string,
    job: JobState,
    contract: Contract,
    budgetResult: unknown,
    reason: 'budget_exhausted' | 'repeated_completion_failure' = 'budget_exhausted'
  ): Promise<JobOutcome> {
    // Rendering hook: escalation
    this.hooks.onEscalation?.({ roleId, reason });

    await this.ledger.append({
      type: 'escalation',
      data: { jobId: job.jobId, role: roleId, reason, budget: budgetResult }
    });

    const hasArchitect = contract.roles.some((r) => r.id === 'architect');
    if (!hasArchitect || roleId === 'architect') {
      job.state = 'failed';
      await this.persist(job);
      return { ok: false, reason: 'failed', details: { roleId, budgetResult } };
    }

    // Start an Architect resolution session (minimal Phase 6 behavior).
    job.feedbackByRole ??= {};
    job.feedbackByRole.architect = {
      kind: 'resolution_request',
      failedRole: roleId,
      failedRoleFeedback: job.feedbackByRole[roleId],
      reason
    };
    await this.persist(job);

    // Budget exhaustion escalations are advisory. Running a normal role session for `architect` would incorrectly
    // apply the current phase's completion criteria (e.g. diff_non_empty / command_succeeds), causing a guaranteed
    // failure loop with empty diffs. Instead, request a resolution note in staging and verify by artifact existence.
    const delegatedTasks = (job.delegationPlan?.tasks ?? []).filter((t) => t.roleId === roleId);
    const guidance = await this.runEscalationResolutionByArchitect(job, contract, {
      failedRoleId: roleId,
      attempt: job.attemptsByRole?.[roleId] ?? 0,
      event: { type: 'NEEDS_ESCALATION', reason, context: budgetResult } as any,
      delegatedTasks,
      implementationPlanRel: null
    });

    // Make the guidance visible to the failed role for any subsequent recovery flows.
    job.feedbackByRole ??= {};
    job.feedbackByRole[roleId] = {
      kind: 'architect_guidance',
      event: { type: 'NEEDS_ESCALATION', reason },
      guidance
    } as any;
    await this.persist(job);

    job.state = 'failed';
    await this.persist(job);
    return { ok: false, reason: 'escalated', details: { roleId, guidance } };
  }

  private async persist(job: JobState): Promise<void> {
    if (!job.statusPath) return;
    await writeJson(job.statusPath, buildJobStatusSnapshotV1(job));
  }

  private async persistSessionHeartbeat(job: JobState, lastActivityAtIso: string): Promise<void> {
    if (!job.sessionActive) return;
    job.sessionLastActivityAtIso = lastActivityAtIso || job.sessionLastActivityAtIso || new Date().toISOString();
    await this.persist(job);
  }

  private async closeSession(job: JobState, handle: SessionHandle | null): Promise<void> {
    if (handle) {
      try {
        await this.sessionController.stopSession(handle);
      } catch {
        // best-effort
      }
      if (this.activeHandle?.id === handle.id) {
        this.activeHandle = null;
      }
      job.sessionLastActivityAtIso = handle.lastActivityAtIso ?? job.sessionLastActivityAtIso ?? null;
    } else if (this.activeHandle) {
      // Defensive: startup failed but an active handle remained set.
      await this.stopActiveSession();
    }

    job.sessionActive = false;
    job.sessionHandleId = null;
    job.sessionPid = null;
    await this.persist(job);
  }

  private async finalizeForOutcome(job: JobState, out: JobOutcome): Promise<void> {
    if (out.ok) return;
    if (out.reason === 'cancelled' || job.state === 'cancelled') {
      await this.finalize(job, 'job_cancelled', { info: this.cancelInfo, out });
      return;
    }
    if (out.reason === 'budget_exceeded' || job.state === 'budget_exceeded') {
      await this.finalize(job, 'job_budget_exceeded', { out });
      return;
    }
    await this.finalize(job, 'job_failed', { out });
  }

  /**
   * Best-effort repair for stale/broken git worktrees.
   *
   * Failure mode:
   * - Worktree directory still exists
   * - Its `.git` file points to `<repoRoot>/.git/worktrees/<jobId>`
   * - That gitdir was removed → all git commands fail with exit=128
   *
   * We repair by moving aside the stale directory and re-adding the worktree for `job.jobBranch`.
   */
  private async ensureWorktreeHealthy(job: JobState): Promise<{ repaired: boolean; note?: string }> {
    const worktreePath = job.worktreePath?.trim();
    if (!worktreePath) return { repaired: false };
    const jobBranch = job.jobBranch?.trim();
    if (!jobBranch) return { repaired: false };

    const inspected = await inspectWorktreeDir(worktreePath);
    if (inspected.active) return { repaired: false };

    // If the directory exists but is stale, move it aside so `git worktree add` can succeed.
    if (inspected.exists) {
      const movedTo = `${worktreePath}.stale-${Date.now()}-${process.pid}`;
      try {
        await rename(worktreePath, movedTo);
      } catch {
        // Last resort: remove the directory to unblock worktree creation.
        await rm(worktreePath, { recursive: true, force: true });
      }
    }

    // Re-add the worktree for the existing job branch.
    await addWorktree(git(job.repoRoot), worktreePath, jobBranch);

    const note = inspected.gitdir ? `missing gitdir: ${inspected.gitdir}` : 'missing or unparsable .git file';
    const evidencePath = await this.evidenceCollector.recordCustomCheck('engine', 'worktree-repaired', {
      jobId: job.jobId,
      worktreePath,
      jobBranch,
      note,
      inspected
    });
    await this.ledger.append(
      { type: 'custom_check', data: { kind: 'worktree_repaired', evidencePath, worktreePath, jobBranch, note } } as any
    );

    return { repaired: true, note };
  }

  private async finalize(job: JobState, type: 'job_completed' | 'job_failed' | 'job_budget_exceeded' | 'job_cancelled', data: unknown): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    await this.ensureWorktreeHealthy(job).catch(() => undefined);
    const repo = git(jobWorkspaceRoot(job));
    const [branch, commitHash, files] = await Promise.all([
      getCurrentBranch(repo).catch(() => null),
      getCurrentCommit(repo).catch(() => null),
      lsFiles(repo).catch(() => [])
    ]);

    await this.evidenceCollector.captureFinalTree(files);
    await this.evidenceCollector.captureFinalState({
      jobId: job.jobId,
      branch,
      commit: commitHash,
      job_state: job.state ?? null,
      active_role: job.currentRoleId ?? null,
      cancel: this.cancelInfo ?? undefined,
      data,
      timestamp: new Date().toISOString()
    });

    await this.ledger.append({ type, data: { jobId: job.jobId, ...((data as any) ?? {}) } });
  }

  private async runDelegatedPlanStep(
    roleId: string,
    job: JobState,
    contract: Contract,
    req: { attempt: number; delegatedTasks: DelegationTask[] }
  ): Promise<{ ok: true; implPlanRel: string } | { ok: false; details: unknown }> {
    const repo = git(jobWorkspaceRoot(job));
    const pre = await getCurrentCommit(repo);

    const stagedRel = `.nibbler-staging/${job.jobId}/plans/${roleId}-plan.md`;
    const stagedAbs = `${jobWorkspaceRoot(job).replace(/\/+$/, '')}/${stagedRel}`;
    const implPlanRel = `.nibbler/jobs/${job.jobId}/plan/${roleId}-impl-plan.md`;
    const implPlanAbs = `${job.repoRoot.replace(/\/+$/, '')}/${implPlanRel}`;

    await this.ledger.append({ type: 'session_start', data: { role: roleId, commit: pre, mode: 'plan' } } as any);

    // Allocate a dedicated session log for delegated plan runs so prompts/events
    // do not bleed into the previous role session log.
    job.sessionActive = true;
    job.sessionStartedAtIso = new Date().toISOString();
    job.sessionHandleId = null;
    job.sessionPid = null;
    job.sessionLastActivityAtIso = null;
    job.sessionSeq = (job.sessionSeq ?? 0) + 1;
    job.sessionLogPath = `.nibbler/jobs/${job.jobId}/evidence/sessions/${job.sessionSeq}-${roleId}-${job.currentPhaseId}-plan-${req.attempt}.log`;
    await this.persist(job);

    const prompt = [
      'Your Architect has delegated the tasks below. Review the codebase and write a focused implementation plan.',
      'Cover each task thoroughly (error handling, edge cases, tests if relevant) but do not add work beyond what the tasks require.',
      '',
      '## Output',
      `Write your plan to exactly this path: ${stagedRel}`,
      'The engine will materialize it. If the file is missing at this exact path, the plan step FAILS.',
      '',
      '## Tasks',
      ...req.delegatedTasks.map((t) => `- [${t.taskId}] ${t.description}${t.scopeHints?.length ? ` (scopeHints: ${t.scopeHints.join(', ')})` : ''}`),
      '',
      'Do NOT make code changes. Only write the plan file in the staging path above.',
      '',
      'After writing the plan file, signal completion by outputting this as plain text in your response (NOT inside any file):',
      '',
      '```',
      'NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"role plan written"}',
      '```',
      '',
      'CRITICAL: The NIBBLER_EVENT line is a protocol signal. NEVER write it into any file.'
    ].join('\n');

    let handle: SessionHandle | null = null;
    try {
      handle = await this.sessionController.startSession(roleId, job, contract, {
        mode: 'plan',
        delegatedTasks: req.delegatedTasks,
        implementationPlanRel: undefined,
        bootstrapPrompt: prompt
      });
      this.activeHandle = handle;
      await this.persist(job);
      await this.sessionController.waitForCompletion(handle, mustRole(contract, roleId).budget, {
        onHeartbeat: ({ lastActivityAtIso }) => this.persistSessionHeartbeat(job, lastActivityAtIso)
      });
    } finally {
      await this.closeSession(job, handle);
    }

    // Best-effort: materialize handoff artifact for this plan session too.
    await this.materializeHandoffBestEffort(job, roleId, job.currentPhaseId).catch(() => undefined);

    // Verify: no repo changes outside engine paths.
    const dAll = await diff(repo, pre);
    const d = filterEngineFiles(dAll);
    if (d.files.length > 0) {
      const evidencePath = await this.evidenceCollector.recordCustomCheck(roleId, 'delegated-plan-diff', { diff: d.summary, files: d.files });
      await resetHard(repo, pre);
      await clean(repo);
      return { ok: false, details: { reason: 'plan_session_modified_repo', evidencePath, diff: d.summary } };
    }

    const exists = await fileExists(stagedAbs);
    if (!exists) {
      const evidencePath = await this.evidenceCollector.recordCustomCheck(roleId, 'delegated-plan-missing', { stagedRel });
      return { ok: false, details: { reason: 'plan_file_missing', evidencePath, stagedRel } };
    }

    await mkdir(dirname(implPlanAbs), { recursive: true });
    await copyFile(stagedAbs, implPlanAbs);
    // Also materialize into the active session workspace (worktree) so downstream execution sessions
    // can read it via the same `.nibbler/jobs/<id>/plan/...` relative path.
    const implPlanAbsInWorkspace = `${jobWorkspaceRoot(job).replace(/\/+$/, '')}/${implPlanRel}`;
    await mkdir(dirname(implPlanAbsInWorkspace), { recursive: true });
    await copyFile(stagedAbs, implPlanAbsInWorkspace);
    await this.evidenceCollector.recordCustomCheck(roleId, 'delegated-plan-materialized', {
      from: stagedRel,
      to: implPlanRel,
      attempt: req.attempt
    });

    // Reset any tracked changes (plan mode should not create any), and clean any accidental untracked files.
    await resetHard(repo, pre);
    await clean(repo);
    await this.ledger.append({ type: 'session_complete', data: { role: roleId, outcome: { kind: 'plan_materialized', implPlanRel } } } as any);

    return { ok: true, implPlanRel };
  }

  private async materializeHandoffBestEffort(job: JobState, roleId: string, phaseId: string): Promise<void> {
    const workspaceRoot = jobWorkspaceRoot(job);
    const stagedRel = `.nibbler-staging/${job.jobId}/handoffs/${roleId}-${phaseId}.md`;
    const stagedAbs = `${workspaceRoot.replace(/\/+$/, '')}/${stagedRel}`;

    const exists = await fileExists(stagedAbs);
    if (!exists) return;

    const outRel = `.nibbler/jobs/${job.jobId}/plan/handoffs/${roleId}-${phaseId}.md`;
    const outAbsRepoRoot = `${job.repoRoot.replace(/\/+$/, '')}/${outRel}`;
    const outAbsWorkspace = `${workspaceRoot.replace(/\/+$/, '')}/${outRel}`;

    await mkdir(dirname(outAbsRepoRoot), { recursive: true });
    await copyFile(stagedAbs, outAbsRepoRoot);

    // Mirror into the active session workspace so downstream roles in the same worktree can read it.
    await mkdir(dirname(outAbsWorkspace), { recursive: true });
    await copyFile(stagedAbs, outAbsWorkspace);

    await this.evidenceCollector.recordCustomCheck(roleId, 'handoff-materialized', {
      from: stagedRel,
      to: outRel,
      roleId,
      phaseId,
    });
    await this.ledger.append({
      type: 'custom_check',
      data: { kind: 'handoff', passed: true, role: roleId, phaseId, path: outRel }
    } as any);
  }

  private async runEscalationResolutionByArchitect(
    job: JobState,
    contract: Contract,
    req: {
      failedRoleId: string;
      attempt: number;
      event: { type: 'NEEDS_ESCALATION'; reason?: string; context?: unknown };
      delegatedTasks: DelegationTask[];
      implementationPlanRel: string | null;
    }
  ): Promise<{ ok: boolean; resolutionRel?: string; notes?: string }> {
    const repo = git(jobWorkspaceRoot(job));
    const pre = await getCurrentCommit(repo);

    const resolutionStagedRel = `.nibbler-staging/${job.jobId}/resolutions/${req.failedRoleId}.md`;
    const resolutionStagedAbs = `${jobWorkspaceRoot(job).replace(/\/+$/, '')}/${resolutionStagedRel}`;

    const resolutionRel = `.nibbler/jobs/${job.jobId}/plan/resolutions/${req.failedRoleId}.md`;
    const resolutionAbs = `${job.repoRoot.replace(/\/+$/, '')}/${resolutionRel}`;

    // Provide the escalation request to the Architect via feedback (rendered into overlay).
    job.feedbackByRole ??= {};
    job.feedbackByRole.architect = {
      kind: 'escalation_resolution_request',
      jobId: job.jobId,
      phaseId: job.currentPhaseId,
      failedRoleId: req.failedRoleId,
      attempt: req.attempt,
      event: req.event,
      delegatedTasks: req.delegatedTasks,
      implementationPlanRel: req.implementationPlanRel,
      outputFile: resolutionStagedRel
    };
    await this.persist(job);

    await this.evidenceCollector.recordCustomCheck('architect', 'escalation-request', job.feedbackByRole.architect);
    await this.ledger.append({
      type: 'architect_resolution',
      data: {
        jobId: job.jobId,
        failedRoleId: req.failedRoleId,
        attempt: req.attempt,
        outputFile: resolutionStagedRel
      }
    });

    // Restrict Architect: staging writes only.
    const restrictedContract: Contract = {
      ...contract,
      roles: contract.roles.map((r) => {
        if (r.id !== 'architect') return r;
        return {
          ...r,
          scope: ['.nibbler-staging/**'],
          authority: { allowedCommands: [], allowedPaths: [] }
        };
      })
    };

    const prompt = [
      'A worker role has requested escalation.',
      '',
      `Failed role: ${req.failedRoleId}`,
      `Reason: ${req.event.reason ?? '(none)'}`,
      '',
      'Your job: provide actionable technical guidance the worker can apply within its scope.',
      '',
      '## Output',
      `Write your guidance to: ${resolutionStagedRel}`,
      '',
      'Do NOT modify repository files. Only write the resolution file in staging.',
      '',
      'After writing the resolution file, signal completion by outputting this as plain text in your response (NOT inside any file):',
      '',
      '```',
      'NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"architect guidance written"}',
      '```'
    ].join('\n');

    const prevRoleId = job.currentRoleId;
    const prevSessionLogPath = job.sessionLogPath;
    job.currentRoleId = 'architect';
    job.sessionActive = true;
    job.sessionStartedAtIso = new Date().toISOString();
    job.sessionHandleId = null;
    job.sessionPid = null;
    job.sessionLastActivityAtIso = null;
    job.sessionSeq = (job.sessionSeq ?? 0) + 1;
    job.sessionLogPath =
      `.nibbler/jobs/${job.jobId}/evidence/sessions/` +
      `${job.sessionSeq}-architect-${job.currentPhaseId}-escalation-${req.failedRoleId}-${req.attempt}.log`;
    await this.persist(job);

    let handle: SessionHandle | null = null;
    try {
      handle = await this.sessionController.startSession('architect', job, restrictedContract, { mode: 'plan', bootstrapPrompt: prompt });
      this.activeHandle = handle;
      await this.sessionController.waitForCompletion(handle, mustRole(contract, 'architect').budget, {
        onHeartbeat: ({ lastActivityAtIso }) => this.persistSessionHeartbeat(job, lastActivityAtIso)
      });
    } finally {
      await this.closeSession(job, handle);
      job.currentRoleId = prevRoleId;
      job.sessionLogPath = prevSessionLogPath;
      await this.persist(job);
    }

    // Enforce: architect should not modify repo (outside engine paths).
    const dAll = await diff(repo, pre);
    const d = filterEngineFiles(dAll);
    if (d.files.length > 0) {
      await resetHard(repo, pre);
      await clean(repo);
      await this.ledger.append({
        type: 'session_escalated',
        data: { jobId: job.jobId, role: req.failedRoleId, reason: 'architect_modified_repo', diffSummary: d.summary }
      });
      return { ok: false, notes: 'Architect modified non-engine files; guidance rejected.' };
    }

    const exists = await fileExists(resolutionStagedAbs);
    if (!exists) {
      await this.evidenceCollector.recordCustomCheck('architect', 'escalation-resolution-missing', { path: resolutionStagedRel });
      return { ok: false, notes: `Missing resolution file: ${resolutionStagedRel}` };
    }

    await mkdir(dirname(resolutionAbs), { recursive: true });
    await copyFile(resolutionStagedAbs, resolutionAbs);
    // Also materialize into the active session workspace (worktree) so the failed role can read it
    // by relative path during retries or recovery.
    const resolutionAbsInWorkspace = `${jobWorkspaceRoot(job).replace(/\/+$/, '')}/${resolutionRel}`;
    await mkdir(dirname(resolutionAbsInWorkspace), { recursive: true });
    await copyFile(resolutionStagedAbs, resolutionAbsInWorkspace);
    await this.evidenceCollector.recordCustomCheck('architect', 'escalation-resolution-materialized', {
      from: resolutionStagedRel,
      to: resolutionRel
    });

    // Safety: reset any tracked changes (should be none) and clean stray untracked (ignored artifacts remain).
    await resetHard(repo, pre);
    await clean(repo);

    return { ok: true, resolutionRel };
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readWorktreeGitdir(worktreePath: string): Promise<string | null> {
  try {
    const raw = await readFile(join(worktreePath, '.git'), 'utf8');
    const m = /^gitdir:\s*(.+)\s*$/m.exec(raw);
    if (!m) return null;
    const candidate = m[1].trim();
    // git may write either absolute or relative paths here
    return resolvePath(worktreePath, candidate);
  } catch {
    return null;
  }
}

async function inspectWorktreeDir(
  worktreePath: string
): Promise<{ exists: boolean; active: boolean; gitdir: string | null; gitdirExists: boolean }> {
  const exists = await pathExists(worktreePath);
  if (!exists) return { exists: false, active: false, gitdir: null, gitdirExists: false };
  const gitdir = await readWorktreeGitdir(worktreePath);
  const gitdirExists = gitdir ? await pathExists(gitdir) : false;
  return { exists: true, active: !!gitdir && gitdirExists, gitdir, gitdirExists };
}

function jobLedgerPathAbs(job: JobState): string {
  return `${job.repoRoot.replace(/\/+$/, '')}/.nibbler/jobs/${job.jobId}/ledger.jsonl`;
}

function buildAttemptSummary(args: {
  attempt: number;
  scope: ScopeResult;
  completion: CompletionResult;
  isEmptyDiff: boolean;
}): SessionFeedbackSummaryV1 {
  const scopeViolations = args.scope.violations ?? [];
  const sampleViolations = scopeViolations.slice(0, 10).map((v) => v.file);
  const failedCriteria = (args.completion.criteriaResults ?? [])
    .filter((r) => !r.passed)
    .map((r) => r.message);

  const summary: SessionFeedbackSummaryV1 = {
    attempt: args.attempt,
    scope: {
      passed: args.scope.passed,
      violationCount: scopeViolations.length,
      ...(sampleViolations.length ? { sampleViolations } : {}),
    },
    completion: {
      passed: args.completion.passed,
      ...(failedCriteria.length ? { failedCriteria } : {}),
    },
  };

  const hint = detectEngineHint({
    attempt: args.attempt,
    isEmptyDiff: args.isEmptyDiff,
    scope: args.scope,
    completion: args.completion,
  });
  if (hint) summary.engineHint = hint;

  return summary;
}

function detectEngineHint(args: {
  attempt: number;
  isEmptyDiff: boolean;
  scope: ScopeResult;
  completion: CompletionResult;
}): string | undefined {
  if (args.isEmptyDiff) {
    return (
      'Session produced no file changes (0 files modified). This is the #1 cause of retries. ' +
      'You MUST create or modify files to satisfy diff_non_empty and delegation_coverage. ' +
      'WRITE FILES FIRST before running any test or validation commands. ' +
      'Follow this exact order: 1) Read your implementation plan, 2) Write/create ALL source files, 3) Run npm install if needed, 4) Run tests/build to validate. ' +
      'If code already exists and seems correct, make a meaningful improvement (better types, explicit qualifiers, documentation, additional edge cases). ' +
      'Do NOT spend time only reading files or running tests — your session will timeout with 0 changes.'
    );
  }

  const failedCriteria = (args.completion.criteriaResults ?? [])
    .filter((r) => !r.passed)
    .map((r) => r.message);

  const violations = args.scope.violations ?? [];
  const outOfScope = violations.filter((v) => v.reason === 'out_of_scope').slice(0, 10).map((v) => v.file);
  const protectedPaths = violations.filter((v) => v.reason === 'protected_path').slice(0, 10).map((v) => v.file);

  if (args.scope.passed && !args.completion.passed) {
    const smokeFailure = (args.completion.criteriaResults ?? []).find(
      (r) => !r.passed && typeof r.message === 'string' && r.message.startsWith('local_http_smoke(')
    ) as { message: string; evidence?: Record<string, unknown> } | undefined;
    if (smokeFailure) {
      const ev = smokeFailure.evidence ?? {};
      const startCommand = typeof ev.startCommand === 'string' ? ev.startCommand : null;
      const configuredUrl = typeof ev.url === 'string' ? ev.url : null;
      const resolvedUrl = typeof ev.resolvedUrl === 'string' ? ev.resolvedUrl : null;
      const status = typeof ev.httpStatus === 'number' ? ev.httpStatus : null;
      const lastError = typeof ev.lastError === 'string' ? ev.lastError : null;
      const statusDetail = status != null ? `HTTP ${status}` : lastError ? lastError : 'no HTTP response';
      const commandDetail = startCommand ? ` Start command: \`${startCommand}\`.` : '';
      const urlDetail = configuredUrl
        ? ` Probe target: \`${configuredUrl}\`${resolvedUrl ? ` (resolved candidate: \`${resolvedUrl}\`)` : ''}.`
        : '';
      return (
        `local_http_smoke keeps failing (${statusDetail}).` +
        urlDetail +
        commandDetail +
        ' Ensure the dev server serves the app root with a 2xx response at the smoke URL. ' +
        'If the project lives in a subfolder (for example Vite in `frontend/`), set the correct root (`--root frontend` or `root` in vite config).'
      );
    }

    // Special-case: planning delegation failures need concrete next steps.
    const delegation = (args.completion.criteriaResults ?? []).find((r) => r.message === 'delegation plan invalid');
    const delegationErrors = (delegation as any)?.evidence?.errors;
    if (delegation && Array.isArray(delegationErrors) && delegationErrors.length > 0) {
      const top = delegationErrors.slice(0, 2).map((e: any) => String(e?.message ?? '').trim()).filter(Boolean);
      const detail = top.length ? ` Example: ${top.join(' | ')}` : '';
      return (
        'Delegation plan is invalid. Fix tasks[].scopeHints so every hint matches the assigned role scope (or shared scope) in `.nibbler/contract/team.yaml`.' +
        detail
      );
    }
    const crit = failedCriteria.length ? `: ${failedCriteria.slice(0, 5).join(' | ')}` : '';
    return `Scope was correct. Focus on meeting completion criteria${crit}.`;
  }

  if (!args.scope.passed && args.completion.passed) {
    const parts: string[] = [];
    if (outOfScope.length) parts.push(`out-of-scope files: ${outOfScope.map((p) => `\`${p}\``).join(', ')}`);
    if (protectedPaths.length) parts.push(`protected paths: ${protectedPaths.map((p) => `\`${p}\``).join(', ')}`);
    const detail = parts.length ? ` (${parts.join('; ')})` : '';
    return `Your changes met completion criteria but violated scope${detail}. Restrict changes to your declared scope or request a narrow scope exception.`;
  }

  if (!args.scope.passed && !args.completion.passed) {
    return 'Both scope and completion failed. Fix scope first, then re-run completion checks; review attempt history for what worked previously.';
  }

  return undefined;
}

function buildPromptRetryFeedbackLines(feedback: unknown): string[] {
  if (!feedback || typeof feedback !== 'object') return [];
  const fb = feedback as Record<string, any>;
  const lines: string[] = [
    '## Retry feedback from engine (highest priority)',
    '- Apply this feedback before making new changes.'
  ];

  const rawHint = typeof fb.engineHint === 'string' ? fb.engineHint : '';
  const hint = rawHint.replace(/\s+/g, ' ').trim();
  if (hint) lines.push(`- ${hint}`);

  if (fb.kind === 'session_protocol_missing') {
    lines.push('- Previous attempt exited without a protocol completion signal.');
    lines.push('- End your final response with exactly one line like: `NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"..."}`.');
  }

  if (fb.kind === 'session_process_exit') {
    const code = fb.exitCode ?? 'null';
    const signal = fb.signal ?? 'null';
    lines.push(`- Previous attempt exited unexpectedly (exitCode=${code}, signal=${signal}).`);
    lines.push('- Keep changes scoped and incremental; write files first, then run validations, then emit NIBBLER_EVENT.');
  }

  const sampleViolations = Array.isArray(fb.scope?.sampleViolations)
    ? fb.scope.sampleViolations
        .filter((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0)
        .slice(0, 8)
    : [];
  const scopeViolations = Array.isArray(fb.scope?.violations)
    ? fb.scope.violations
        .map((v: any) => (typeof v?.file === 'string' ? v.file : ''))
        .filter((v: string) => v.trim().length > 0)
        .slice(0, 8)
    : [];
  const recentViolationFiles = sampleViolations.length > 0 ? sampleViolations : scopeViolations;
  const grantedScopePatterns = extractGrantedScopePatterns(fb);
  const grantedMatcher = grantedScopePatterns.length > 0 ? picomatch(grantedScopePatterns, { dot: true }) : null;
  const grantedViolationFiles =
    grantedMatcher == null ? [] : recentViolationFiles.filter((p: string) => grantedMatcher(p));
  const blockedViolationFiles =
    grantedMatcher == null ? recentViolationFiles : recentViolationFiles.filter((p: string) => !grantedMatcher(p));
  if (recentViolationFiles.length > 0) {
    lines.push(`- Recent out-of-scope files: ${recentViolationFiles.map((p: string) => `\`${p}\``).join(', ')}`);
    if (grantedViolationFiles.length > 0) {
      lines.push(
        `- Architect granted narrow scope access for: ${grantedViolationFiles.map((p: string) => `\`${p}\``).join(', ')}.`
      );
    }
    if (blockedViolationFiles.length > 0) {
      lines.push(
        `- HARD blocklist for this retry: do NOT edit ${blockedViolationFiles.map((p: string) => `\`${p}\``).join(', ')}.`
      );
      lines.push('- If these files are required to proceed, emit `NIBBLER_EVENT {"type":"NEEDS_ESCALATION",...}` instead of editing them.');
    }
  }

  const failedCriteria = Array.isArray(fb.completion?.failedCriteria)
    ? fb.completion.failedCriteria
        .filter((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0)
        .slice(0, 6)
    : [];
  if (failedCriteria.length > 0) {
    lines.push(`- Previously failed criteria: ${failedCriteria.map((c: string) => `\`${c}\``).join(', ')}`);
  }

  const failedResults = Array.isArray(fb.completion?.criteriaResults)
    ? fb.completion.criteriaResults.filter((r: any) => r && r.passed === false)
    : [];
  const smokeFailure = failedResults.find(
    (r: any) => typeof r?.message === 'string' && r.message.startsWith('local_http_smoke(')
  );
  if (smokeFailure && smokeFailure.evidence && typeof smokeFailure.evidence === 'object') {
    const ev = smokeFailure.evidence as Record<string, unknown>;
    const startCommand = typeof ev.startCommand === 'string' ? ev.startCommand : null;
    const configuredUrl = typeof ev.url === 'string' ? ev.url : null;
    const resolvedUrl = typeof ev.resolvedUrl === 'string' ? ev.resolvedUrl : null;
    const httpStatus = typeof ev.httpStatus === 'number' ? ev.httpStatus : null;
    const lastError = typeof ev.lastError === 'string' ? ev.lastError : null;
    const stdoutTail = typeof ev.stdoutTail === 'string' ? ev.stdoutTail : '';
    const discoveredUrl = (() => {
      const m = /(https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5})/i.exec(stdoutTail);
      return m?.[1] ?? null;
    })();

    if (startCommand) lines.push(`- local_http_smoke start command: \`${startCommand}\``);
    if (configuredUrl || resolvedUrl || discoveredUrl) {
      lines.push(
        `- local_http_smoke URLs: configured=${configuredUrl ? `\`${configuredUrl}\`` : 'n/a'}, resolved=${resolvedUrl ? `\`${resolvedUrl}\`` : discoveredUrl ? `\`${discoveredUrl}\`` : 'n/a'}`
      );
    }
    if (httpStatus != null) {
      lines.push(`- local_http_smoke received HTTP ${httpStatus}; check server root/path so the smoke URL returns 2xx.`);
    } else if (lastError) {
      lines.push(`- local_http_smoke last error: ${lastError}`);
    }
  }

  const hasSessionSignalFeedback = fb.kind === 'session_protocol_missing' || fb.kind === 'session_process_exit';
  if (!hint && recentViolationFiles.length === 0 && failedCriteria.length === 0 && !hasSessionSignalFeedback) return [];
  lines.push('- Keep changes minimal and strictly inside your allowed scope.');
  return lines;
}

function extractGrantedScopePatterns(feedback: Record<string, any>): string[] {
  const decision = feedback.scopeDecision;
  if (!decision || typeof decision !== 'object') return [];
  if ((decision as any).decision !== 'grant_narrow_access') return [];

  const patterns: unknown[] = Array.isArray((decision as any).patterns) ? (decision as any).patterns : [];
  return patterns
    .filter((p: unknown): p is string => typeof p === 'string')
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 32);
}

function resolveDelegation(tasks: DelegationTask[]): { roleOrder: string[]; tasksByRole: Map<string, DelegationTask[]> } {
  const byId = new Map<string, DelegationTask>();
  for (const t of tasks) byId.set(t.taskId, t);

  // Topo sort by dependsOn; stable-ish using priority and then taskId.
  const indeg = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.taskId, 0);
    outgoing.set(t.taskId, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!outgoing.has(dep)) continue;
      outgoing.get(dep)!.push(t.taskId);
      indeg.set(t.taskId, (indeg.get(t.taskId) ?? 0) + 1);
    }
  }

  const q: string[] = [];
  for (const [id, d] of indeg.entries()) if (d === 0) q.push(id);
  q.sort((a, b) => (byId.get(a)?.priority ?? 0) - (byId.get(b)?.priority ?? 0) || a.localeCompare(b));

  const orderedTaskIds: string[] = [];
  while (q.length) {
    const id = q.shift()!;
    orderedTaskIds.push(id);
    for (const to of outgoing.get(id) ?? []) {
      indeg.set(to, (indeg.get(to) ?? 0) - 1);
      if (indeg.get(to) === 0) {
        q.push(to);
        q.sort((a, b) => (byId.get(a)?.priority ?? 0) - (byId.get(b)?.priority ?? 0) || a.localeCompare(b));
      }
    }
  }

  // If cycles (should be validated earlier), fall back to input order.
  const orderedTasks = orderedTaskIds.length === tasks.length ? orderedTaskIds.map((id) => byId.get(id)!).filter(Boolean) : tasks;

  const roleOrder: string[] = [];
  const seenRole = new Set<string>();
  const tasksByRole = new Map<string, DelegationTask[]>();
  for (const t of orderedTasks) {
    const arr = tasksByRole.get(t.roleId) ?? [];
    arr.push(t);
    tasksByRole.set(t.roleId, arr);
    if (!seenRole.has(t.roleId)) {
      roleOrder.push(t.roleId);
      seenRole.add(t.roleId);
    }
  }

  return { roleOrder, tasksByRole };
}

function mustRole(contract: Contract, roleId: string): RoleDefinition {
  const role = contract.roles.find((r) => r.id === roleId);
  if (!role) throw new Error(`Unknown role '${roleId}'`);
  return role;
}

function filterEngineFiles(d: DiffResult): DiffResult {
  const files = d.files.filter((f) => !isEnginePath(f.path));
  return {
    raw: d.raw,
    files,
    summary: {
      additions: files.reduce((a, f) => a + f.additions, 0),
      deletions: files.reduce((a, f) => a + f.deletions, 0),
      filesChanged: files.length
    }
  };
}

function isEnginePath(p: string): boolean {
  if (p.startsWith('.nibbler/jobs/')) return true; // evidence + status
  if (p.startsWith('.nibbler/config/cursor-profiles/')) return true; // permissions profiles
  if (p.startsWith('.nibbler-staging/')) return true; // agent staging area (engine materializes from here)
  if (p.startsWith('.cursor/rules/20-role-') && p.endsWith('.mdc')) return true; // overlay swap
  return false;
}

function findStartPhaseId(contract: Contract): string | null {
  const indegree = new Map<string, number>(contract.phases.map((p) => [p.id, 0]));
  for (const p of contract.phases) {
    for (const s of p.successors ?? []) {
      indegree.set(s.next, (indegree.get(s.next) ?? 0) + 1);
    }
  }
  const starts = contract.phases.map((p) => p.id).filter((id) => (indegree.get(id) ?? 0) === 0);
  return starts.length ? starts[0] : null;
}

function phaseExists(contract: Contract, phaseId: string): boolean {
  return contract.phases.some((p) => p.id === phaseId);
}

function normalizeTransitionTarget(target: string, contract: Contract): string {
  const t = String(target ?? '').trim();
  if (!t) return t;
  if (t === '__END__') return '__END__';
  if (phaseExists(contract, t)) return t;

  // Compatibility: older/generated contracts may encode terminal outcomes as "completed".
  const normalized = t.toLowerCase();
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done' || normalized === 'success') {
    return '__END__';
  }
  return t;
}

function jobWorkspaceRoot(job: JobState): string {
  return job.worktreePath ?? job.repoRoot;
}
