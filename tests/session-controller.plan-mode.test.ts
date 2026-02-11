import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initWorkspace } from '../src/workspace/layout.js';
import { SessionController } from '../src/core/session/controller.js';
import type { Contract } from '../src/core/contract/types.js';
import { MockRunnerAdapter } from './mock-runner.js';

describe('SessionController plan mode', () => {
  it('spawns with plan mode and read-only permissions', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-planmode-'));
    await initWorkspace(repoRoot);

    const contract: Contract = {
      roles: [
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
          id: 'execution',
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
      jobId: 'j-test',
      currentPhaseId: 'execution',
      startedAtIso: new Date().toISOString()
    };

    const runner = new MockRunnerAdapter();
    const sc = new SessionController(runner, repoRoot, { inactivityTimeoutMs: 1_000 });

    await sc.startSession('worker', job as any, contract, { mode: 'plan', bootstrapPrompt: 'plan' });

    expect(runner.startedSessions.some((s) => s.roleId === 'worker' && s.mode === 'plan')).toBe(true);

    const profilePath = join(repoRoot, '.nibbler', 'config', 'cursor-profiles', 'worker', 'cli-config.json');
    const profile = await readFile(profilePath, 'utf8');
    expect(profile).toContain('Write(.nibbler-staging/**)');
    expect(profile).not.toContain('Write(**/*)');
  });
});

