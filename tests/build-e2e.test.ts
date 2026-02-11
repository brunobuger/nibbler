import { describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';

import { runBuildCommand } from '../src/cli/commands/build.js';
import { initWorkspace } from '../src/workspace/layout.js';
import { createTempGitRepo } from './git-fixture.js';
import { MockRunnerAdapter } from './mock-runner.js';

async function setupContract(repoRoot: string, overrides?: { globalMaxTimeMs?: number; workerMaxIterations?: number; includePlanGate?: boolean }) {
  await initWorkspace(repoRoot);

  await writeFile(join(repoRoot, '.gitignore'), '.nibbler/jobs/\n.nibbler-staging/\n.cursor/rules/20-role-*.mdc\n', 'utf8');

  const contractDir = join(repoRoot, '.nibbler', 'contract');
  await mkdir(contractDir, { recursive: true });

  const globalMaxTimeMs = overrides?.globalMaxTimeMs ?? 60_000;
  const workerMaxIterations = overrides?.workerMaxIterations ?? 2;
  const includePlanGate = overrides?.includePlanGate ?? true;

  await writeFile(
    join(contractDir, 'team.yaml'),
    `roles:
  - id: architect
    scope: ["vision.md", "architecture.md", ".nibbler-staging/**"]
    authority: { allowedCommands: [], allowedPaths: [] }
    outputExpectations: []
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 3, exhaustionEscalation: "terminate" }
  - id: worker
    scope: ["src/**"]
    authority: { allowedCommands: [], allowedPaths: [] }
    outputExpectations: []
    verificationMethod: { kind: "none" }
    budget: { maxIterations: ${workerMaxIterations}, exhaustionEscalation: "architect" }
sharedScopes: []
escalationChain: []
`,
    'utf8'
  );

  const gatesYaml = includePlanGate
    ? `gates:
  - id: plan
    trigger: "planning->execution"
    audience: "PO"
    approvalScope: "build_requirements"
    approvalExpectations:
      - "Approve product requirements and execution scope."
    businessOutcomes:
      - "PO confirms delivery outcomes before execution."
    functionalScope:
      - "Planning artifacts map approved functionality to execution."
    outOfScope:
      - "Anything not in approved planning artifacts."
    requiredInputs:
      - { name: "vision", kind: "path", value: "vision.md" }
      - { name: "architecture", kind: "path", value: "architecture.md" }
      - { name: "acceptance", kind: "path", value: ".nibbler/jobs/<id>/plan/acceptance.md" }
    outcomes: { approve: "execution", reject: "planning" }
`
    : `gates: []\n`;

  await writeFile(
    join(contractDir, 'phases.yaml'),
    `phases:
  - id: planning
    actors: ["architect"]
    inputBoundaries: ["vision.md", "architecture.md"]
    outputBoundaries: [".nibbler/jobs/<id>/plan/**"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "artifact_exists", pattern: ".nibbler/jobs/<id>/plan/acceptance.md" }
    successors: [{ on: "done", next: "execution" }]
  - id: execution
    actors: ["worker"]
    inputBoundaries: ["src/**"]
    outputBoundaries: ["src/**"]
    preconditions: [{ type: "always" }]
    completionCriteria: [{ type: "diff_non_empty" }]
    successors: []
    isTerminal: true
${gatesYaml}
globalLifetime:
  maxTimeMs: ${globalMaxTimeMs}
`,
    'utf8'
  );

  // Build now requires vision.md + architecture.md to exist before running.
  await writeFile(join(repoRoot, 'vision.md'), '# vision\n', 'utf8');
  await writeFile(join(repoRoot, 'architecture.md'), '# arch\n', 'utf8');

  await execa('git', ['add', '-A'], { cwd: repoRoot });
  await execa('git', ['commit', '-m', 'setup contract'], { cwd: repoRoot });
}

async function setupContractWithShip(repoRoot: string, overrides?: { globalMaxTimeMs?: number }): Promise<void> {
  await initWorkspace(repoRoot);
  await writeFile(join(repoRoot, '.gitignore'), '.nibbler/jobs/\n.nibbler-staging/\n.cursor/rules/20-role-*.mdc\n', 'utf8');

  const contractDir = join(repoRoot, '.nibbler', 'contract');
  await mkdir(contractDir, { recursive: true });

  const globalMaxTimeMs = overrides?.globalMaxTimeMs ?? 60_000;

  await writeFile(
    join(contractDir, 'team.yaml'),
    `roles:
  - id: architect
    scope: ["vision.md", "architecture.md", ".nibbler-staging/**"]
    authority: { allowedCommands: [], allowedPaths: [] }
    outputExpectations: []
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 3, exhaustionEscalation: "terminate" }
  - id: worker
    scope: ["src/**"]
    authority: { allowedCommands: [], allowedPaths: [] }
    outputExpectations: []
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "architect" }
  - id: docs
    scope: ["README.md"]
    authority: { allowedCommands: [], allowedPaths: [] }
    outputExpectations: []
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 2, exhaustionEscalation: "architect" }
sharedScopes: []
escalationChain: []
`,
    'utf8'
  );

  await writeFile(
    join(contractDir, 'phases.yaml'),
    `phases:
  - id: planning
    actors: ["architect"]
    inputBoundaries: ["vision.md", "architecture.md"]
    outputBoundaries: [".nibbler/jobs/<id>/plan/**"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "artifact_exists", pattern: ".nibbler/jobs/<id>/plan/acceptance.md" }
    successors: [{ on: "done", next: "execution" }]
  - id: execution
    actors: ["worker"]
    inputBoundaries: ["src/**"]
    outputBoundaries: ["src/**"]
    preconditions: [{ type: "always" }]
    completionCriteria: [{ type: "diff_non_empty" }]
    successors: [{ on: "done", next: "ship" }]
  - id: ship
    actors: ["docs"]
    inputBoundaries: ["**/*"]
    outputBoundaries: ["README.md"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "artifact_exists", pattern: "README.md" }
      - { type: "markdown_has_headings", path: "README.md", requiredHeadings: ["Install", "Quickstart", "Commands"], minChars: 200 }
    successors: []
    isTerminal: true
gates:
  - id: plan
    trigger: "planning->execution"
    audience: "PO"
    approvalScope: "build_requirements"
    approvalExpectations:
      - "Approve product requirements and execution scope."
    businessOutcomes:
      - "PO confirms delivery outcomes before execution."
    functionalScope:
      - "Planning artifacts map approved functionality to execution."
    outOfScope:
      - "Anything not in approved planning artifacts."
    requiredInputs:
      - { name: "vision", kind: "path", value: "vision.md" }
      - { name: "architecture", kind: "path", value: "architecture.md" }
      - { name: "acceptance", kind: "path", value: ".nibbler/jobs/<id>/plan/acceptance.md" }
    outcomes: { approve: "execution", reject: "planning" }
  - id: ship
    trigger: "ship->__END__"
    audience: "PO"
    approvalScope: "phase_output"
    approvalExpectations:
      - "Approve ship outputs for release."
    businessOutcomes:
      - "Release readiness confirmed."
    functionalScope:
      - "Final README/docs meet ship expectations."
    outOfScope:
      - "No additional implementation scope."
    requiredInputs:
      - { name: "readme", kind: "path", value: "README.md" }
    outcomes: { approve: "__END__", reject: "ship" }
globalLifetime:
  maxTimeMs: ${globalMaxTimeMs}
`,
    'utf8'
  );

  // Build requires vision.md + architecture.md to exist before running.
  await writeFile(join(repoRoot, 'vision.md'), '# vision\n', 'utf8');
  await writeFile(join(repoRoot, 'architecture.md'), '# arch\n', 'utf8');

  await execa('git', ['add', '-A'], { cwd: repoRoot });
  await execa('git', ['commit', '-m', 'setup contract'], { cwd: repoRoot });
}

async function detectJobId(repoRoot: string): Promise<string> {
  const jobsDir = join(repoRoot, '.nibbler', 'jobs');
  const entries = await readdir(jobsDir);
  const job = entries.find((e) => e.startsWith('j-'));
  if (!job) throw new Error('job id not found');
  return job;
}

describe('nibbler build (e2e, mocked)', () => {
  it('happy path: planning -> execution', async () => {
    const { dir: repoRoot } = await createTempGitRepo();
    await setupContract(repoRoot);

    const baseBranch = (await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })).stdout.trim();

    const runner = new MockRunnerAdapter({
      architect: async ({ workspacePath }) => {
        const jobId = await detectJobId(repoRoot);
        const staged = join(workspacePath, '.nibbler-staging', 'plan', jobId);
        await mkdir(staged, { recursive: true });
        await writeFile(join(staged, 'acceptance.md'), '# acceptance\n', 'utf8');
        await writeFile(
          join(staged, 'delegation.yaml'),
          `version: 1
tasks:
  - taskId: t1
    roleId: worker
    description: implement x
    scopeHints: ["src/**"]
    priority: 1
`,
          'utf8'
        );
      },
      worker: async ({ workspacePath, mode }) => {
        const jobId = await detectJobId(repoRoot);
        if (mode === 'plan') {
          const planDir = join(workspacePath, '.nibbler-staging', jobId, 'plans');
          await mkdir(planDir, { recursive: true });
          await writeFile(join(planDir, 'worker-plan.md'), '# worker plan\n', 'utf8');
          return;
        }
        // Best-effort handoff
        const handoffDir = join(workspacePath, '.nibbler-staging', jobId, 'handoffs');
        await mkdir(handoffDir, { recursive: true });
        await writeFile(join(handoffDir, 'worker-execution.md'), '## Summary\n- implemented x\n', 'utf8');
        await mkdir(join(workspacePath, 'src'), { recursive: true });
        await writeFile(join(workspacePath, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');
      }
    });

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      const res = await runBuildCommand({ repoRoot, runner, requirement: 'do thing' });
      expect(res.ok).toBe(true);
      expect(res.jobId).toMatch(/^j-\d{8}-\d{3}$/);

      const branch = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
      expect(branch.stdout.trim()).toBe(baseBranch);

      // Work must land on the user's branch after merge-back.
      const srcFile = await readFile(join(repoRoot, 'src', 'x.ts'), 'utf8');
      expect(srcFile).toContain('export const x');

      const planFile = join(repoRoot, '.nibbler', 'jobs', res.jobId!, 'plan', 'acceptance.md');
      const plan = await readFile(planFile, 'utf8');
      expect(plan).toContain('acceptance');

      const handoff = await readFile(
        join(repoRoot, '.nibbler', 'jobs', res.jobId!, 'plan', 'handoffs', 'worker-execution.md'),
        'utf8'
      );
      expect(handoff).toContain('implemented x');
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }
  });

  it('ship phase produces README and ship gate runs at end', async () => {
    const { dir: repoRoot } = await createTempGitRepo();
    await setupContractWithShip(repoRoot);

    const runner = new MockRunnerAdapter({
      architect: async ({ workspacePath }) => {
        const jobId = await detectJobId(repoRoot);
        const staged = join(workspacePath, '.nibbler-staging', 'plan', jobId);
        await mkdir(staged, { recursive: true });
        await writeFile(join(staged, 'acceptance.md'), '# acceptance\n', 'utf8');
        await writeFile(
          join(staged, 'delegation.yaml'),
          `version: 1
tasks:
  - taskId: t1
    roleId: worker
    description: implement x
    scopeHints: ["src/**"]
    priority: 1
`,
          'utf8'
        );
      },
      worker: async ({ workspacePath, mode }) => {
        const jobId = await detectJobId(repoRoot);
        if (mode === 'plan') {
          const planDir = join(workspacePath, '.nibbler-staging', jobId, 'plans');
          await mkdir(planDir, { recursive: true });
          await writeFile(join(planDir, 'worker-plan.md'), '# worker plan\n', 'utf8');
          return;
        }
        await mkdir(join(workspacePath, 'src'), { recursive: true });
        await writeFile(join(workspacePath, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');
      },
      docs: async ({ workspacePath }) => {
        const jobId = await detectJobId(repoRoot);
        const body = Array.from({ length: 40 }, () => 'This is documentation filler for deterministic minChars.\n').join('');
        const readme = [
          '# Project',
          '',
          '## Install',
          '```bash',
          'npm install',
          '```',
          '',
          '## Quickstart',
          '```bash',
          'npm run dev -- --help',
          '```',
          '',
          '## Commands',
          '- `nibbler init`',
          '- `nibbler build`',
          '',
          body,
        ].join('\n');
        await writeFile(join(workspacePath, 'README.md'), readme, 'utf8');

        // Best-effort handoff
        const handoffDir = join(workspacePath, '.nibbler-staging', jobId, 'handoffs');
        await mkdir(handoffDir, { recursive: true });
        await writeFile(join(handoffDir, 'docs-ship.md'), '## Summary\n- updated README\n', 'utf8');
      }
    });

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      const res = await runBuildCommand({ repoRoot, runner, requirement: 'do thing' });
      expect(res.ok).toBe(true);
      expect(res.jobId).toMatch(/^j-\d{8}-\d{3}$/);

      const readme = await readFile(join(repoRoot, 'README.md'), 'utf8');
      expect(readme).toContain('## Install');
      expect(readme).toContain('## Quickstart');
      expect(readme).toContain('## Commands');

      const ledgerPath = join(repoRoot, '.nibbler', 'jobs', res.jobId!, 'ledger.jsonl');
      const ledger = await readFile(ledgerPath, 'utf8');
      expect(ledger).toContain('"type":"gate_presented"');
      expect(ledger).toContain('"gateId":"ship"');
      expect(ledger).toContain('"type":"gate_resolved"');

      const handoff = await readFile(
        join(repoRoot, '.nibbler', 'jobs', res.jobId!, 'plan', 'handoffs', 'docs-ship.md'),
        'utf8'
      );
      expect(handoff).toContain('updated README');
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }
  });

  it('scope violation + retry: worker out-of-scope then succeeds', async () => {
    const { dir: repoRoot } = await createTempGitRepo();
    await setupContract(repoRoot, { workerMaxIterations: 2 });

    const runner = new MockRunnerAdapter({
      architect: async ({ workspacePath }) => {
        const jobId = await detectJobId(repoRoot);
        const staged = join(workspacePath, '.nibbler-staging', 'plan', jobId);
        await mkdir(staged, { recursive: true });
        await writeFile(join(staged, 'acceptance.md'), '# acceptance\n', 'utf8');
        await writeFile(
          join(staged, 'delegation.yaml'),
          `version: 1
tasks:
  - taskId: t1
    roleId: worker
    description: implement ok
    scopeHints: ["src/**"]
    priority: 1
`,
          'utf8'
        );
      },
      worker: async ({ workspacePath, attempt, mode }) => {
        const jobId = await detectJobId(repoRoot);
        if (mode === 'plan') {
          const planDir = join(workspacePath, '.nibbler-staging', jobId, 'plans');
          await mkdir(planDir, { recursive: true });
          await writeFile(join(planDir, 'worker-plan.md'), `# worker plan attempt=${attempt}\n`, 'utf8');
          return;
        }
        if (attempt === 1) {
          await writeFile(join(workspacePath, 'README-out-of-scope.md'), 'nope\n', 'utf8');
          return;
        }
        await mkdir(join(workspacePath, 'src'), { recursive: true });
        await writeFile(join(workspacePath, 'src', 'ok.ts'), 'export const ok = true;\n', 'utf8');
      }
    });

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      const res = await runBuildCommand({ repoRoot, runner, requirement: 'do thing' });
      expect(res.ok).toBe(true);

      const ledgerPath = join(repoRoot, '.nibbler', 'jobs', res.jobId!, 'ledger.jsonl');
      const ledger = await readFile(ledgerPath, 'utf8');
      expect((ledger.match(/"type":"session_reverted"/g) ?? []).length).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }
  });

  it('budget exhaustion escalates (worker fails repeatedly)', async () => {
    const { dir: repoRoot } = await createTempGitRepo();
    await setupContract(repoRoot, { workerMaxIterations: 1 });

    const runner = new MockRunnerAdapter({
      architect: async ({ workspacePath }) => {
        const jobId = await detectJobId(repoRoot);
        const staged = join(workspacePath, '.nibbler-staging', 'plan', jobId);
        await mkdir(staged, { recursive: true });
        await writeFile(join(staged, 'acceptance.md'), '# acceptance\n', 'utf8');
        await writeFile(
          join(staged, 'delegation.yaml'),
          `version: 1
tasks:
  - taskId: t1
    roleId: worker
    description: implement failing change
    scopeHints: ["src/**"]
    priority: 1
`,
          'utf8'
        );
      },
      worker: async ({ workspacePath, mode }) => {
        const jobId = await detectJobId(repoRoot);
        if (mode === 'plan') {
          const planDir = join(workspacePath, '.nibbler-staging', jobId, 'plans');
          await mkdir(planDir, { recursive: true });
          await writeFile(join(planDir, 'worker-plan.md'), '# worker plan\n', 'utf8');
          return;
        }
        await writeFile(join(workspacePath, 'OUT_OF_SCOPE.md'), 'nope\n', 'utf8');
      }
    });

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      const res = await runBuildCommand({ repoRoot, runner, requirement: 'do thing' });
      expect(res.ok).toBe(false);
      const details = res.details as any;
      expect(details?.reason).toBe('escalated');
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }
  });

  it('gate rejection follows outcome (reject once then approve)', async () => {
    const { dir: repoRoot } = await createTempGitRepo();
    await setupContract(repoRoot, { includePlanGate: true });

    const runner = new MockRunnerAdapter({
      architect: async ({ workspacePath, attempt }) => {
        const jobId = await detectJobId(repoRoot);
        const staged = join(workspacePath, '.nibbler-staging', 'plan', jobId);
        await mkdir(staged, { recursive: true });
        await writeFile(join(staged, 'acceptance.md'), `# acceptance attempt=${attempt}\n`, 'utf8');
        await writeFile(
          join(staged, 'delegation.yaml'),
          `version: 1
tasks:
  - taskId: t1
    roleId: worker
    description: implement x
    scopeHints: ["src/**"]
    priority: 1
`,
          'utf8'
        );
      },
      worker: async ({ workspacePath, mode }) => {
        const jobId = await detectJobId(repoRoot);
        if (mode === 'plan') {
          const planDir = join(workspacePath, '.nibbler-staging', jobId, 'plans');
          await mkdir(planDir, { recursive: true });
          await writeFile(join(planDir, 'worker-plan.md'), '# worker plan\n', 'utf8');
          return;
        }
        await mkdir(join(workspacePath, 'src'), { recursive: true });
        await writeFile(join(workspacePath, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');
      }
    });

    process.env.NIBBLER_TEST_DISCOVERY_AUTO = '1';
    process.env.NIBBLER_TEST_GATE_DECISION = 'reject_once';
    try {
      const res = await runBuildCommand({ repoRoot, runner, requirement: 'do thing' });
      expect(res.ok).toBe(true);
    } finally {
      delete process.env.NIBBLER_TEST_DISCOVERY_AUTO;
      delete process.env.NIBBLER_TEST_GATE_DECISION;
    }
  });

  it('global budget exceeded terminates the job', async () => {
    const { dir: repoRoot } = await createTempGitRepo();
    await setupContract(repoRoot, { globalMaxTimeMs: 1 });

    const runner = new MockRunnerAdapter({
      architect: async ({ workspacePath }) => {
        const jobId = await detectJobId(repoRoot);
        const staged = join(workspacePath, '.nibbler-staging', 'plan', jobId);
        await mkdir(staged, { recursive: true });
        await writeFile(join(staged, 'acceptance.md'), '# acceptance\n', 'utf8');
        await writeFile(
          join(staged, 'delegation.yaml'),
          `version: 1
tasks:
  - taskId: t1
    roleId: worker
    description: implement x
    scopeHints: ["src/**"]
    priority: 1
`,
          'utf8'
        );
      },
      worker: async ({ workspacePath }) => {
        await writeFile(join(workspacePath, 'OUT_OF_SCOPE.md'), 'nope\n', 'utf8');
      },
    });

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    const startedAtIso = new Date(Date.now() - 10_000).toISOString();
    try {
      const res = await runBuildCommand({ repoRoot, runner, requirement: 'do thing', startedAtIso });
      expect(res.ok).toBe(false);
      const details = res.details as any;
      expect(details?.reason).toBe('budget_exceeded');
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }
  });

  it('treats cancelled latest job as recoverable for build resume path', async () => {
    const { dir: repoRoot } = await createTempGitRepo();
    await setupContract(repoRoot, { includePlanGate: false });

    const cancelledJobId = 'j-20990101-001';
    const jobDir = join(repoRoot, '.nibbler', 'jobs', cancelledJobId);
    await mkdir(jobDir, { recursive: true });
    const nowIso = new Date().toISOString();
    await writeFile(
      join(jobDir, 'status.json'),
      JSON.stringify(
        {
          version: 1,
          job_id: cancelledJobId,
          repo_root: repoRoot,
          mode: 'build',
          description: 'do thing',
          state: 'cancelled',
          current_phase: 'execution',
          current_phase_actor_index: 0,
          pending_gate_id: null,
          current_role: 'worker',
          session_active: false,
          session: null,
          started_at: nowIso,
          updated_at: nowIso,
          budget: {
            global: { limit_ms: 60_000, elapsed_ms: 0 },
            current_role: { iterations: { limit: 2, used: 0 } }
          },
          progress: {
            roles_completed: ['architect'],
            roles_remaining: ['worker']
          },
          git: {
            pre_session_commit: null,
            last_diff_summary: null
          }
        },
        null,
        2
      ),
      'utf8'
    );
    await writeFile(join(jobDir, 'ledger.jsonl'), '', 'utf8');

    const runner = new MockRunnerAdapter({
      worker: async ({ workspacePath }) => {
        await mkdir(join(workspacePath, 'src'), { recursive: true });
        await writeFile(join(workspacePath, 'src', 'resumed.ts'), 'export const resumed = true;\n', 'utf8');
      }
    });

    const prevQuiet = process.env.NIBBLER_QUIET;
    const prevVitest = process.env.VITEST;
    const prevVitestWorker = process.env.VITEST_WORKER_ID;
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NIBBLER_QUIET = '1';
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    process.env.NODE_ENV = 'development';

    try {
      const res = await runBuildCommand({ repoRoot, runner, requirement: 'do thing' });
      expect(res.ok).toBe(true);
      expect(res.jobId).toBe(cancelledJobId);

      const resumedFile = await readFile(join(repoRoot, 'src', 'resumed.ts'), 'utf8');
      expect(resumedFile).toContain('resumed');

      const teamContract = await readFile(join(repoRoot, '.nibbler', 'contract', 'team.yaml'), 'utf8');
      expect(teamContract).toContain('roles:');

      const jobs = (await readdir(join(repoRoot, '.nibbler', 'jobs'))).filter((e) => e.startsWith('j-'));
      expect(jobs).toEqual([cancelledJobId]);
    } finally {
      if (prevQuiet === undefined) delete process.env.NIBBLER_QUIET;
      else process.env.NIBBLER_QUIET = prevQuiet;
      if (prevVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = prevVitest;
      if (prevVitestWorker === undefined) delete process.env.VITEST_WORKER_ID;
      else process.env.VITEST_WORKER_ID = prevVitestWorker;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });
});

