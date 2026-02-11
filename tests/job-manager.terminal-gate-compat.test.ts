import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

describe('JobManager (terminal gate compatibility)', () => {
  it('treats gate outcome "completed" as terminal end-state', async () => {
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
          inputBoundaries: ['README.md'],
          outputBoundaries: ['README.md'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [],
          isTerminal: true
        }
      ],
      gates: [
        {
          id: 'ship_approval',
          trigger: 'ship->__END__',
          audience: 'PO',
          approvalScope: 'phase_output',
          approvalExpectations: ['Approve terminal ship artifacts'],
          businessOutcomes: ['Release is approved for completion'],
          functionalScope: ['Terminal outputs satisfy release expectations'],
          outOfScope: ['No additional implementation scope is approved'],
          requiredInputs: [],
          outcomes: { approve: 'completed', reject: 'ship' }
        }
      ],
      globalLifetime: { maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
      sharedScopes: [],
      escalationChain: []
    };

    const runner = new MockRunnerAdapter({
      docs: async ({ workspacePath }) => {
        await mkdir(workspacePath, { recursive: true });
        await writeFile(join(workspacePath, 'README.md'), '# Ship\n', 'utf8');
      }
    });
    const sessions = new SessionController(runner, repoRoot, { bootstrapPrompt: 'go', inactivityTimeoutMs: 2_000 });
    const jm = new JobManager(sessions, gates, evidence, ledger);

    const job: any = {
      repoRoot,
      jobId: 'j-test',
      currentPhaseId: 'ship',
      startedAtIso: new Date().toISOString(),
      statusPath: jobPaths.statusPath
    };

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      const out = await jm.runContractJob(job, contract);
      expect(out.ok).toBe(true);
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }

    const status = await readFile(jobPaths.statusPath, 'utf8');
    expect(status).toContain('"state": "completed"');

    const ledgerText = await readFile(jobPaths.ledgerPath, 'utf8');
    expect(ledgerText).not.toContain("Unknown phase 'completed'");
  });
});
