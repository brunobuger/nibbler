import { describe, expect, it } from 'vitest';

import { validateDelegation } from '../src/core/delegation/validator.js';
import type { DelegationPlan } from '../src/core/delegation/types.js';
import type { Contract } from '../src/core/contract/types.js';

const contract: Contract = {
  roles: [
    {
      id: 'architect',
      scope: ['.nibbler-staging/**'],
      authority: { allowedCommands: [], allowedPaths: [] },
      outputExpectations: [],
      verificationMethod: { kind: 'none' },
      budget: { maxIterations: 1, exhaustionEscalation: 'terminate' }
    },
    {
      id: 'worker',
      scope: ['src/**'],
      authority: { allowedCommands: [], allowedPaths: [] },
      outputExpectations: [],
      verificationMethod: { kind: 'none' },
      budget: { maxIterations: 1, exhaustionEscalation: 'terminate' }
    }
  ],
  phases: [
    {
      id: 'planning',
      actors: ['architect'],
      inputBoundaries: ['**/*'],
      outputBoundaries: ['.nibbler/jobs/<id>/plan/**'],
      preconditions: [{ type: 'always' }],
      completionCriteria: [{ type: 'artifact_exists', pattern: '.nibbler/jobs/<id>/plan/**' }],
      successors: [],
      isTerminal: true
    }
  ],
  gates: [],
  globalLifetime: { maxTimeMs: 60_000 },
  sharedScopes: [],
  escalationChain: []
};

describe('validateDelegation', () => {
  it('accepts a valid plan', () => {
    const plan: DelegationPlan = {
      version: 1,
      tasks: [
        {
          taskId: 't1',
          roleId: 'worker',
          description: 'do thing',
          scopeHints: ['src/**'],
          priority: 1
        }
      ]
    };
    expect(validateDelegation(plan, contract)).toHaveLength(0);
  });

  it('rejects unknown roleId', () => {
    const plan: DelegationPlan = {
      version: 1,
      tasks: [{ taskId: 't1', roleId: 'nope', description: 'x', scopeHints: [], priority: 0 }]
    };
    expect(validateDelegation(plan, contract).length).toBeGreaterThan(0);
  });

  it('rejects protected path scopeHints', () => {
    const plan: DelegationPlan = {
      version: 1,
      tasks: [
        { taskId: 't1', roleId: 'worker', description: 'x', scopeHints: ['.nibbler/**'], priority: 0 }
      ]
    };
    const errs = validateDelegation(plan, contract);
    expect(errs.some((e) => e.message.includes('protected path'))).toBe(true);
  });

  it('rejects cycles in dependsOn', () => {
    const plan: DelegationPlan = {
      version: 1,
      tasks: [
        { taskId: 'a', roleId: 'worker', description: 'a', scopeHints: ['src/**'], dependsOn: ['b'], priority: 0 },
        { taskId: 'b', roleId: 'worker', description: 'b', scopeHints: ['src/**'], dependsOn: ['a'], priority: 0 }
      ]
    };
    const errs = validateDelegation(plan, contract);
    expect(errs.some((e) => e.message.includes('cycle'))).toBe(true);
  });
});

