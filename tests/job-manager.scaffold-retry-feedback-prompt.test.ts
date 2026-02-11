import { describe, expect, it } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
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

describe('JobManager (scaffold retry feedback prompt)', () => {
  it('injects retry blocklist feedback into scaffold retry prompts', async () => {
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
          scope: ['vision.md', 'ARCHITECTURE.md', 'PRD.md'],
          authority: { allowedCommands: [], allowedPaths: ['package.json'] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 2, exhaustionEscalation: 'architect' }
        }
      ],
      phases: [
        {
          id: 'scaffold',
          actors: ['architect'],
          inputBoundaries: ['vision.md', 'ARCHITECTURE.md', 'PRD.md'],
          outputBoundaries: ['package.json'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [],
          isTerminal: true
        }
      ],
      gates: [],
      globalLifetime: { maxTimeMs: 60_000 },
      sharedScopes: [],
      escalationChain: []
    };

    let retryPrompt = '';
    const runner = new MockRunnerAdapter({
      architect: async ({ workspacePath, attempt, message }) => {
        if (attempt === 1) {
          await writeFile(join(workspacePath, 'README.md'), 'out of scope\n', 'utf8');
          await writeFile(join(workspacePath, 'package.json'), '{"name":"ok"}\n', 'utf8');
          return;
        }
        retryPrompt = message;
        await writeFile(join(workspacePath, 'package.json'), '{"name":"ok2"}\n', 'utf8');
      }
    });
    const sessions = new SessionController(runner, repoRoot, { bootstrapPrompt: 'go', inactivityTimeoutMs: 2_000 });

    const jm = new JobManager(sessions, gates, evidence, ledger);
    const job = {
      repoRoot,
      jobId: 'j-test',
      currentPhaseId: 'scaffold',
      startedAtIso: new Date().toISOString(),
      statusPath: jobPaths.statusPath
    };

    const out = await jm.runJob(job, contract, { roles: ['architect'] });
    expect(out.ok).toBe(true);
    expect(retryPrompt).toContain('## Retry feedback from engine (highest priority)');
    expect(retryPrompt).toContain('HARD blocklist for this retry');
    expect(retryPrompt).toContain('`README.md`');

    const ledgerContent = await readFile(jobPaths.ledgerPath, 'utf8');
    expect((ledgerContent.match(/"type":"session_feedback"/g) ?? []).length).toBe(1);
  });
});
