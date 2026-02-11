import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execa } from 'execa';

import type { Contract } from '../src/core/contract/types.js';
import { EvidenceCollector } from '../src/core/evidence/collector.js';
import { GateController } from '../src/core/gate/controller.js';
import { JobManager } from '../src/core/job-manager.js';
import { LedgerWriter } from '../src/core/ledger/writer.js';
import { SessionController } from '../src/core/session/controller.js';
import type { RunnerAdapter } from '../src/core/session/runner.js';
import type { NibblerEvent, RunnerCapabilities, SessionHandle } from '../src/core/session/types.js';
import { initJob, initWorkspace } from '../src/workspace/layout.js';
import { createTempGitRepo } from './git-fixture.js';

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(v: T) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.values.push(v);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length) return Promise.resolve({ value: this.values.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

class ControlledRunnerAdapter implements RunnerAdapter {
  private queues = new Map<string, AsyncQueue<NibblerEvent>>();
  private alive = new Set<string>();
  private attemptsByRole = new Map<string, number>();
  readonly promptsByRole = new Map<string, string[]>();

  constructor(
    private actions: Record<
      string,
      (args: { workspacePath: string; attempt: number; prompt: string }) => Promise<{
        events?: NibblerEvent[];
        exitCode?: number | null;
        signal?: string | null;
      }> | {
        events?: NibblerEvent[];
        exitCode?: number | null;
        signal?: string | null;
      }
    >
  ) {}

  capabilities(): RunnerCapabilities {
    return { interactive: false, permissions: true, streamJson: false };
  }

  async spawn(
    workspacePath: string,
    _envVars: Record<string, string>,
    configDir: string
  ): Promise<SessionHandle> {
    const id = `h-${Math.random().toString(16).slice(2)}`;
    const now = new Date().toISOString();
    const roleId = basename(configDir);
    const handle: SessionHandle = {
      id,
      pid: 1,
      startedAtIso: now,
      lastActivityAtIso: now,
      exitCode: null,
      signal: null
    };
    (handle as any).__workspacePath = workspacePath;
    (handle as any).__roleId = roleId;
    this.queues.set(id, new AsyncQueue<NibblerEvent>());
    this.alive.add(id);
    return handle;
  }

  async send(handle: SessionHandle, message: string): Promise<void> {
    const roleId = (handle as any).__roleId as string;
    const workspacePath = (handle as any).__workspacePath as string;
    const q = this.queues.get(handle.id)!;

    const prompts = this.promptsByRole.get(roleId) ?? [];
    prompts.push(message);
    this.promptsByRole.set(roleId, prompts);

    const nextAttempt = (this.attemptsByRole.get(roleId) ?? 0) + 1;
    this.attemptsByRole.set(roleId, nextAttempt);

    const result = await this.actions[roleId]?.({ workspacePath, attempt: nextAttempt, prompt: message });
    for (const ev of result?.events ?? []) q.push(ev);

    handle.exitCode = result?.exitCode ?? 0;
    handle.signal = result?.signal ?? null;
    handle.lastActivityAtIso = new Date().toISOString();

    this.alive.delete(handle.id);
    q.close();
  }

  readEvents(handle: SessionHandle): AsyncIterable<NibblerEvent> {
    return this.queues.get(handle.id)!;
  }

  isAlive(handle: SessionHandle): boolean {
    return this.alive.has(handle.id);
  }

  async stop(_handle: SessionHandle): Promise<void> {}
}

function makeSingleRoleContract(maxIterations: number): Contract {
  return {
    roles: [
      {
        id: 'worker',
        scope: ['src/**'],
        authority: { allowedCommands: [], allowedPaths: [] },
        outputExpectations: [],
        verificationMethod: { kind: 'none' },
        budget: { maxIterations, exhaustionEscalation: 'architect' }
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
}

describe('JobManager (process-exit fallback)', () => {
  it('falls back to deterministic verification when process exits cleanly without event', async () => {
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

    const runner = new ControlledRunnerAdapter({
      worker: async ({ workspacePath }) => {
        await mkdir(join(workspacePath, 'src'), { recursive: true });
        await writeFile(join(workspacePath, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
        // No events emitted; clean process exit.
        return { exitCode: 0, signal: null };
      }
    });
    const sessions = new SessionController(runner, repoRoot, { bootstrapPrompt: 'go', inactivityTimeoutMs: 2_000 });
    const jm = new JobManager(sessions, gates, evidence, ledger);

    const out = await jm.runJob(
      {
        repoRoot,
        jobId: 'j-test',
        currentPhaseId: 'p1',
        startedAtIso: new Date().toISOString(),
        statusPath: jobPaths.statusPath
      },
      makeSingleRoleContract(1),
      { roles: ['worker'] }
    );

    expect(out.ok).toBe(true);
    const ledgerContent = await readFile(jobPaths.ledgerPath, 'utf8');
    expect(ledgerContent).toContain('"kind":"session_protocol_missing"');
  });

  it('retries role-local after process exit with error code and injects retry feedback', async () => {
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

    const runner = new ControlledRunnerAdapter({
      worker: async ({ workspacePath, attempt }) => {
        if (attempt === 1) {
          return { exitCode: 2, signal: null };
        }
        await mkdir(join(workspacePath, 'src'), { recursive: true });
        await writeFile(join(workspacePath, 'src', 'retry.ts'), 'export const retry = true;\n', 'utf8');
        return { exitCode: 0, signal: null };
      }
    });
    const sessions = new SessionController(runner, repoRoot, { bootstrapPrompt: 'go', inactivityTimeoutMs: 2_000 });
    const jm = new JobManager(sessions, gates, evidence, ledger);

    const out = await jm.runJob(
      {
        repoRoot,
        jobId: 'j-test',
        currentPhaseId: 'p1',
        startedAtIso: new Date().toISOString(),
        statusPath: jobPaths.statusPath
      },
      makeSingleRoleContract(2),
      { roles: ['worker'] }
    );

    expect(out.ok).toBe(true);

    const ledgerContent = await readFile(jobPaths.ledgerPath, 'utf8');
    expect(ledgerContent).toContain('"reason":"session_process_exit"');
    expect((ledgerContent.match(/"type":"session_start","data":\{"role":"worker"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
