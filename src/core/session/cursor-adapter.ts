import { execa, type ExecaChildProcess } from 'execa';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { RunnerAdapter } from './runner.js';
import type { NibblerEvent, RunnerCapabilities, SessionHandle } from './types.js';
import { parseEventLine } from './event-parser.js';

type ProcState = {
  proc: ExecaChildProcess;
  handle: SessionHandle;
  events: AsyncQueue<NibblerEvent>;
  log?: WriteStream;
};

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(v: IteratorResult<T>) => void> = [];
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

export class CursorRunnerAdapter implements RunnerAdapter {
  private byId = new Map<string, ProcState>();

  capabilities(): RunnerCapabilities {
    return { interactive: false, permissions: true, streamJson: true };
  }

  async spawn(
    workspacePath: string,
    envVars: Record<string, string>,
    configDir: string,
    options?: { mode?: 'normal' | 'plan' }
  ): Promise<SessionHandle> {
    const id = randomUUID();
    const nowIso = new Date().toISOString();
    const handle: SessionHandle = { id, startedAtIso: nowIso, lastActivityAtIso: nowIso };

    const cmd = await detectAgentBinary();

    const logPath = envVars.NIBBLER_SESSION_LOG_PATH?.trim();
    let log: WriteStream | undefined;
    if (logPath) {
      await mkdir(dirname(logPath), { recursive: true });
      log = createWriteStream(logPath, { flags: 'a' });
      log.write(`[nibbler] session spawn ${nowIso} workspace=${workspacePath}\n`);
    }

    const args = ['--print', '--force', '--output-format', 'stream-json'];
    if (options?.mode === 'plan') {
      // Cursor CLI plan mode (2026+) -- forces plan-first behavior.
      args.push('--plan');
    }

    const proc = execa(cmd, args, {
      cwd: workspacePath,
      env: {
        ...process.env,
        ...envVars,
        CURSOR_CONFIG_DIR: configDir
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      // NOTE: execa v9 configures force-kill behavior via options, not kill() args.
      killSignal: 'SIGTERM',
      forceKillAfterDelay: 5_000,
      reject: false
    });

    handle.pid = proc.pid;

    const events = new AsyncQueue<NibblerEvent>();
    this.byId.set(id, { proc, handle, events, log });

    this.attachParsers(id);

    proc.finally(() => {
      events.close();
      try {
        log?.write(`[nibbler] session end ${new Date().toISOString()}\n`);
        log?.end();
      } catch {
        // ignore
      }
    });

    return handle;
  }

  async send(handle: SessionHandle, message: string): Promise<void> {
    const st = this.mustGet(handle);
    // In print mode, stdin is the prompt. Close stdin after writing.
    st.handle.lastActivityAtIso = new Date().toISOString();
    st.proc.stdin?.write(message);
    st.proc.stdin?.write('\n');
    st.proc.stdin?.end();
  }

  readEvents(handle: SessionHandle): AsyncIterable<NibblerEvent> {
    return this.mustGet(handle).events;
  }

  isAlive(handle: SessionHandle): boolean {
    const st = this.byId.get(handle.id);
    if (!st) return false;
    // execa sets exitCode/signal on completion
    return st.proc.exitCode === null && st.proc.killed === false;
  }

  async stop(handle: SessionHandle): Promise<void> {
    const st = this.byId.get(handle.id);
    if (!st) return;
    const proc = st.proc;

    if (proc.exitCode !== null) return;

    proc.kill('SIGTERM');
    await proc.catch(() => undefined);
  }

  private mustGet(handle: SessionHandle): ProcState {
    const st = this.byId.get(handle.id);
    if (!st) throw new Error(`Unknown session handle ${handle.id}`);
    return st;
  }

  private attachParsers(id: string) {
    const st = this.byId.get(id);
    if (!st) return;

    const onLine = (_source: 'stdout' | 'stderr', line: string) => {
      st.handle.lastActivityAtIso = new Date().toISOString();
      try {
        st.log?.write(`${line}\n`);
      } catch {
        // ignore
      }

      // First, try direct NIBBLER_EVENT line.
      const direct = parseEventLine(line);
      if (direct) st.events.push(direct);

      // Then try NDJSON from stream-json output format.
      const ndjsonTexts = extractTextsFromNdjsonLine(line);
      for (const text of ndjsonTexts) {
        for (const l of text.split('\n')) {
          const ev = parseEventLine(l);
          if (ev) st.events.push(ev);
        }
      }
    };

    const out = st.proc.stdout;
    const err = st.proc.stderr;
    if (out) createInterface({ input: out }).on('line', (line) => onLine('stdout', line));
    if (err) createInterface({ input: err }).on('line', (line) => onLine('stderr', line));
  }
}

async function detectAgentBinary(): Promise<string> {
  // Prefer `agent` per Cursor CLI docs; fall back to `cursor` for older installs.
  return process.env.NIBBLER_CURSOR_BINARY?.trim() || 'agent';
}

function extractTextsFromNdjsonLine(line: string): string[] {
  try {
    const obj = JSON.parse(line) as any;
    // assistant message event
    if (obj?.type === 'assistant') {
      const content = obj?.message?.content;
      if (Array.isArray(content)) {
        return content.filter((c: any) => c?.type === 'text' && typeof c?.text === 'string').map((c: any) => c.text);
      }
    }
    // terminal result event
    if (obj?.type === 'result' && typeof obj?.result === 'string') return [obj.result];
    return [];
  } catch {
    return [];
  }
}

