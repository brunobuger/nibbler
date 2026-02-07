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

describe('JobManager (scope violation severity escalation)', () => {
  it('escalates immediately for structural out-of-scope (matches another role scope)', async () => {
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
          id: 'docsOwner',
          scope: ['docs/**'],
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
      sharedScopes: [],
      escalationChain: []
    };

    const runner = new MockRunnerAdapter({
      worker: async ({ workspacePath }) => {
        // Always attempts to touch a docs-owned file (out-of-scope for worker).
        await mkdir(join(workspacePath, 'docs'), { recursive: true });
        await writeFile(join(workspacePath, 'docs', 'a.md'), 'doc\n', 'utf8');
      },
      architect: async ({ workspacePath }) => {
        // Grant worker a narrow shared-scope exception for docs/a.md.
        const decisionPath = join(workspacePath, '.nibbler-staging', 'j-test', 'scope-exception-decision.json');
        await mkdir(join(workspacePath, '.nibbler-staging', 'j-test'), { recursive: true });
        await writeFile(
          decisionPath,
          JSON.stringify(
            {
              decision: 'grant_narrow_access',
              kind: 'shared_scope',
              ownerRoleId: 'docsOwner',
              patterns: ['docs/a.md'],
              notes: 'grant for test'
            },
            null,
            2
          ) + '\n',
          'utf8'
        );
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
    expect(out.ok).toBe(true);

    // Severity-based escalation should run Architect before consuming an extra worker retry.
    expect(runner.startedRoles.slice(0, 3)).toEqual(['worker', 'architect', 'worker']);

    const ledgerContent = await readFile(jobPaths.ledgerPath, 'utf8');
    expect(ledgerContent).toContain('"type":"scope_exception_granted"');
  });
});

