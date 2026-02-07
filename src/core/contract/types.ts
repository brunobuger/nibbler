import { z } from 'zod';

export const ScopePattern = z.string().min(1);

export const BudgetSpec = z.object({
  maxIterations: z.number().int().positive().optional(),
  maxTimeMs: z.number().int().positive().optional(),
  maxDiffLines: z.number().int().positive().optional(),
  exhaustionEscalation: z.string().min(1).optional()
});

export const VerificationSpec = z.object({
  // v1: a simple description or a command string. Runtime checks land in later phases.
  kind: z.enum(['command', 'script', 'none']).default('none'),
  command: z.string().optional()
});

export const AuthoritySpec = z.object({
  allowedCommands: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([])
});

export const RoleDefinition = z.object({
  id: z.string().min(1),
  scope: z.array(ScopePattern).min(1),
  authority: AuthoritySpec.default({ allowedCommands: [], allowedPaths: [] }),
  outputExpectations: z.array(z.string()).default([]),
  verificationMethod: VerificationSpec.default({ kind: 'none' }),
  budget: BudgetSpec,
  behavioralGuidance: z.string().optional()
});

export const Criterion = z.discriminatedUnion('type', [
  z.object({ type: z.literal('artifact_exists'), pattern: z.string().min(1) }),
  z.object({ type: z.literal('command_succeeds'), command: z.string().min(1) }),
  z.object({ type: z.literal('command_fails'), command: z.string().min(1) }),
  z.object({ type: z.literal('diff_non_empty') }),
  z.object({
    type: z.literal('diff_within_budget'),
    maxFiles: z.number().int().positive().optional(),
    maxLines: z.number().int().positive().optional()
  }),
  z.object({ type: z.literal('custom'), script: z.string().min(1) })
]);

export const Precondition = z.discriminatedUnion('type', [
  z.object({ type: z.literal('artifact_exists'), pattern: z.string().min(1) }),
  z.object({ type: z.literal('always') })
]);

export const SuccessorMapping = z.object({
  on: z.string().min(1),
  next: z.string().min(1)
});

export const PhaseDefinition = z.object({
  id: z.string().min(1),
  // NOTE: In v1, preconditions are not enforced at runtime yet. Some LLM outputs may
  // emit unexpected shapes/types here; treat invalid preconditions as empty so init
  // doesn't fail on non-critical schema drift.
  preconditions: z.array(Precondition).catch([]).default([]),
  actors: z.array(z.string()).min(1),
  inputBoundaries: z.array(z.string()).min(1),
  outputBoundaries: z.array(z.string()).min(1),
  completionCriteria: z.array(Criterion).min(1),
  successors: z.array(SuccessorMapping).default([]),
  isTerminal: z.boolean().optional()
});

export const GateInputSpec = z.object({
  name: z.string().min(1),
  kind: z.enum(['path', 'text']).default('path'),
  value: z.string().min(1)
});

export const GateDefinition = z.object({
  id: z.string().min(1),
  trigger: z.string().min(1),
  audience: z.union([z.literal('PO'), z.literal('architect'), z.string().min(1)]),
  requiredInputs: z.array(GateInputSpec).default([]),
  outcomes: z.record(z.string(), z.string())
});

export const SharedScopeDeclaration = z.object({
  roles: z.array(z.string()).min(2),
  patterns: z.array(ScopePattern).default([])
});

export const EscalationStep = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().min(1).optional()
});

export const Contract = z.object({
  roles: z.array(RoleDefinition).min(1),
  phases: z.array(PhaseDefinition).min(1),
  gates: z.array(GateDefinition).default([]),
  globalLifetime: BudgetSpec,
  sharedScopes: z.array(SharedScopeDeclaration).default([]),
  escalationChain: z.array(EscalationStep).default([])
});

export type Contract = z.infer<typeof Contract>;
export type RoleDefinition = z.infer<typeof RoleDefinition>;
export type PhaseDefinition = z.infer<typeof PhaseDefinition>;
export type GateDefinition = z.infer<typeof GateDefinition>;
export type Criterion = z.infer<typeof Criterion>;
export type BudgetSpec = z.infer<typeof BudgetSpec>;
export type SharedScopeDeclaration = z.infer<typeof SharedScopeDeclaration>;

