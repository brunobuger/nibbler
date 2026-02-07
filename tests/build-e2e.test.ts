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
    requiredInputs:
      - { name: "acceptance", kind: "path", value: ".nibbler/jobs/<id>/plan/acceptance.md" }
    outcomes: { approve: "execution", reject: "planning" }
`
    : `gates: []\n`;

  await writeFile(
    join(contractDir, 'phases.yaml'),
    `phases:
  - id: discovery
    actors: ["architect"]
    inputBoundaries: ["**/*"]
    outputBoundaries: ["vision.md", "architecture.md"]
    preconditions: [{ type: "always" }]
    completionCriteria:
      - { type: "artifact_exists", pattern: "vision.md" }
      - { type: "artifact_exists", pattern: "architecture.md" }
    successors: [{ on: "done", next: "planning" }]
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
  it('happy path: discovery -> planning -> execution', async () => {
    const { dir: repoRoot } = await createTempGitRepo();
    await setupContract(repoRoot);

    const runner = new MockRunnerAdapter({
      architect: async ({ workspacePath, attempt }) => {
        if (attempt === 1) {
          await writeFile(join(workspacePath, 'vision.md'), '# vision\n', 'utf8');
          await writeFile(join(workspacePath, 'architecture.md'), '# arch\n', 'utf8');
          return;
        }
        const jobId = await detectJobId(workspacePath);
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
        const jobId = await detectJobId(workspacePath);
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

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      const res = await runBuildCommand({ repoRoot, runner, requirement: 'do thing' });
      expect(res.ok).toBe(true);
      expect(res.jobId).toMatch(/^j-\d{8}-\d{3}$/);

      const branch = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
      expect(branch.stdout.trim()).toBe(`nibbler/job-${res.jobId}`);

      const planFile = join(repoRoot, '.nibbler', 'jobs', res.jobId!, 'plan', 'acceptance.md');
      const plan = await readFile(planFile, 'utf8');
      expect(plan).toContain('acceptance');
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }
  });

  it('scope violation + retry: worker out-of-scope then succeeds', async () => {
    const { dir: repoRoot } = await createTempGitRepo();
    await setupContract(repoRoot, { workerMaxIterations: 2 });

    const runner = new MockRunnerAdapter({
      architect: async ({ workspacePath, attempt }) => {
        if (attempt === 1) {
          await writeFile(join(workspacePath, 'vision.md'), '# vision\n', 'utf8');
          await writeFile(join(workspacePath, 'architecture.md'), '# arch\n', 'utf8');
          return;
        }
        const jobId = await detectJobId(workspacePath);
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
        const jobId = await detectJobId(workspacePath);
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
      architect: async ({ workspacePath, attempt }) => {
        if (attempt === 1) {
          await writeFile(join(workspacePath, 'vision.md'), '# vision\n', 'utf8');
          await writeFile(join(workspacePath, 'architecture.md'), '# arch\n', 'utf8');
          return;
        }
        const jobId = await detectJobId(workspacePath);
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
        const jobId = await detectJobId(workspacePath);
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
        if (attempt === 1) {
          await writeFile(join(workspacePath, 'vision.md'), '# vision\n', 'utf8');
          await writeFile(join(workspacePath, 'architecture.md'), '# arch\n', 'utf8');
          return;
        }
        const jobId = await detectJobId(workspacePath);
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
        const jobId = await detectJobId(workspacePath);
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
        await writeFile(join(workspacePath, 'vision.md'), '# vision\n', 'utf8');
        await writeFile(join(workspacePath, 'architecture.md'), '# arch\n', 'utf8');
      }
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
});

