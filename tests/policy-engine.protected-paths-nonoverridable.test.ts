import { describe, expect, it } from 'vitest';

import { verifyScope } from '../src/core/policy-engine.js';
import type { Contract } from '../src/core/contract/types.js';

describe('policy engine (protected paths non-overridable)', () => {
  it('rejects protected-path changes even if role scope/shared scopes would otherwise match', () => {
    const contract: Contract = {
      roles: [
        {
          id: 'worker',
          scope: ['**/*'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, exhaustionEscalation: 'terminate' }
        }
      ],
      phases: [
        {
          id: 'p1',
          actors: ['worker'],
          inputBoundaries: ['**/*'],
          outputBoundaries: ['**/*'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [],
          isTerminal: true
        }
      ],
      gates: [],
      globalLifetime: { maxTimeMs: 60_000 },
      sharedScopes: [{ roles: ['worker', 'other'], patterns: ['.nibbler/**'] }],
      escalationChain: []
    };

    const diff = {
      raw: '',
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
      files: [{ path: '.nibbler/contract/team.yaml', changeType: 'modified', additions: 1, deletions: 0 }]
    };

    const res = verifyScope(diff as any, contract.roles[0], contract);
    expect(res.passed).toBe(false);
    expect(res.violations[0]?.reason).toBe('protected_path');
  });
});

