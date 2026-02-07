import type { GateDefinition, PhaseDefinition, RoleDefinition } from '../contract/types.js';
import type { DelegationTask } from '../delegation/types.js';
import type { SessionMode } from '../session/controller.js';

export interface CompiledIdentity {
  role: RoleDefinition;
  sharedScope: string[];
}

export interface CompiledMission {
  phaseId: string;
  phase?: PhaseDefinition;
  feedback?: unknown;
  delegatedTasks?: DelegationTask[];
  implementationPlanRel?: string;
  sessionMode?: SessionMode;
}

export interface CompiledWorld {
  alwaysRead: string[];
  phaseInputs: string[];
  phaseOutputs: string[];
  gates: GateDefinition[];
}

export interface CompiledContext {
  identity: CompiledIdentity;
  mission: CompiledMission;
  world: CompiledWorld;
}

