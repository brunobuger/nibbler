import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Contract } from '../contract/types.js';
import type { JobState } from '../job/types.js';
import type { CompiledContext } from './types.js';
import type { DelegationTask } from '../delegation/types.js';
import type { SessionMode } from '../session/controller.js';

function resolveDocVariantSync(dir: string, variants: string[], defaultName: string): string {
  for (const v of variants) {
    if (existsSync(join(dir, v))) return v;
  }
  return defaultName;
}

export function compileContext(
  roleId: string,
  phaseId: string,
  job: JobState,
  contract: Contract,
  extras?: { delegatedTasks?: DelegationTask[]; implementationPlanRel?: string; sessionMode?: SessionMode }
): CompiledContext {
  const role = contract.roles.find((r) => r.id === roleId);
  if (!role) {
    throw new Error(`Unknown role '${roleId}'`);
  }

  const phase = contract.phases.find((p) => p.id === phaseId);

  const feedback = job.feedbackByRole?.[roleId];

  const sharedScope = (contract.sharedScopes ?? [])
    .filter((s) => s.roles.includes(roleId))
    .flatMap((s) => (s.patterns?.length ? s.patterns : ['**/*']));

  // Read durable top-level artifacts, preserving on-disk casing.
  const workspaceRoot = job.worktreePath ?? job.repoRoot;
  const visionRel = resolveDocVariantSync(workspaceRoot, ['vision.md', 'VISION.md', 'Vision.md'], 'vision.md');
  const architectureRel = resolveDocVariantSync(
    workspaceRoot,
    ['architecture.md', 'ARCHITECTURE.md', 'Architecture.md'],
    'architecture.md'
  );

  return {
    identity: { role, sharedScope },
    mission: {
      phaseId,
      phase,
      feedback,
      delegatedTasks: extras?.delegatedTasks,
      implementationPlanRel: extras?.implementationPlanRel,
      sessionMode: extras?.sessionMode
    },
    world: {
      alwaysRead: [visionRel, architectureRel],
      phaseInputs: phase?.inputBoundaries ?? [],
      phaseOutputs: phase?.outputBoundaries ?? [],
      gates: contract.gates
    }
  };
}

