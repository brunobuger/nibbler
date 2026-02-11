import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readContract, writeContract } from '../src/core/contract/reader.js';
import { type Contract } from '../src/core/contract/types.js';

describe('contract reader/writer', () => {
  it('round-trips via YAML files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nibbler-contract-'));

    const contract: Contract = {
      roles: [
        {
          id: 'architect',
          scope: ['src/**'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, exhaustionEscalation: 'escalate_to_architect' }
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
          actors: ['architect'],
          inputBoundaries: ['src/**'],
          outputBoundaries: ['src/**'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [],
          isTerminal: true
        }
      ],
      gates: [
        {
          id: 'plan',
          trigger: 'start->end',
          audience: 'PO',
          approvalScope: 'phase_output',
          approvalExpectations: ['Approve phase output'],
          businessOutcomes: ['Gate decision recorded'],
          functionalScope: ['Transition to next phase is authorized'],
          outOfScope: ['No additional scope change'],
          requiredInputs: [],
          outcomes: { approve: 'end', reject: 'start' }
        }
      ],
      globalLifetime: { maxTimeMs: 10_000 },
      sharedScopes: [],
      escalationChain: []
    };

    await writeContract(dir, contract);
    const readBack = await readContract(dir);
    expect(readBack).toEqual(contract);
  });
});

