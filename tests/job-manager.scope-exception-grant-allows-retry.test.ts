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

describe('JobManager (scope exception grant)', () => {
  it('applies a granted scope exception so the next attempt can pass scope verification', async () => {
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
          id: 'execution',
          actors: ['worker'],
          inputBoundaries: ['src/**', 'docs/**'],
          outputBoundaries: ['src/**', 'docs/**'],
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
      worker: async ({ workspacePath, attempt, mode, message }) => {
        if (mode === 'plan') {
          // Delegated execution requires role-local implementation plan materialization first.
          const planDir = join(workspacePath, '.nibbler-staging', 'j-test', 'plans');
          await mkdir(planDir, { recursive: true });
          await writeFile(join(planDir, 'worker-plan.md'), '# worker plan\n', 'utf8');
          return;
        }
        // Attempt 1: touch out-of-scope docs file.
        // Attempt 2+: same file should be accepted after grant.
        if (attempt >= 2) retryPrompt = message;
        await mkdir(join(workspacePath, 'docs'), { recursive: true });
        await writeFile(join(workspacePath, 'docs', 'granted.md'), `doc attempt=${attempt}\n`, 'utf8');
      },
      architect: async ({ workspacePath }) => {
        const decisionDir = join(workspacePath, '.nibbler-staging', 'j-test');
        await mkdir(decisionDir, { recursive: true });
        await writeFile(
          join(decisionDir, 'scope-exception-decision.json'),
          JSON.stringify(
            {
              decision: 'grant_narrow_access',
              kind: 'shared_scope',
              ownerRoleId: 'docsOwner',
              patterns: ['docs/granted.md'],
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
      currentPhaseId: 'execution',
      mode: 'build' as const,
      startedAtIso: new Date().toISOString(),
      statusPath: jobPaths.statusPath,
      delegationPlan: {
        version: 1,
        tasks: [
          {
            taskId: 't1',
            roleId: 'worker',
            description: 'Write docs marker',
            scopeHints: ['docs/granted.md'],
            dependsOn: [],
            priority: 1
          }
        ]
      }
    };

    const out = await jm.runContractJob(job as any, contract);
    expect(out.ok).toBe(true);
    expect(runner.startedRoles).toContain('architect');

    const ledgerContent = await readFile(jobPaths.ledgerPath, 'utf8');
    expect((ledgerContent.match(/"type":"scope_exception_granted"/g) ?? []).length).toBe(1);
    expect((ledgerContent.match(/"type":"session_feedback"/g) ?? []).length).toBe(1);
    expect(retryPrompt).toContain('## Retry feedback from engine (highest priority)');
    expect(retryPrompt).toContain('Architect granted narrow scope access for: `docs/granted.md`.');
    expect(retryPrompt).not.toContain('HARD blocklist for this retry: do NOT edit `docs/granted.md`.');
  });
});

