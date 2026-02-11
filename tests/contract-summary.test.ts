import { describe, expect, it } from 'vitest';

import { contractSummary } from '../src/cli/ui/branding.js';
import { stripAnsi } from '../src/cli/ui/format.js';
import type { Contract } from '../src/core/contract/types.js';

describe('contractSummary (branding)', () => {
  it('includes phase details, expectations, and gate outcomes', () => {
    const contract: Contract = {
      roles: [
        {
          id: 'architect',
          scope: ['vision.md', 'ARCHITECTURE.md'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: ['Produce a clear plan with acceptance criteria', 'Define delegation tasks'],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
        },
      ],
      phases: [
        {
          id: 'planning',
          actors: ['architect'],
          inputBoundaries: ['vision.md'],
          outputBoundaries: ['.nibbler/jobs/<id>/plan/**'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [
            { type: 'artifact_exists', pattern: '.nibbler/jobs/<id>/plan/acceptance.md' },
            { type: 'delegation_coverage' },
          ],
          successors: [{ on: 'done', next: 'ship' }],
        },
        {
          id: 'ship',
          actors: ['architect'],
          inputBoundaries: ['README.md'],
          outputBoundaries: ['README.md'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'markdown_has_headings', path: 'README.md', requiredHeadings: ['Install'] }],
          successors: [],
          isTerminal: true,
        },
      ],
      gates: [
        {
          id: 'plan',
          trigger: 'planning->ship',
          audience: 'PO',
          approvalScope: 'build_requirements',
          approvalExpectations: ['Approve product requirements and execution scope'],
          businessOutcomes: ['PO confirms planned business value for this build'],
          functionalScope: ['Approved scope maps to concrete implementation tasks'],
          outOfScope: ['Unapproved roadmap features are excluded'],
          requiredInputs: [
            { name: 'vision', kind: 'path', value: 'vision.md' },
            { name: 'architecture', kind: 'path', value: 'ARCHITECTURE.md' },
            { name: 'acceptance', kind: 'path', value: '.nibbler/jobs/<id>/plan/acceptance.md' },
          ],
          outcomes: { approve: 'ship', reject: 'planning' },
        },
      ],
      globalLifetime: { maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
      sharedScopes: [],
      escalationChain: [],
    };

    const text = stripAnsi(contractSummary(contract));
    expect(text).toContain('Roles');
    expect(text).toContain('expects:');
    expect(text).toContain('Phase Details');
    expect(text).toContain('criteria:');
    expect(text).toContain('Gates');
    expect(text).toContain('inputs:');
    expect(text).toContain('outcomes:');
  });
});

