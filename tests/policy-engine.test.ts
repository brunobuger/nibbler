import { describe, expect, it } from 'vitest';

import { verifyScope, verifyCompletion, checkBudget, shouldEnforceGate } from '../src/core/policy-engine.js';
import type { Contract } from '../src/core/contract/types.js';

describe('policy engine', () => {
  const contract: Contract = {
    roles: [
      {
        id: 'worker',
        scope: ['src/**'],
        authority: { allowedCommands: [], allowedPaths: [] },
        outputExpectations: [],
        verificationMethod: { kind: 'none' },
        budget: { maxIterations: 2, maxTimeMs: 1000, maxDiffLines: 10, exhaustionEscalation: 'escalate' }
      }
    ],
    phases: [
      {
        id: 'p1',
        actors: ['worker'],
        inputBoundaries: ['src/**'],
        outputBoundaries: ['src/**'],
        preconditions: [{ type: 'always' }],
        completionCriteria: [{ type: 'diff_non_empty' }],
        successors: [],
        isTerminal: true
      }
    ],
    gates: [{ id: 'g1', trigger: 'p1->p2', audience: 'PO', requiredInputs: [], outcomes: { approve: 'p2', reject: 'p1' } }],
    globalLifetime: { maxTimeMs: 100000 },
    sharedScopes: [],
    escalationChain: []
  };

  it('verifyScope passes for in-scope changes and fails for out-of-scope', () => {
    const diff = {
      raw: '',
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
      files: [{ path: 'src/a.ts', changeType: 'modified', additions: 1, deletions: 0 }]
    };
    const ok = verifyScope(diff, contract.roles[0], contract);
    expect(ok.passed).toBe(true);

    const badDiff = {
      raw: '',
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
      files: [{ path: 'README.md', changeType: 'modified', additions: 1, deletions: 0 }]
    };
    const bad = verifyScope(badDiff, contract.roles[0], contract);
    expect(bad.passed).toBe(false);
    expect(bad.violations[0].reason).toBe('out_of_scope');
  });

  it('budget enforcement detects exceeded limits', () => {
    const res = checkBudget({ iterations: 3, elapsedMs: 2000, diffLines: 20 }, contract.roles[0]);
    expect(res.passed).toBe(false);
    expect(res.exceeded?.iterations).toBeTruthy();
    expect(res.exceeded?.timeMs).toBeTruthy();
    expect(res.exceeded?.diffLines).toBeTruthy();
  });

  it('gate enforcement finds gates by transition trigger', () => {
    expect(shouldEnforceGate('p1->p2', contract)?.id).toBe('g1');
    expect(shouldEnforceGate('nope', contract)).toBe(null);
  });

  it('completion criteria diff_non_empty uses job.lastDiff', async () => {
    const job = {
      repoRoot: process.cwd(),
      jobId: 'j',
      currentPhaseId: 'p1',
      startedAtIso: new Date().toISOString(),
      lastDiff: { raw: '', files: [{ path: 'x', changeType: 'modified', additions: 1, deletions: 0 }], summary: { additions: 1, deletions: 0, filesChanged: 1 } }
    };
    const res = await verifyCompletion('worker', job, contract);
    expect(res.passed).toBe(true);
  });
});

