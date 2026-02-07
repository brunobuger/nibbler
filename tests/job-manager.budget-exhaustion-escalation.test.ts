import { describe, expect, it } from 'vitest';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';

import type { Contract } from '../src/core/contract/types.js';
import { EvidenceCollector } from '../src/core/evidence/collector.js';
import { GateController } from '../src/core/gate/controller.js';
import { JobManager } from '../src/core/job-manager.js';
import { LedgerWriter } from '../src/core/ledger/writer.js';
import { SessionController } from '../src/core/session/controller.js';
import { initJob, initWorkspace } from '../src/workspace/layout.js';
import { createTempGitRepo } from './git-fixture.js';
import { MockRunnerAdapter } from './mock-runner.js';

describe('JobManager (budget exhaustion escalation)', () => {
  it('starts an architect resolution session when worker exhausts budget', async () => {
    const { dir: repoRoot } = await createTempGitRepo();
    await writeFile(join(repoRoot, '.gitignore'), '.nibbler/jobs/\n.nibbler-staging/\n.cursor/rules/20-role-*.mdc\n', 'utf8');
    await execa('git', ['add', '-A'], { cwd: repoRoot });
    await execa('git', ['commit', '-m', 'add gitignore'], { cwd: repoRoot });
    await initWorkspace(repoRoot);
    const jobPaths = await initJob(repoRoot, 'j-test');

    const evidence = new EvidenceCollector({
      evidenceDir: jobPaths.evidenceDir,
      diffsDir: jobPaths.evidenceDiffsDir,
      checksDir: jobPaths.evidenceChecksDir,
      commandsDir: jobPaths.evidenceCommandsDir,
      gatesDir: jobPaths.evidenceGatesDir
    });
    const ledger = await LedgerWriter.open(jobPaths.ledgerPath);
    const gates = new GateController(ledger, evidence);

    const contract: Contract = {
      roles: [
        {
          id: 'architect',
          scope: ['src/**'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, exhaustionEscalation: 'terminate' }
        },
        {
          id: 'worker',
          scope: ['src/**'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 2, exhaustionEscalation: 'architect' }
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
      globalLifetime: { maxTimeMs: 60_000 },
      sharedScopes: [{ roles: ['architect', 'worker'], patterns: ['src/**'] }],
      escalationChain: []
    };

    const runner = new MockRunnerAdapter({
      worker: async ({ workspacePath }) => {
        // Always out-of-scope (causes repeated failure)
        await writeFile(join(workspacePath, 'README.md'), '# temp\nout of scope\n', 'utf8');
      },
      architect: async ({ workspacePath }) => {
        // Minimal in-scope change so architect session can pass diff_non_empty
        await mkdir(join(workspacePath, 'src'), { recursive: true });
        await writeFile(join(workspacePath, 'src', 'resolution.txt'), 'resolution\n', 'utf8');
      }
    });
    const sessions = new SessionController(runner, repoRoot, { bootstrapPrompt: 'go', inactivityTimeoutMs: 2_000 });

    const jm = new JobManager(sessions, gates, evidence, ledger);
    const job = {
      repoRoot,
      jobId: 'j-test',
      currentPhaseId: 'p1',
      startedAtIso: new Date().toISOString(),
      statusPath: jobPaths.statusPath
    };

    const out = await jm.runJob(job, contract, { roles: ['worker'] });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('escalated');
    expect(runner.startedRoles).toContain('architect');

    const ledgerContent = await readFile(jobPaths.ledgerPath, 'utf8');
    expect(ledgerContent).toContain('"type":"escalation"');
  });
});

