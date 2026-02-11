import { describe, expect, it } from 'vitest';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';

import type { Contract, GateDefinition } from '../src/core/contract/types.js';
import { EvidenceCollector } from '../src/core/evidence/collector.js';
import { GateController } from '../src/core/gate/controller.js';
import { JobManager } from '../src/core/job-manager.js';
import { LedgerWriter } from '../src/core/ledger/writer.js';
import { computeGateFingerprint } from '../src/core/gate/fingerprint.js';
import { SessionController } from '../src/core/session/controller.js';
import { initJob, initWorkspace } from '../src/workspace/layout.js';
import { createTempGitRepo } from './git-fixture.js';
import { MockRunnerAdapter } from './mock-runner.js';

describe('JobManager (gate dedupe)', () => {
  it('does not re-prompt an approved planning gate if planning artifacts are unchanged', async () => {
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

    let planningRuns = 0;
    let scaffoldRuns = 0;
    const runner = new MockRunnerAdapter({
      architect: async ({ workspacePath, mode }) => {
        if (mode === 'plan') {
          planningRuns += 1;
          const version = planningRuns >= 3 ? 2 : 1; // first two planning runs are identical; third changes
          const staged = join(workspacePath, '.nibbler-staging', 'plan', 'j-test');
          await mkdir(staged, { recursive: true });
          await writeFile(join(staged, 'acceptance.md'), `# acceptance v${version}\n`, 'utf8');
          await writeFile(
            join(staged, 'delegation.yaml'),
            `version: 1\ntasks:\n  - taskId: t1\n    roleId: architect\n    description: scaffold\n    scopeHints: [\"src/**\"]\n    priority: 1\n    dependsOn: []\n`,
            'utf8'
          );
          return;
        }

        // scaffold: make an in-scope change so diff_non_empty passes.
        scaffoldRuns += 1;
        await mkdir(join(workspacePath, 'src'), { recursive: true });
        await writeFile(join(workspacePath, 'src', `scaffold-${scaffoldRuns}.ts`), `export const x = ${scaffoldRuns};\n`, 'utf8');
      }
    });
    const sessions = new SessionController(runner, repoRoot, { bootstrapPrompt: 'go', inactivityTimeoutMs: 2_000 });

    const jm = new JobManager(sessions, gates, evidence, ledger, {
      beforeVerifyCompletion: async ({ job }) => {
        if (job.currentPhaseId !== 'planning') return;
        const staged = join(repoRoot, '.nibbler-staging', 'plan', 'j-test');
        await mkdir(jobPaths.planDir, { recursive: true });
        await copyFile(join(staged, 'acceptance.md'), join(jobPaths.planDir, 'acceptance.md'));
        await copyFile(join(staged, 'delegation.yaml'), join(jobPaths.planDir, 'delegation.yaml'));
      }
    });

    const contract: Contract = {
      roles: [
        {
          id: 'architect',
          scope: ['vision.md', 'architecture.md', '.nibbler-staging/**', 'src/**'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 5, exhaustionEscalation: 'terminate' }
        }
      ],
      phases: [
        {
          id: 'planning',
          actors: ['architect'],
          inputBoundaries: ['vision.md', 'architecture.md'],
          outputBoundaries: ['.nibbler/jobs/<id>/plan/**'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'artifact_exists', pattern: '.nibbler/jobs/<id>/plan/acceptance.md' }],
          successors: [{ on: 'done', next: 'scaffold' }]
        },
        {
          id: 'scaffold',
          actors: ['architect'],
          inputBoundaries: ['src/**'],
          outputBoundaries: ['src/**'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [],
          isTerminal: true
        }
      ],
      gates: [
        {
          id: 'plan',
          trigger: 'planning->scaffold',
          audience: 'PO',
          approvalScope: 'build_requirements',
          approvalExpectations: ['Approve build requirements and scaffold plan'],
          businessOutcomes: ['PO confirms approved delivery value before scaffold'],
          functionalScope: ['Planning artifacts define concrete scaffold and execution scope'],
          outOfScope: ['Unplanned features remain excluded'],
          requiredInputs: [
            { name: 'vision', kind: 'path', value: 'vision.md' },
            { name: 'architecture', kind: 'path', value: 'architecture.md' },
          ],
          outcomes: { approve: 'scaffold', reject: 'planning' }
        }
      ],
      globalLifetime: { maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
      sharedScopes: [],
      escalationChain: []
    };

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      const job: any = {
        repoRoot,
        jobId: 'j-test',
        currentPhaseId: 'planning',
        startedAtIso: new Date().toISOString(),
        statusPath: jobPaths.statusPath
      };

      // First run: prompts and approves the plan gate.
      const out1 = await jm.runContractJob(job, contract);
      expect(out1.ok).toBe(true);
      const ledger1 = await readFile(jobPaths.ledgerPath, 'utf8');
      expect((ledger1.match(/"type":"gate_presented"/g) ?? []).length).toBe(1);

      // Second run (re-run from planning) with unchanged artifacts: should auto-apply approval (no new prompt).
      const out2 = await jm.runContractJobFromPhase(job, contract, 'planning');
      expect(out2.ok).toBe(true);
      const ledger2 = await readFile(jobPaths.ledgerPath, 'utf8');
      expect((ledger2.match(/"type":"gate_presented"/g) ?? []).length).toBe(1);

      // Third run with changed planning artifacts: should prompt again.
      const out3 = await jm.runContractJobFromPhase(job, contract, 'planning');
      expect(out3.ok).toBe(true);
      const ledger3 = await readFile(jobPaths.ledgerPath, 'utf8');
      expect((ledger3.match(/"type":"gate_presented"/g) ?? []).length).toBe(2);
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }
  });

  it('resume from paused gate auto-applies a prior approve when fingerprint matches', async () => {
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
      architect: async ({ workspacePath }) => {
        // scaffold: make an in-scope change so diff_non_empty passes.
        await mkdir(join(workspacePath, 'src'), { recursive: true });
        await writeFile(join(workspacePath, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');
      }
    });
    const sessions = new SessionController(runner, repoRoot, { bootstrapPrompt: 'go', inactivityTimeoutMs: 2_000 });

    const jm = new JobManager(sessions, gates, evidence, ledger, {
      beforeVerifyCompletion: async () => {
        // no-op for this test
      }
    });

    const contract: Contract = {
      roles: [
        {
          id: 'architect',
          scope: ['vision.md', 'architecture.md', '.nibbler-staging/**', 'src/**'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 5, exhaustionEscalation: 'terminate' }
        }
      ],
      phases: [
        {
          id: 'planning',
          actors: ['architect'],
          inputBoundaries: ['vision.md', 'architecture.md'],
          outputBoundaries: ['.nibbler/jobs/<id>/plan/**'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'artifact_exists', pattern: '.nibbler/jobs/<id>/plan/acceptance.md' }],
          successors: [{ on: 'done', next: 'scaffold' }]
        },
        {
          id: 'scaffold',
          actors: ['architect'],
          inputBoundaries: ['src/**'],
          outputBoundaries: ['src/**'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [],
          isTerminal: true
        }
      ],
      gates: [
        {
          id: 'plan',
          trigger: 'planning->scaffold',
          audience: 'PO',
          approvalScope: 'build_requirements',
          approvalExpectations: ['Approve build requirements and scaffold plan'],
          businessOutcomes: ['PO confirms approved delivery value before scaffold'],
          functionalScope: ['Planning artifacts define concrete scaffold and execution scope'],
          outOfScope: ['Unplanned features remain excluded'],
          requiredInputs: [
            { name: 'vision', kind: 'path', value: 'vision.md' },
            { name: 'architecture', kind: 'path', value: 'architecture.md' },
          ],
          outcomes: { approve: 'scaffold', reject: 'planning' }
        }
      ],
      globalLifetime: { maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
      sharedScopes: [],
      escalationChain: []
    };

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      // Seed planning artifacts (engine-managed) so the gate fingerprint is stable.
      await mkdir(jobPaths.planDir, { recursive: true });
      await writeFile(join(jobPaths.planDir, 'acceptance.md'), '# acceptance\n', 'utf8');
      await writeFile(
        join(jobPaths.planDir, 'delegation.yaml'),
        'version: 1\ntasks:\n  - taskId: t1\n    roleId: architect\n    description: scaffold\n    scopeHints: ["src/**"]\n    priority: 1\n    dependsOn: []\n',
        'utf8'
      );

      const job: any = {
        repoRoot,
        jobId: 'j-test',
        currentPhaseId: 'planning',
        startedAtIso: new Date().toISOString(),
        statusPath: jobPaths.statusPath
      };

      // Produce an approved gate resolution in the ledger without running phases.
      await gates.presentGate(contract.gates[0]!, job, contract);
      const ledger1 = await readFile(jobPaths.ledgerPath, 'utf8');
      expect((ledger1.match(/"type":"gate_presented"/g) ?? []).length).toBe(1);

      // Simulate a crash before status.json was updated: job looks paused at the gate.
      job.state = 'paused';
      job.pendingGateId = 'plan';
      job.currentPhaseId = 'planning';
      job.currentPhaseActorIndex = 999;

      const out2 = await jm.resumeContractJob(job, contract);
      expect(out2.ok).toBe(true);
      const ledger2 = await readFile(jobPaths.ledgerPath, 'utf8');
      // Should not prompt again; no additional gate_presented entries.
      expect((ledger2.match(/"type":"gate_presented"/g) ?? []).length).toBe(1);
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }
  });

  it('fingerprint changes when approval semantics change', async () => {
    const { dir: repoRoot } = await createTempGitRepo();

    const gateA: GateDefinition = {
      id: 'plan',
      trigger: 'planning->execution',
      audience: 'PO',
      approvalScope: 'build_requirements',
      approvalExpectations: ['Approve requirements v1'],
      businessOutcomes: ['Deliver outcome v1'],
      functionalScope: ['Deliver scope v1'],
      outOfScope: ['Exclude v1 extras'],
      requiredInputs: [
        { name: 'vision', kind: 'path', value: 'vision.md' },
        { name: 'architecture', kind: 'path', value: 'architecture.md' },
      ],
      outcomes: { approve: 'execution', reject: 'planning' }
    };

    const gateB: GateDefinition = {
      ...gateA,
      approvalExpectations: ['Approve requirements v2']
    };

    const contract: Contract = {
      roles: [
        {
          id: 'architect',
          scope: ['vision.md', 'architecture.md'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, exhaustionEscalation: 'terminate' }
        }
      ],
      phases: [
        {
          id: 'planning',
          actors: ['architect'],
          inputBoundaries: ['vision.md', 'architecture.md'],
          outputBoundaries: ['.nibbler/jobs/<id>/plan/**'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'artifact_exists', pattern: '.nibbler/jobs/<id>/plan/acceptance.md' }],
          successors: [{ on: 'done', next: 'execution' }]
        },
        {
          id: 'execution',
          actors: ['architect'],
          inputBoundaries: ['**/*'],
          outputBoundaries: ['**/*'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [],
          isTerminal: true
        }
      ],
      gates: [gateA],
      globalLifetime: { maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
      sharedScopes: [],
      escalationChain: []
    };

    const job: any = {
      repoRoot,
      jobId: 'j-test',
      currentPhaseId: 'planning',
      startedAtIso: new Date().toISOString()
    };

    const fpA = await computeGateFingerprint({ gateDef: gateA, job, contract });
    const fpB = await computeGateFingerprint({ gateDef: gateB, job, contract: { ...contract, gates: [gateB] } });
    expect(fpA.fingerprint).not.toBe(fpB.fingerprint);
  });
});

