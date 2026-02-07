import { describe, expect, it } from 'vitest';

import { compileContext } from '../src/core/context/compiler.js';
import { renderOverlay } from '../src/core/context/overlay.js';
import type { Contract } from '../src/core/contract/types.js';

describe('context + overlay', () => {
  it('renders overlay with protocol and scope', () => {
    const contract: Contract = {
      roles: [
        {
          id: 'worker',
          scope: ['src/**'],
          authority: { allowedCommands: ['git'], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, exhaustionEscalation: 'escalate' }
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
      gates: [],
      globalLifetime: { maxTimeMs: 10_000 },
      sharedScopes: [],
      escalationChain: []
    };

    const job = {
      repoRoot: process.cwd(),
      jobId: 'j-test',
      currentPhaseId: 'p1',
      startedAtIso: new Date().toISOString()
    };

    const ctx = compileContext('worker', 'p1', job, contract);
    const overlay = renderOverlay(ctx);

    expect(overlay).toContain('Role: worker');
    expect(overlay).toContain('Scope:');
    expect(overlay).toContain('NIBBLER_EVENT {"type":"PHASE_COMPLETE"');
  });
});

