import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initWorkspace } from '../src/workspace/layout.js';
import type { RunnerAdapter } from '../src/core/session/runner.js';
import type { NibblerEvent, RunnerCapabilities, SessionHandle } from '../src/core/session/types.js';
import { SessionController } from '../src/core/session/controller.js';
import type { Contract } from '../src/core/contract/types.js';

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

class MockRunner implements RunnerAdapter {
  private qByHandle = new Map<string, AsyncQueue<NibblerEvent>>();
  private alive = new Set<string>();

  capabilities(): RunnerCapabilities {
    return { interactive: false, permissions: true, streamJson: false };
  }

  async spawn(
    _workspacePath: string,
    _envVars: Record<string, string>,
    _configDir: string,
    _options?: { mode?: 'normal' | 'plan'; interactive?: boolean }
  ): Promise<SessionHandle> {
    const id = `h-${Math.random().toString(16).slice(2)}`;
    const now = new Date().toISOString();
    const handle: SessionHandle = { id, startedAtIso: now, lastActivityAtIso: now, pid: 1 };
    this.qByHandle.set(id, new AsyncQueue<NibblerEvent>());
    this.alive.add(id);
    return handle;
  }

  async send(handle: SessionHandle, _message: string): Promise<void> {
    handle.lastActivityAtIso = new Date().toISOString();
    const q = this.qByHandle.get(handle.id);
    if (!q) throw new Error('missing queue');
    q.push({ type: 'PHASE_COMPLETE', summary: 'ok' });
    q.close();
    this.alive.delete(handle.id);
  }

  readEvents(handle: SessionHandle): AsyncIterable<NibblerEvent> {
    const q = this.qByHandle.get(handle.id);
    if (!q) throw new Error('missing queue');
    return q;
  }

  isAlive(handle: SessionHandle): boolean {
    return this.alive.has(handle.id);
  }

  async stop(_handle: SessionHandle): Promise<void> {}
}

describe('SessionController (mock runner)', () => {
  it('writes overlay and permissions profile and completes on event', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-session-'));
    await initWorkspace(repoRoot);

    const contract: Contract = {
      roles: [
        {
          id: 'worker',
          scope: ['src/**'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, exhaustionEscalation: 'escalate' }
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
      globalLifetime: { maxTimeMs: 10_000 },
      sharedScopes: [],
      escalationChain: []
    };

    const job = {
      repoRoot,
      jobId: 'j-test',
      currentPhaseId: 'p1',
      startedAtIso: new Date().toISOString()
    };

    const runner = new MockRunner();
    const sc = new SessionController(runner, repoRoot, { inactivityTimeoutMs: 5_000, bootstrapPrompt: 'go' });

    const handle = await sc.startSession('worker', job, contract);

    const overlayPath = join(repoRoot, '.cursor', 'rules', '20-role-worker.mdc');
    const overlay = await readFile(overlayPath, 'utf8');
    expect(overlay).toContain('Role: worker');

    const profilePath = join(repoRoot, '.nibbler', 'config', 'cursor-profiles', 'worker', 'cli-config.json');
    const profile = await readFile(profilePath, 'utf8');
    expect(profile).toContain('"version"');

    const outcome = await sc.waitForCompletion(handle, contract.roles[0].budget);
    expect(outcome.kind).toBe('event');
  });
});

