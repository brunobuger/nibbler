import { describe, expect, it } from 'vitest';

import { validateContract } from '../src/core/contract/validator.js';
import type { Contract } from '../src/core/contract/types.js';

function baseValidContract(): Contract {
  return {
    roles: [
      {
        id: 'architect',
        scope: ['src/architect/**'],
        authority: { allowedCommands: [], allowedPaths: [] },
        outputExpectations: [],
        verificationMethod: { kind: 'none' },
        budget: { maxIterations: 1, exhaustionEscalation: 'escalate' }
      },
      {
        id: 'worker',
        scope: ['src/worker/**'],
        authority: { allowedCommands: [], allowedPaths: [] },
        outputExpectations: [],
        verificationMethod: { kind: 'none' },
        budget: { maxIterations: 1, exhaustionEscalation: 'escalate' }
      }
    ],
    phases: [
      {
        id: 'start',
        actors: ['architect'],
        inputBoundaries: ['src/**'],
        outputBoundaries: ['src/**'],
        preconditions: [{ type: 'always' }],
        completionCriteria: [{ type: 'diff_non_empty' }],
        successors: [{ on: 'done', next: 'end' }]
      },
      {
        id: 'end',
        actors: ['worker'],
        inputBoundaries: ['src/**'],
        outputBoundaries: ['src/**'],
        preconditions: [{ type: 'always' }],
        completionCriteria: [{ type: 'diff_non_empty' }],
        successors: [],
        isTerminal: true
      }
    ],
    gates: [
      { id: 'plan', trigger: 'start->end', audience: 'PO', requiredInputs: [], outcomes: { approve: 'end', reject: 'start' } }
    ],
    globalLifetime: { maxTimeMs: 1000 },
    sharedScopes: [],
    escalationChain: []
  };
}

describe('contract validator', () => {
  it('accepts a valid contract', () => {
    const errs = validateContract(baseValidContract());
    expect(errs).toHaveLength(0);
  });

  it('Rule 1.1: rejects missing role scope', () => {
    const c = baseValidContract();
    // @ts-expect-error test invalid
    c.roles[0].scope = [];
    const errs = validateContract(c);
    expect(errs.some((e) => e.rule === '1.1')).toBe(true);
  });

  it('Rule 5.3: rejects protected paths in role scope', () => {
    const c = baseValidContract();
    c.roles[0].scope = ['.nibbler/**'];
    const errs = validateContract(c);
    expect(errs.some((e) => e.rule === '5.3')).toBe(true);
  });

  it('Rule 1.3: requires shared scope declaration for overlapping roles', () => {
    const c = baseValidContract();
    c.roles[0].scope = ['src/**'];
    c.roles[1].scope = ['src/**'];
    const errs = validateContract(c);
    expect(errs.some((e) => e.rule === '1.3')).toBe(true);

    c.sharedScopes = [{ roles: ['architect', 'worker'], patterns: ['src/**'] }];
    const ok = validateContract(c);
    expect(ok.some((e) => e.rule === '1.3')).toBe(false);
  });

  it('Rule 2.1: rejects missing phase boundaries', () => {
    const c = baseValidContract();
    // @ts-expect-error test invalid
    c.phases[0].inputBoundaries = [];
    const errs = validateContract(c);
    expect(errs.some((e) => e.rule === '2.1')).toBe(true);
  });

  it('Rule 3.1: rejects missing completion criteria', () => {
    const c = baseValidContract();
    // @ts-expect-error test invalid
    c.phases[0].completionCriteria = [];
    const errs = validateContract(c);
    expect(errs.some((e) => e.rule === '3.1')).toBe(true);
  });

  it('Rule 3.4: requires gate approve+reject outcomes', () => {
    const c = baseValidContract();
    c.gates[0].outcomes = { approve: 'end' };
    const errs = validateContract(c);
    expect(errs.some((e) => e.rule === '3.4')).toBe(true);
  });

  it('Rule 5.5: requires at least one PO gate', () => {
    const c = baseValidContract();
    c.gates = [{ id: 'x', trigger: 't', audience: 'architect', requiredInputs: [], outcomes: { approve: 'end', reject: 'start' } }];
    const errs = validateContract(c);
    expect(errs.some((e) => e.rule === '5.5')).toBe(true);
  });

  it('Rule 4.2: requires budget exhaustion escalation per role', () => {
    const c = baseValidContract();
    // @ts-expect-error test invalid
    c.roles[0].budget.exhaustionEscalation = undefined;
    const errs = validateContract(c);
    expect(errs.some((e) => e.rule === '4.2')).toBe(true);
  });

  it('Rule 3.3: detects cycles and missing reachable terminal', () => {
    const c = baseValidContract();
    c.phases[0].successors = [{ on: 'done', next: 'end' }];
    c.phases[1].successors = [{ on: 'loop', next: 'start' }];
    const errs = validateContract(c);
    expect(errs.some((e) => e.rule === '3.3')).toBe(true);
  });
});

