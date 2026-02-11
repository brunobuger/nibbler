import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileContext } from '../src/core/context/compiler.js';
import { renderOverlay } from '../src/core/context/overlay.js';
import type { Contract } from '../src/core/contract/types.js';

describe('context + overlay', () => {
  it('includes PRD in always-read context when present', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-context-'));
    await writeFile(join(repoRoot, 'vision.md'), '# vision\n', 'utf8');
    await writeFile(join(repoRoot, 'ARCHITECTURE.md'), '# arch\n', 'utf8');
    await writeFile(join(repoRoot, 'PRD.md'), '# prd\n', 'utf8');

    const contract: Contract = {
      roles: [
        {
          id: 'worker',
          scope: ['src/**'],
          authority: { allowedCommands: [], allowedPaths: [] },
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
      repoRoot,
      worktreePath: repoRoot,
      jobId: 'j-test',
      currentPhaseId: 'p1',
      startedAtIso: new Date().toISOString()
    };

    const ctx = compileContext('worker', 'p1', job, contract);
    expect(ctx.world.alwaysRead).toEqual(['vision.md', 'ARCHITECTURE.md', 'PRD.md']);
  });

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
      startedAtIso: new Date().toISOString(),
      attemptsByRole: { worker: 2 },
      feedbackByRole: { worker: { engineHint: 'do the thing', attempt: 1 } },
      feedbackHistoryByRole: {
        worker: [
          {
            attempt: 1,
            scope: { passed: true, violationCount: 0 },
            completion: { passed: false, failedCriteria: ['diff_non_empty'] },
            engineHint: 'Scope was correct. Focus on meeting completion criteria.',
          }
        ]
      },
      scopeOverridesByRole: {
        worker: [
          {
            kind: 'extra_scope',
            patterns: ['docs/**'],
            phaseId: 'p1',
            grantedAtIso: new Date().toISOString(),
            notes: 'worker needs doc access',
          }
        ]
      },
    };

    const ctx = compileContext('worker', 'p1', job, contract);
    const overlay = renderOverlay(ctx);

    expect(overlay).toContain('Role: worker');
    expect(overlay).toContain('Scope:');
    expect(overlay).toContain('Handoff (recommended)');
    expect(overlay).toContain('.nibbler-staging/j-test/handoffs/worker-p1.md');
    expect(overlay).toContain('.nibbler/jobs/j-test/plan/handoffs/');
    expect(overlay).toContain('Scope overrides (granted by Architect)');
    expect(overlay).toContain('extra_scope:');
    expect(overlay).toContain('Feedback from engine');
    expect(overlay).toContain('You MUST satisfy BOTH scope AND completion checks');
    expect(overlay).toContain('| Attempt | Scope | Completion | Hint |');
    expect(overlay).toContain('NIBBLER_EVENT {"type":"PHASE_COMPLETE"');
  });

  it('truncates verbose feedback payloads for prompt hygiene', () => {
    const contract: Contract = {
      roles: [
        {
          id: 'worker',
          scope: ['src/**'],
          authority: { allowedCommands: [], allowedPaths: [] },
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
      startedAtIso: new Date().toISOString(),
      feedbackByRole: {
        worker: {
          engineHint: 'trim this',
          hugeArray: Array.from({ length: 25 }, (_v, i) => `item-${i}`),
          deep: { a: { b: { c: { d: { e: 'too deep' } } } } },
          delegatedTasks: [{ taskId: 't1' }],
          context: { raw: 'internal details' }
        }
      }
    };

    const ctx = compileContext('worker', 'p1', job, contract);
    const overlay = renderOverlay(ctx);

    expect(overlay).toContain('Latest failure details:');
    expect(overlay).toContain('_(truncated for readability)_');
    expect(overlay).toContain('... (+19 more items)');
    expect(overlay).toContain('[truncated]');
    expect(overlay).toContain('__omittedKeys');
    expect(overlay).not.toContain('"delegatedTasks":');
  });
});

