import { describe, expect, it } from 'vitest';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';

import { createTempGitRepo } from './git-fixture.js';
import { MockRunnerAdapter } from './mock-runner.js';
import { runBuildCommand } from '../src/cli/commands/build.js';
import { runFixCommand } from '../src/cli/commands/fix.js';
import { runStatusCommand } from '../src/cli/commands/status.js';
import { runHistoryCommand } from '../src/cli/commands/history.js';
import { runResumeCommand } from '../src/cli/commands/resume.js';
import { initWorkspace } from '../src/workspace/layout.js';

async function setupMinimalContract(repoRoot: string) {
  await initWorkspace(repoRoot);
  await writeFile(join(repoRoot, '.gitignore'), '.nibbler/jobs/\n.nibbler-staging/\n.cursor/rules/20-role-*.mdc\n', 'utf8');

  const contractDir = join(repoRoot, '.nibbler', 'contract');
  await mkdir(contractDir, { recursive: true });

  await writeFile(
    join(contractDir, 'team.yaml'),
    `roles:
  - id: architect
    scope: ["vision.md", "architecture.md", ".nibbler-staging/**", "src/**"]
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
    successors: []
    isTerminal: true
gates: []
globalLifetime:
  maxTimeMs: 60000
`,
    'utf8'
  );

  // Build now requires vision.md + architecture.md to exist before running.
  await writeFile(join(repoRoot, 'vision.md'), '# vision\n', 'utf8');
  await writeFile(join(repoRoot, 'architecture.md'), '# arch\n', 'utf8');

  await execa('git', ['add', '-A'], { cwd: repoRoot });
  await execa('git', ['commit', '-m', 'setup contract'], { cwd: repoRoot });
}

function captureStderr<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  const orig = process.stderr.write;
  let out = '';
  (process.stderr as any).write = (chunk: any) => {
    out += String(chunk);
    return true;
  };
  return fn()
    .then((result) => ({ out, result }))
    .finally(() => {
      (process.stderr as any).write = orig;
    });
}

describe('CLI commands (mocked runner)', () => {
  it('status + history work after a completed build job', async () => {
    const { dir: repoRoot } = await createTempGitRepo();
    await setupMinimalContract(repoRoot);

    const runner = new MockRunnerAdapter({
      architect: async ({ workspacePath }) => {
        const jobsDir = join(repoRoot, '.nibbler', 'jobs');
        const entries = await (await import('node:fs/promises')).readdir(jobsDir);
        const jobId = entries.find((e) => e.startsWith('j-'))!;
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
        const jobsDir = join(repoRoot, '.nibbler', 'jobs');
        const entries = await (await import('node:fs/promises')).readdir(jobsDir);
        const jobId = entries.find((e) => e.startsWith('j-'))!;
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
      const build = await runBuildCommand({ repoRoot, runner, requirement: 'do thing' });
      expect(build.ok).toBe(true);
      const jobId = build.jobId!;

      const status = await captureStderr(() => runStatusCommand({ repoRoot, jobId }));
      expect(status.result.ok).toBe(true);
      expect(status.out).toContain(`Job ${jobId}`);

      const history = await captureStderr(() => runHistoryCommand({ repoRoot }));
      expect(history.result.ok).toBe(true);
      expect(history.out).toContain(jobId);
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }
  });

  it('fix runs on top of an existing job', async () => {
    const { dir: repoRoot } = await createTempGitRepo();
    await setupMinimalContract(repoRoot);

    const runner = new MockRunnerAdapter({
      architect: async ({ workspacePath }) => {
        const jobsDir = join(repoRoot, '.nibbler', 'jobs');
        const entries = (await (await import('node:fs/promises')).readdir(jobsDir))
          .filter((e) => e.startsWith('j-'))
          .sort((a, b) => a.localeCompare(b));
        const jobId = entries[entries.length - 1]!;

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
        const jobsDir = join(repoRoot, '.nibbler', 'jobs');
        const entries = (await (await import('node:fs/promises')).readdir(jobsDir))
          .filter((e) => e.startsWith('j-'))
          .sort((a, b) => a.localeCompare(b));
        const jobId = entries[entries.length - 1]!;

        if (mode === 'plan') {
          const planDir = join(workspacePath, '.nibbler-staging', jobId, 'plans');
          await mkdir(planDir, { recursive: true });
          await writeFile(join(planDir, 'worker-plan.md'), '# worker plan\n', 'utf8');
          return;
        }

        await mkdir(join(workspacePath, 'src'), { recursive: true });
        const p = join(workspacePath, 'src', 'x.ts');
        const current = await readFile(p, 'utf8').catch(() => '');
        if (current.includes('export const x = 1')) {
          await writeFile(p, 'export const x = 2;\n', 'utf8');
        } else if (!current.trim()) {
          await writeFile(p, 'export const x = 1;\n', 'utf8');
        } else {
          // Leave as-is for idempotence.
        }
      }
    });

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      const build = await runBuildCommand({ repoRoot, runner, requirement: 'do thing' });
      expect(build.ok).toBe(true);

      const fix = await runFixCommand({ repoRoot, runner, job: build.jobId!, instructions: 'Change x to 2' });
      expect(fix.ok).toBe(true);

      const updated = await readFile(join(repoRoot, 'src', 'x.ts'), 'utf8');
      expect(updated).toContain('export const x = 2');
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }
  });

  it('resume restarts orchestration from persisted checkpoint', async () => {
    const { dir: repoRoot } = await createTempGitRepo();
    await initWorkspace(repoRoot);
    await writeFile(join(repoRoot, '.gitignore'), '.nibbler/jobs/\n.nibbler-staging/\n.cursor/rules/20-role-*.mdc\n', 'utf8');

    // Minimal contract: execution only.
    const contractDir = join(repoRoot, '.nibbler', 'contract');
    await mkdir(contractDir, { recursive: true });
    await writeFile(
      join(contractDir, 'team.yaml'),
      `roles:
  - id: worker
    scope: ["src/**"]
    authority: { allowedCommands: [], allowedPaths: [] }
    outputExpectations: []
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 1, exhaustionEscalation: "terminate" }
sharedScopes: []
escalationChain: []
`,
      'utf8'
    );
    await writeFile(
      join(contractDir, 'phases.yaml'),
      `phases:
  - id: execution
    actors: ["worker"]
    inputBoundaries: ["src/**"]
    outputBoundaries: ["src/**"]
    preconditions: [{ type: "always" }]
    completionCriteria: [{ type: "diff_non_empty" }]
    successors: []
    isTerminal: true
gates: []
globalLifetime:
  maxTimeMs: 60000
`,
      'utf8'
    );
    await execa('git', ['add', '-A'], { cwd: repoRoot });
    await execa('git', ['commit', '-m', 'setup contract'], { cwd: repoRoot });

    // Create a fake job status checkpoint (engine not running).
    const jobId = 'j-test-resume';
    const jobDir = join(repoRoot, '.nibbler', 'jobs', jobId);
    await mkdir(join(jobDir, 'evidence'), { recursive: true });
    await writeFile(
      join(jobDir, 'status.json'),
      JSON.stringify(
        {
          version: 1,
          job_id: jobId,
          repo_root: repoRoot,
          mode: 'resume',
          description: 'resume-test',
          state: 'executing',
          current_phase: 'execution',
          current_phase_actor_index: 0,
          pending_gate_id: null,
          current_role: 'worker',
          session_active: false,
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          budget: { global: { elapsed_ms: 0, limit_ms: 60000 }, current_role: { iterations: { used: 0, limit: 1 } } },
          progress: { roles_completed: [], roles_remaining: ['worker'] },
          session: null
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    await writeFile(join(jobDir, 'ledger.jsonl'), '', 'utf8');

    const runner = new MockRunnerAdapter({
      worker: async ({ workspacePath }) => {
        await mkdir(join(workspacePath, 'src'), { recursive: true });
        await writeFile(join(workspacePath, 'src', 'resumed.ts'), 'export const resumed = true;\n', 'utf8');
      }
    });

    const out = await runResumeCommand({ repoRoot, jobId, runner });
    expect(out.ok).toBe(true);
  });
});

