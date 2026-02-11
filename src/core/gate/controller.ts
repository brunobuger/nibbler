import type { Contract, Criterion, GateDefinition } from '../contract/types.js';
import type { JobState } from '../job/types.js';
import type { EvidenceCollector } from '../evidence/collector.js';
import type { LedgerWriter } from '../ledger/writer.js';

import { collectGateInputs } from './inputs.js';
import type { GateResolution } from './types.js';
import { getRenderer } from '../../cli/ui/renderer.js';
import { computeGateFingerprint } from './fingerprint.js';

export class GateController {
  constructor(
    private ledger: LedgerWriter,
    private evidence: EvidenceCollector,
  ) {}

  async presentGate(gateDef: GateDefinition, job: JobState, contract: Contract): Promise<GateResolution> {
    const inputs = await collectGateInputs(gateDef, job.repoRoot, {
      tokens: { id: job.jobId },
      // Gates should see both job-local artifacts (repoRoot) and the active session workspace (worktree).
      extraRoots: job.worktreePath ? [job.worktreePath] : [],
    });

    const { fingerprint, planningArtifactsSha256 } = await computeGateFingerprint({ gateDef, job, contract, inputs });

    await this.evidence.recordGateInputs(gateDef.id, inputs);
    await this.ledger.append({
      type: 'gate_presented',
      data: { gateId: gateDef.id, audience: gateDef.audience, inputs: gateDef.requiredInputs },
    });

    const { currentPhase, transition, approveNext, rejectNext } = parseGateTrigger(gateDef.trigger, gateDef.outcomes);
    const phaseDef = currentPhase ? contract.phases.find((p) => p.id === currentPhase) : undefined;

    const completionCriteria =
      phaseDef?.completionCriteria
        ?.map((c) => formatCriterionLine(c, gateDef.approvalScope))
        .filter((x): x is string => Boolean(x)) ?? [];
    const phaseOutputExpectations = phaseDef
      ? phaseDef.actors
          .map((roleId) => {
            const role = contract.roles.find((r) => r.id === roleId);
            const expectations = role?.outputExpectations ?? [];
            return expectations.length ? { roleId, expectations } : null;
          })
          .filter(Boolean) as Array<{ roleId: string; expectations: string[] }>
      : [];
    const usesBuildApproval = gateDef.approvalScope === 'build_requirements' || gateDef.approvalScope === 'both';
    const usesPhaseOutput = gateDef.approvalScope === 'phase_output' || gateDef.approvalScope === 'both';

    const planned = Array.isArray(job.rolesPlanned) ? job.rolesPlanned : [];
    const completed = Array.isArray(job.rolesCompleted) ? job.rolesCompleted : [];
    const completedSet = new Set(completed);
    const remaining = planned.filter((r) => !completedSet.has(r));

    const model = {
      title: job.description ?? `Job ${job.jobId}`,
      subtitle: `Gate audience: ${gateDef.audience}`,
      description: job.description || undefined,
      team: contract.roles.map((r) => ({ roleId: r.id, scope: r.scope })),
      transition,
      currentPhase,
      approveNext,
      rejectNext,
      approvalScope: gateDef.approvalScope,
      approvalExpectations: usesBuildApproval ? gateDef.approvalExpectations : undefined,
      businessOutcomes: usesBuildApproval ? gateDef.businessOutcomes : undefined,
      functionalScope: usesBuildApproval ? gateDef.functionalScope : undefined,
      outOfScope: usesBuildApproval ? gateDef.outOfScope : undefined,
      completionCriteria: completionCriteria.length ? completionCriteria : undefined,
      outputExpectations: usesPhaseOutput && phaseOutputExpectations.length ? phaseOutputExpectations : undefined,
      rolesCompleted: completed.length ? completed : undefined,
      rolesRemaining: remaining.length ? remaining : undefined,
      artifacts: (gateDef.requiredInputs ?? []).map((i) => {
        const entry: any = inputs[i.name] as any;
        const isPath = i.kind === 'path';
        const preview = isPath && entry?.exists ? String(entry?.preview ?? '') : undefined;
        const matchesCount = entry?.resolved?.matchesCount;
        const exampleMatch = entry?.resolved?.example;
        return {
          name: i.name,
          path: isPath ? i.value : undefined,
          exists: isPath ? entry?.exists : undefined,
          preview: preview && preview.trim() ? preview : undefined,
          matchesCount: typeof matchesCount === 'number' ? matchesCount : undefined,
          exampleMatch: typeof exampleMatch === 'string' ? exampleMatch : undefined,
        };
      }),
    };

    const r = getRenderer();
    const resolution = await r.presentGatePrompt(gateDef, model, inputs);

    await this.evidence.recordGateResolution(gateDef.id, {
      ...resolution,
      audience: gateDef.audience,
      fingerprint,
      planningArtifactsSha256,
      timestamp: new Date().toISOString(),
    });
    await this.ledger.append({
      type: 'gate_resolved',
      data: {
        gateId: gateDef.id,
        trigger: gateDef.trigger,
        audience: String(gateDef.audience),
        decision: resolution.decision,
        notes: resolution.notes,
        fingerprint,
        planningArtifactsSha256,
      },
    });

    return resolution;
  }
}

function parseGateTrigger(
  trigger: string,
  outcomes?: Record<string, string>
): { transition?: string; currentPhase?: string; approveNext?: string; rejectNext?: string } {
  const t = String(trigger ?? '').trim();
  const parts = t.split('->');
  const currentPhase = parts[0]?.trim() || undefined;
  const transition = t || undefined;
  const approveNext = outcomes?.approve ? String(outcomes.approve) : undefined;
  const rejectNext = outcomes?.reject ? String(outcomes.reject) : undefined;
  return { transition, currentPhase, approveNext, rejectNext };
}

function formatCriterionLine(c: Criterion, approvalScope?: 'phase_output' | 'build_requirements' | 'both'): string | null {
  const poBuildGate = approvalScope === 'build_requirements' || approvalScope === 'both';
  switch (c.type) {
    case 'artifact_exists':
      if (poBuildGate) {
        const pattern = String(c.pattern ?? '').replaceAll('\\', '/');
        if (pattern.includes('.nibbler/jobs/') && pattern.includes('/plan/')) {
          return 'Planning artifacts are generated and ready for PO review';
        }
        if (pattern.toLowerCase() === 'readme.md') {
          return 'Release README artifact is present';
        }
      }
      return `Artifact exists: ${c.pattern}`;
    case 'command_succeeds':
      return poBuildGate ? `Verification command passed: ${c.command}` : `Command succeeds: ${c.command}`;
    case 'command_fails':
      return poBuildGate ? `Expected failing validation observed: ${c.command}` : `Command fails: ${c.command}`;
    case 'local_http_smoke':
      return poBuildGate ? 'Local application smoke check passed' : `HTTP smoke: ${c.startCommand} -> ${c.url}`;
    case 'diff_non_empty':
      return poBuildGate ? 'Phase produced concrete repository changes' : 'Diff is non-empty';
    case 'markdown_has_headings':
      return poBuildGate
        ? `Documentation structure checks passed for ${c.path}`
        : `Markdown headings: ${c.path} requires [${c.requiredHeadings.join(', ')}]`;
    case 'delegation_coverage':
      if (poBuildGate) return 'Delegation plan covers assigned tasks and role boundaries';
      return `Delegation coverage${c.requireAllTasks === false ? ' (any task ok)' : ''}${c.requireScopeHints === false ? ' (scopeHints optional)' : ''}`;
    case 'diff_within_budget':
      return `Diff budget: maxFiles=${c.maxFiles ?? 'default'} maxLines=${c.maxLines ?? 'default'}`;
    case 'custom':
      return `Custom check: ${c.script}`;
    default:
      // Exhaustiveness guard for future criterion types.
      return `Criterion: ${(c as any).type ?? 'unknown'}`;
  }
}
