import type { PhaseDefinition, RoleDefinition } from '../contract/types.js';
import type { DelegationTask } from '../delegation/types.js';
import type { SessionMode } from '../session/controller.js';
import type { SessionFeedbackSummaryV1 } from '../job/types.js';

export interface CompiledIdentity {
  role: RoleDefinition;
  sharedScope: string[];
}

export interface CompiledMission {
  phaseId: string;
  phase?: PhaseDefinition;
  feedback?: unknown;
  feedbackHistory?: SessionFeedbackSummaryV1[];
  scopeOverrides?: Array<{ kind: string; patterns: string[]; notes?: string }>;
  delegatedTasks?: DelegationTask[];
  implementationPlanRel?: string;
  sessionMode?: SessionMode;
  handoffWriteRel?: string;
  handoffReadDirRel?: string;
}

export interface CompiledWorld {
  alwaysRead: string[];
  phaseInputs: string[];
  phaseOutputs: string[];
}

export interface CompiledContext {
  identity: CompiledIdentity;
  mission: CompiledMission;
  world: CompiledWorld;
}

