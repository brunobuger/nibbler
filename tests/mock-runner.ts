import { basename } from 'node:path';

import type { RunnerAdapter } from '../src/core/session/runner.js';
import type { NibblerEvent, RunnerCapabilities, SessionHandle } from '../src/core/session/types.js';

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

export type RoleAction = (args: {
  workspacePath: string;
  roleId: string;
  attempt: number;
  message: string;
  mode: 'normal' | 'plan';
}) => Promise<void> | void;

export class MockRunnerAdapter implements RunnerAdapter {
  private qByHandle = new Map<string, AsyncQueue<NibblerEvent>>();
  private roleByHandle = new Map<string, string>();
  private modeByHandle = new Map<string, 'normal' | 'plan'>();
  private alive = new Set<string>();
  private attemptByRole = new Map<string, number>();

  readonly startedRoles: string[] = [];
  readonly startedSessions: Array<{ roleId: string; mode: 'normal' | 'plan' }> = [];

  constructor(private actions: Record<string, RoleAction> = {}) {}

  capabilities(): RunnerCapabilities {
    return { interactive: false, permissions: true, streamJson: false };
  }

  async spawn(
    workspacePath: string,
    _envVars: Record<string, string>,
    configDir: string,
    options?: { mode?: 'normal' | 'plan' }
  ): Promise<SessionHandle> {
    const roleId = basename(configDir);
    const id = `h-${Math.random().toString(16).slice(2)}`;
    const now = new Date().toISOString();
    const handle: SessionHandle = { id, startedAtIso: now, lastActivityAtIso: now, pid: 1 };

    this.startedRoles.push(roleId);
    this.startedSessions.push({ roleId, mode: options?.mode ?? 'normal' });
    this.roleByHandle.set(id, roleId);
    this.modeByHandle.set(id, options?.mode ?? 'normal');
    this.qByHandle.set(id, new AsyncQueue<NibblerEvent>());
    this.alive.add(id);

    // Remember workspacePath for action execution by storing in env-like map via handle id.
    // (We pass it again from send by looking up the role; actions receive workspacePath.)
    (handle as any).__workspacePath = workspacePath;

    return handle;
  }

  async send(handle: SessionHandle, message: string): Promise<void> {
    handle.lastActivityAtIso = new Date().toISOString();

    const roleId = this.roleByHandle.get(handle.id);
    if (!roleId) throw new Error('unknown handle role');

    const mode = this.modeByHandle.get(handle.id) ?? 'normal';
    const nextAttempt = (this.attemptByRole.get(roleId) ?? 0) + 1;
    const attempt = nextAttempt;
    // Two-step execution: plan sessions should not advance the "attempt" counter.
    if (mode === 'normal') {
      this.attemptByRole.set(roleId, attempt);
    }

    const workspacePath = (handle as any).__workspacePath as string;
    const action = this.actions[roleId];
    if (action) await action({ workspacePath, roleId, attempt, message, mode });

    const q = this.qByHandle.get(handle.id);
    if (!q) throw new Error('missing queue');
    q.push({ type: 'PHASE_COMPLETE', summary: `role=${roleId} attempt=${attempt}` });
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

