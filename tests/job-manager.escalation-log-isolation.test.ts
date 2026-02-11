import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
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

describe('JobManager (escalation log isolation)', () => {
  it('uses a dedicated architect escalation session log and restores role logs after retry', async () => {
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

    const runner = new MockRunnerAdapter({
      backend: async ({ workspacePath, attempt, emit }) => {
        if (attempt === 1) {
          emit({ type: 'NEEDS_ESCALATION', reason: 'need architect guidance' });
          return;
        }
        await mkdir(join(workspacePath, 'backend'), { recursive: true });
        await writeFile(join(workspacePath, 'backend', 'ok.ts'), 'export const ok = true;\n', 'utf8');
      },
      architect: async ({ workspacePath }) => {
        const staged = join(workspacePath, '.nibbler-staging', 'j-test', 'resolutions');
        await mkdir(staged, { recursive: true });
        await writeFile(join(staged, 'backend.md'), 'Use in-scope backend changes only.\n', 'utf8');
      }
    });
    const sessions = new SessionController(runner, repoRoot, { bootstrapPrompt: 'go', inactivityTimeoutMs: 2_000 });
    const jm = new JobManager(sessions, gates, evidence, ledger);

    const contract: Contract = {
      roles: [
        {
          id: 'backend',
          scope: ['backend/**'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 2, exhaustionEscalation: 'architect' }
        },
        {
          id: 'architect',
          scope: ['vision.md', 'ARCHITECTURE.md', 'PRD.md', '.nibbler-staging/**'],
          authority: { allowedCommands: [], allowedPaths: ['.nibbler-staging/**'] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 2, exhaustionEscalation: 'terminate' }
        }
      ],
      phases: [
        {
          id: 'execution',
          actors: ['backend'],
          inputBoundaries: ['backend/**'],
          outputBoundaries: ['backend/**'],
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

    const job = {
      repoRoot,
      jobId: 'j-test',
      currentPhaseId: 'execution',
      startedAtIso: new Date().toISOString(),
      statusPath: jobPaths.statusPath
    };

    const out = await jm.runJob(job, contract, { roles: ['backend'] });
    expect(out.ok).toBe(true);

    const logs = runner.startedSessionLogs.map((x) => x.logPath).filter((x): x is string => !!x);
    expect(logs.length).toBe(3);
    expect(new Set(logs).size).toBe(3);

    const architectEscalationLog = logs.find((p) => p.includes('architect-execution-escalation-backend-1.log'));
    expect(architectEscalationLog).toBeDefined();
    expect(logs.some((p) => p.includes('-backend-execution-1.log'))).toBe(true);
    expect(logs.some((p) => p.includes('-backend-execution-2.log'))).toBe(true);
  });
});
