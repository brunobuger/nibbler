import type { Contract } from '../contract/types.js';
import type { JobState } from '../job/types.js';
import type { CompiledContext } from './types.js';
import type { DelegationTask } from '../delegation/types.js';
import type { SessionMode } from '../session/controller.js';

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
      alwaysRead: ['vision.md', 'architecture.md'],
      phaseInputs: phase?.inputBoundaries ?? [],
      phaseOutputs: phase?.outputBoundaries ?? [],
      gates: contract.gates
    }
  };
}

