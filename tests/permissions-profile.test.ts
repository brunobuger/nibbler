import { describe, expect, it } from 'vitest';

import { generatePermissionsConfig } from '../src/core/context/permissions.js';
import type { Contract } from '../src/core/contract/types.js';

describe('permissions profile', () => {
  it('generates Cursor cli-config.json with protected denies', () => {
    const contract: Contract = {
      roles: [],
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
      gates: [],
      globalLifetime: { maxTimeMs: 10_000 },
      sharedScopes: [],
      escalationChain: []
    };

    const role = {
      id: 'worker',
      scope: ['src/**'],
      authority: { allowedCommands: ['git', 'npm'], allowedPaths: [] },
      outputExpectations: [],
      verificationMethod: { kind: 'none' },
      budget: { maxIterations: 1, exhaustionEscalation: 'escalate' }
    } as const;

    const cfg = generatePermissionsConfig(role as any, contract);
    expect(cfg.version).toBe(1);
    expect(cfg.permissions.allow.some((s) => s === 'Read(**/*)')).toBe(true);
    expect(cfg.permissions.deny.some((s) => s === 'Write(.nibbler/**)')).toBe(true);
    expect(cfg.permissions.deny.some((s) => s === 'Write(.cursor/rules/**)')).toBe(true);
  });
});

