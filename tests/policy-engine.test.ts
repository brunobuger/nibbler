import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
    gates: [{
      id: 'g1',
      trigger: 'p1->p2',
      audience: 'PO',
      approvalScope: 'phase_output',
      approvalExpectations: ['Approve transition output'],
      businessOutcomes: ['Gate audience confirms transition readiness'],
      functionalScope: ['Phase output is accepted for successor phase'],
      outOfScope: ['No scope expansion at this gate'],
      requiredInputs: [],
      outcomes: { approve: 'p2', reject: 'p1' }
    }],
    globalLifetime: { maxTimeMs: 100000 },
    sharedScopes: [],
    escalationChain: []
  };

  it('verifyScope passes for in-scope changes and fails for out-of-scope', () => {
    const diff = {
      raw: '',
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
      files: [{ path: 'src/a.ts', changeType: 'modified' as const, additions: 1, deletions: 0 }]
    };
    const ok = verifyScope(diff, contract.roles[0], contract);
    expect(ok.passed).toBe(true);

    const badDiff = {
      raw: '',
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
      files: [{ path: 'README.md', changeType: 'modified' as const, additions: 1, deletions: 0 }]
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
      lastDiff: { raw: '', files: [{ path: 'x', changeType: 'modified' as const, additions: 1, deletions: 0 }], summary: { additions: 1, deletions: 0, filesChanged: 1 } }
    };
    const res = await verifyCompletion('worker', job, contract);
    expect(res.passed).toBe(true);
  });

  it('completion criteria markdown_has_headings enforces headings + minChars', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-policy-engine-'));
    try {
      await writeFile(
        join(repoRoot, 'README.md'),
        ['# Project', '', '## Install / build', '', '## Quickstart', '', 'Some text here.'].join('\n'),
        'utf8'
      );

      const c: Contract = {
        roles: [
          {
            id: 'docs',
            scope: ['README.md'],
            authority: { allowedCommands: [], allowedPaths: [] },
            outputExpectations: [],
            verificationMethod: { kind: 'none' },
            budget: { maxIterations: 1, exhaustionEscalation: 'architect' }
          }
        ],
        phases: [
          {
            id: 'ship',
            actors: ['docs'],
            inputBoundaries: ['**/*'],
            outputBoundaries: ['README.md'],
            preconditions: [{ type: 'always' }],
            completionCriteria: [
              {
                type: 'markdown_has_headings',
                path: 'README.md',
                requiredHeadings: ['Install', 'Quickstart'],
                minChars: 20
              } as any
            ],
            successors: [],
            isTerminal: true
          }
        ],
        gates: [],
        globalLifetime: { maxTimeMs: 100000 },
        sharedScopes: [],
        escalationChain: []
      };

      const job = {
        repoRoot,
        jobId: 'j',
        currentPhaseId: 'ship',
        startedAtIso: new Date().toISOString()
      };

      const ok = await verifyCompletion('docs', job, c);
      expect(ok.passed).toBe(true);

      const bad = await verifyCompletion('docs', { ...job, repoRoot }, {
        ...c,
        phases: [
          {
            ...c.phases[0]!,
            completionCriteria: [
              {
                type: 'markdown_has_headings',
                path: 'README.md',
                requiredHeadings: ['Usage'],
                minChars: 9999
              } as any
            ]
          }
        ]
      });
      expect(bad.passed).toBe(false);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('defers local_http_smoke when criterion surface is outside delegated role scope', async () => {
    const c: Contract = {
      roles: [
        {
          id: 'backend',
          scope: ['backend/**', 'shared/**'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, exhaustionEscalation: 'architect' }
        },
        {
          id: 'frontend',
          scope: ['frontend/**', 'shared/**'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, exhaustionEscalation: 'architect' }
        }
      ],
      phases: [
        {
          id: 'execution',
          actors: ['backend', 'frontend'],
          inputBoundaries: ['backend/**', 'frontend/**', 'shared/**'],
          outputBoundaries: ['backend/**', 'frontend/**', 'shared/**'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [
            {
              type: 'local_http_smoke',
              startCommand: 'npx vite --config frontend/vite.config.ts',
              url: 'http://localhost:5173',
              timeoutMs: 1000
            } as any
          ],
          successors: [],
          isTerminal: true
        }
      ],
      gates: [],
      globalLifetime: { maxTimeMs: 100000 },
      sharedScopes: [],
      escalationChain: []
    };

    const job = {
      repoRoot: process.cwd(),
      jobId: 'j',
      currentPhaseId: 'execution',
      startedAtIso: new Date().toISOString(),
      lastDiff: {
        raw: '',
        files: [{ path: 'backend/src/api.ts', changeType: 'modified' as const, additions: 1, deletions: 0 }],
        summary: { additions: 1, deletions: 0, filesChanged: 1 }
      },
      delegationPlan: {
        version: 1,
        tasks: [
          {
            taskId: 't1',
            roleId: 'backend',
            description: 'backend work',
            scopeHints: ['backend/**'],
            priority: 1
          }
        ]
      }
    };

    const res = await verifyCompletion('backend', job as any, c);
    expect(res.passed).toBe(true);
    expect(res.criteriaResults[0]?.message).toContain("deferred for role 'backend'");
    expect((res.criteriaResults[0]?.evidence as any)?.deferred).toBe(true);
  });

  it('defers local_http_smoke even without delegation plan when outside role scope', async () => {
    const c: Contract = {
      roles: [
        {
          id: 'backend',
          scope: ['backend/**', 'shared/**'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, exhaustionEscalation: 'architect' }
        }
      ],
      phases: [
        {
          id: 'execution',
          actors: ['backend'],
          inputBoundaries: ['backend/**', 'frontend/**', 'shared/**'],
          outputBoundaries: ['backend/**', 'frontend/**', 'shared/**'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [
            {
              type: 'local_http_smoke',
              startCommand: 'npx vite --config frontend/vite.config.ts',
              url: 'http://localhost:5173',
              timeoutMs: 1000
            } as any
          ],
          successors: [],
          isTerminal: true
        }
      ],
      gates: [],
      globalLifetime: { maxTimeMs: 100000 },
      sharedScopes: [],
      escalationChain: []
    };

    const job = {
      repoRoot: process.cwd(),
      jobId: 'j',
      currentPhaseId: 'execution',
      startedAtIso: new Date().toISOString(),
      lastDiff: {
        raw: '',
        files: [{ path: 'backend/src/api.ts', changeType: 'modified' as const, additions: 1, deletions: 0 }],
        summary: { additions: 1, deletions: 0, filesChanged: 1 }
      }
    };

    const res = await verifyCompletion('backend', job as any, c);
    expect(res.passed).toBe(true);
    expect(res.criteriaResults[0]?.message).toContain("deferred for role 'backend'");
    expect((res.criteriaResults[0]?.evidence as any)?.deferred).toBe(true);
  });
});

