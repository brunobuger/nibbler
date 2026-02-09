import type { Contract, RoleDefinition } from './contract/types.js';
import { checkBudget, checkGlobalBudget, shouldEnforceGate, verifyCompletion, verifyScope } from './policy-engine.js';
import type { EvidenceCollector } from './evidence/collector.js';
import type { LedgerWriter } from './ledger/writer.js';
import type { GateController } from './gate/controller.js';
import type { JobState, SessionUsage } from './job/types.js';
import { buildJobStatusSnapshotV1 } from './job/status.js';
import type { SessionController } from './session/controller.js';
import { fileExists, readJson, writeJson } from '../utils/fs.js';
import { commit, clean, diff, getCurrentBranch, getCurrentCommit, git, lsFiles, resetHard } from '../git/operations.js';
import type { DiffResult } from '../git/diff-parser.js';
import type { SessionHandle } from './session/types.js';
import { buildEffectiveContractForSession, isStructuralOutOfScopeViolation } from './scope/overrides.js';
import { readDelegationPlanYaml } from './delegation/parser.js';
import { validateDelegation } from './delegation/validator.js';
import type { DelegationTask } from './delegation/types.js';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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
   * Best-effort cancellation entrypoint for SIGINT/SIGTERM.
   * Captures evidence and writes `job_cancelled` to the ledger.
   */
  async cancel(job: JobState, info: { signal?: string; reason?: string } = {}): Promise<void> {
    this.cancelInfo = info;
    job.state = 'cancelled';
    job.sessionActive = false;
    await this.persist(job);

    if (this.activeHandle) {
      try {
        await this.sessionController.stopSession(this.activeHandle);
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
    return await this.runContractJobInternal(job, contract, {
      startPhaseId: start,
      startActorIndex: job.currentPhaseActorIndex ?? 0,
      appendJobCreated: false
    });
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

        // Terminal phase ends the job.
        if (phase.isTerminal === true || phase.successors.length === 0) break;

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
          job.state = 'paused';
          job.pendingGateId = gateDef.id;
          await this.persist(job);

          const resolution = await this.gateController.presentGate(gateDef, job);
          const mapped = gateDef.outcomes?.[resolution.decision];
          if (!mapped) {
            const out: JobOutcome = {
              ok: false,
              reason: 'failed',
              details: { message: 'Gate outcome missing', gate: gateDef, resolution }
            };
            await this.finalizeForOutcome(job, out);
            return out;
          }
          job.state = 'executing';
          job.pendingGateId = null;
          await this.persist(job);
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
    job.currentRoleMaxIterations = roleDef.budget.maxIterations ?? 1;

    const maxIterations = roleDef.budget.maxIterations ?? 1;
    let attempt = 1;
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

      const repo = git(jobWorkspaceRoot(job));
      const attemptStart = Date.now();

      const preSessionCommit = await getCurrentCommit(repo);
      job.preSessionCommit = preSessionCommit;
      await this.persist(job);

      // Delegation-driven execution runs a plan-step before implementation.
      let implPlanRel: string | null = null;
      if (job.currentPhaseId === 'execution' && options.delegatedTasks && options.delegatedTasks.length > 0) {
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
          await this.persist(job);
          attempt += 1;
          continue;
        }
        implPlanRel = planRes.implPlanRel;
      }

      await this.ledger.append({ type: 'session_start', data: { role: roleId, commit: preSessionCommit, mode: 'implement' } } as any);

      // Rendering hook: role session starting
      this.hooks.onRoleStart?.({ roleId, job, attempt, maxAttempts: maxIterations });

      job.sessionActive = true;
      job.sessionStartedAtIso = new Date().toISOString();
      job.sessionHandleId = null;
      job.sessionPid = null;
      job.sessionLastActivityAtIso = null;
      job.sessionLogPath = `.nibbler/jobs/${job.jobId}/evidence/sessions/${roleId}-${job.currentPhaseId}-${attempt}.log`;
      await this.persist(job);

      const effectiveContract = buildEffectiveContractForSession(contract, job, roleId, {
        phaseId: job.currentPhaseId,
        attempt
      });

      const planningBootstrapPrompt =
        roleId === 'architect' && job.currentPhaseId === 'planning'
          ? [
              'You are in the PLANNING phase.',
              '',
              'IMPORTANT: Do NOT implement or scaffold the product yet. Do NOT modify repo files outside planning artifacts.',
              '',
              `Write planning artifacts ONLY under: .nibbler-staging/plan/${job.jobId}/`,
              '',
              'Required artifact: delegation.yaml (STRICT YAML, schema below). The engine will copy it into .nibbler/jobs/<id>/plan/ before verification.',
              '',
              'delegation.yaml schema (example):',
              'version: 1',
              'tasks:',
              '  - taskId: t1',
              '    roleId: frontend',
              '    description: "Scaffold Next.js app + basic routes"',
              '    scopeHints: ["src/app/**", "package.json"]',
              '    priority: 1',
              '',
              'Notes:',
              '- tasks[].scopeHints must stay within the role scope (or shared scope) from `.nibbler/contract/team.yaml`.',
              '- Quote any YAML string values that start with punctuation (e.g. backticks).',
              '',
              'When finished, emit:',
              'NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"planning artifacts written"}'
            ].join('\n')
          : undefined;

      const handle = await this.sessionController.startSession(roleId, job, effectiveContract, {
        mode: 'implement',
        delegatedTasks: options.delegatedTasks,
        implementationPlanRel: implPlanRel ?? undefined,
        bootstrapPrompt: implPlanRel
          ? [
              `Execute the implementation plan at: ${implPlanRel}`,
              '',
              'Follow the plan closely. If you hit a blocker, emit NEEDS_ESCALATION.',
            ].join('\n')
          : planningBootstrapPrompt
      });
      this.activeHandle = handle;
      job.sessionHandleId = handle.id;
      job.sessionPid = handle.pid ?? null;
      job.sessionLastActivityAtIso = handle.lastActivityAtIso ?? null;
      await this.persist(job);
      const outcome = await this.sessionController.waitForCompletion(handle, roleDef.budget);
      await this.sessionController.stopSession(handle);
      this.activeHandle = null;

      job.sessionActive = false;
      job.sessionLastActivityAtIso = handle.lastActivityAtIso ?? job.sessionLastActivityAtIso ?? null;
      await this.persist(job);

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

      const dAll = await diff(repo, preSessionCommit);
      const d = filterEngineFiles(dAll);
      job.lastDiff = d;
      await this.persist(job);

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

      job.feedbackByRole[roleId] = {
        outcome,
        scope,
        completion,
        budget,
        attempt
      };
      await this.persist(job);

      // Budget exceeded after attempt → escalate.
      if (!budget.passed) {
        return await this.escalate(roleId, job, contract, budget);
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
              await this.persist(job);
            }
          }
        }
      }

      attempt += 1;
    }

    // Out of iterations.
    return await this.escalate(roleId, job, contract, { passed: false, escalation: roleDef.budget.exhaustionEscalation });
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
          '    description: "Scaffold Next.js app + basic routes"',
          '    scopeHints: ["src/app/**", "package.json"]',
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
    job.sessionLogPath = `.nibbler/jobs/${job.jobId}/evidence/sessions/architect-scope-exception-${req.failedRoleId}-${job.currentPhaseId}-${req.attempt}.log`;
    await this.persist(job);

    const decisionBootstrapPrompt = [
      'You are the Architect. The engine requires a scope-exception decision for a worker role.',
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
      '{"decision":"grant_narrow_access","kind":"shared_scope","patterns":[".gitignore","next-env.d.ts"],"notes":"Next.js scaffolding requires these root files."}',
      '',
      'When finished, emit:',
      'NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"scope exception decision written"}',
      '',
    ].join('\n');

    // Run a single Architect session to produce the decision file.
    const handle = await this.sessionController.startSession('architect', job, restrictedContract, {
      bootstrapPrompt: decisionBootstrapPrompt
    });
    this.activeHandle = handle;
    job.sessionHandleId = handle.id;
    job.sessionPid = handle.pid ?? null;
    job.sessionLastActivityAtIso = handle.lastActivityAtIso ?? null;
    await this.persist(job);

    await this.sessionController.waitForCompletion(handle, mustRole(contract, 'architect').budget);
    await this.sessionController.stopSession(handle);
    this.activeHandle = null;

    job.sessionActive = false;
    job.sessionLastActivityAtIso = handle.lastActivityAtIso ?? job.sessionLastActivityAtIso ?? null;
    job.currentRoleId = prevRoleId;
    job.sessionLogPath = prevSessionLogPath;
    await this.persist(job);

    // Enforce: Architect decision must not modify non-engine paths.
    const dAll = await diff(repo, pre);
    const d = filterEngineFiles(dAll);
    if (d.files.length > 0) {
      await resetHard(repo, pre);
      await clean(repo);
      await this.ledger.append({
        type: 'scope_exception_denied',
        data: { jobId: job.jobId, role: req.failedRoleId, reason: 'architect_modified_repo', diffSummary: d.summary }
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
        data: { jobId: job.jobId, role: req.failedRoleId, reason: 'missing_decision_file', evidencePath }
      });
      return { decision: 'deny', notes: `Missing decision file: ${decisionRel}` };
    }

    const raw = await readJson<any>(decisionAbs);
    const evidencePath = await this.evidenceCollector.recordCustomCheck('architect', 'scope-exception-decision', raw);

    const decision = String(raw?.decision ?? '').trim();
    if (decision !== 'deny' && decision !== 'grant_narrow_access' && decision !== 'reroute_work' && decision !== 'terminate') {
      await this.ledger.append({
        type: 'scope_exception_denied',
        data: { jobId: job.jobId, role: req.failedRoleId, reason: 'invalid_decision', decision, evidencePath }
      });
      return { decision: 'deny', notes: `Invalid decision: ${decision}` };
    }

    if (decision === 'deny') {
      await this.ledger.append({
        type: 'scope_exception_denied',
        data: { jobId: job.jobId, role: req.failedRoleId, reason: 'denied', evidencePath, notes: raw?.notes }
      });
      return { decision: 'deny', notes: raw?.notes };
    }

    if (decision === 'reroute_work') {
      const toRoleId = raw?.toRoleId ? String(raw.toRoleId) : undefined;
      await this.ledger.append({
        type: 'scope_exception_denied',
        data: { jobId: job.jobId, role: req.failedRoleId, reason: 'reroute_work', toRoleId, evidencePath, notes: raw?.notes }
      });
      return { decision: 'reroute_work', toRoleId, notes: raw?.notes };
    }

    if (decision === 'terminate') {
      await this.ledger.append({
        type: 'scope_exception_denied',
        data: { jobId: job.jobId, role: req.failedRoleId, reason: 'terminated', evidencePath, notes: raw?.notes }
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
        data: { jobId: job.jobId, role: req.failedRoleId, reason: 'missing_patterns', evidencePath }
      });
      return { decision: 'deny', notes: 'grant_narrow_access requires non-empty patterns[]' };
    }

    await this.ledger.append({
      type: 'scope_exception_granted',
      data: {
        jobId: job.jobId,
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

  private async escalate(roleId: string, job: JobState, contract: Contract, budgetResult: unknown): Promise<JobOutcome> {
    // Rendering hook: escalation
    this.hooks.onEscalation?.({ roleId, reason: 'budget_exhausted' });

    await this.ledger.append({
      type: 'escalation',
      data: { jobId: job.jobId, role: roleId, reason: 'budget_exhausted', budget: budgetResult }
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
      failedRoleFeedback: job.feedbackByRole[roleId]
    };
    await this.persist(job);

    await this.runRoleSession('architect', job, contract);

    job.state = 'failed';
    await this.persist(job);
    return { ok: false, reason: 'escalated', details: { roleId } };
  }

  private async persist(job: JobState): Promise<void> {
    if (!job.statusPath) return;
    await writeJson(job.statusPath, buildJobStatusSnapshotV1(job));
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

  private async finalize(job: JobState, type: 'job_completed' | 'job_failed' | 'job_budget_exceeded' | 'job_cancelled', data: unknown): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

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

    const prompt = [
      'You are in Cursor PLAN MODE.',
      '',
      'Your Architect has delegated tasks to you. Deep-dive into the codebase and produce a detailed implementation plan.',
      '',
      '## Output',
      `Write your plan to: ${stagedRel}`,
      '',
      '## Tasks',
      ...req.delegatedTasks.map((t) => `- [${t.taskId}] ${t.description}${t.scopeHints?.length ? ` (scopeHints: ${t.scopeHints.join(', ')})` : ''}`),
      '',
      'Do NOT make code changes. Only write the plan file in the staging path above.',
      '',
      'When finished, emit:',
      'NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"role plan written"}'
    ].join('\n');

    const handle = await this.sessionController.startSession(roleId, job, contract, {
      mode: 'plan',
      delegatedTasks: req.delegatedTasks,
      implementationPlanRel: undefined,
      bootstrapPrompt: prompt
    });
    this.activeHandle = handle;
    await this.persist(job);
    await this.sessionController.waitForCompletion(handle, mustRole(contract, roleId).budget);
    await this.sessionController.stopSession(handle);
    this.activeHandle = null;

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
      'When finished, emit:',
      'NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"architect guidance written"}'
    ].join('\n');

    const handle = await this.sessionController.startSession('architect', job, restrictedContract, { mode: 'plan', bootstrapPrompt: prompt });
    this.activeHandle = handle;
    await this.persist(job);
    await this.sessionController.waitForCompletion(handle, mustRole(contract, 'architect').budget);
    await this.sessionController.stopSession(handle);
    this.activeHandle = null;

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

function jobWorkspaceRoot(job: JobState): string {
  return job.worktreePath ?? job.repoRoot;
}

