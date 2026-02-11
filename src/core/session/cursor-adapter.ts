import { execa } from 'execa';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { RunnerAdapter, RunnerTaskType } from './runner.js';
import type { NibblerEvent, RunnerCapabilities, SessionHandle } from './types.js';
import { parseEventLine } from './event-parser.js';

type ProcState = {
  proc: ReturnType<typeof execa>;
  handle: SessionHandle;
  events: AsyncQueue<NibblerEvent>;
  log?: WriteStream;
  interactive: boolean;
  roleProfile: string;
  sentCount: number;
  logPath?: string;
  mode: 'normal' | 'plan';
  taskType: RunnerTaskType;
  model: string | null;
  lineCount: number;
  eventCount: number;
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
    // Cursor interactive stdin sessions are not reliably supported across installs yet.
    // Default to one-shot `--print` mode for robustness; opt-in interactive via env.
    const interactive = process.env.NIBBLER_CURSOR_INTERACTIVE === '1';
    return { interactive, permissions: true, streamJson: true };
  }

  async spawn(
    workspacePath: string,
    envVars: Record<string, string>,
    configDir: string,
    options?: { mode?: 'normal' | 'plan'; interactive?: boolean; taskType?: RunnerTaskType }
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

    const interactive = options?.interactive === true;
    const args = [...(interactive ? [] : ['--print']), '--force', '--output-format', 'stream-json'];
    if (options?.mode === 'plan') {
      // Cursor CLI plan mode.
      // Docs: https://cursor.com/docs/cli/overview#modes
      args.push('--mode=plan');
    }

    const taskType: RunnerTaskType = options?.taskType ?? (options?.mode === 'plan' ? 'plan' : 'execute');
    const model = resolveCursorModel(taskType);
    if (model) {
      // Docs: https://cursor.com/docs/cli/overview#non-interactive-mode
      args.push('--model', model);
    }

    // Verbose: show full runner invocation for debugging.
    if (process.env.NIBBLER_VERBOSE === '1' && process.env.NIBBLER_QUIET !== '1') {
      const roleProfile = basename(configDir);
      const envForDisplay = safeEnvForVerbose(envVars, configDir);
      const envPrefix = Object.entries(envForDisplay)
        .map(([k, v]) => `${k}=${shellEscape(v)}`)
        .join(' ');
      const cmdLine = `${envPrefix ? envPrefix + ' ' : ''}${shellEscape(cmd)} ${args.map(shellEscape).join(' ')}`;

      try {
        process.stderr.write(`\n  ${chalkDim('[verbose]')} Spawn Cursor session\n`);
        process.stderr.write(`  ${chalkDim('[verbose]')} roleProfile: ${roleProfile}\n`);
        process.stderr.write(`  ${chalkDim('[verbose]')} cwd: ${workspacePath}\n`);
        process.stderr.write(
          `  ${chalkDim('[verbose]')} mode: ${options?.mode ?? 'normal'} taskType=${taskType} model=${model ?? '(default)'} interactive=${
            interactive ? 'true' : 'false'
          }\n`
        );
        process.stderr.write(`  ${chalkDim('[verbose]')} cmd: ${cmdLine}\n\n`);
      } catch {
        // ignore
      }
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
    void proc
      .then((result: any) => {
        handle.exitCode = typeof result?.exitCode === 'number' ? result.exitCode : null;
        handle.signal = typeof result?.signal === 'string' ? result.signal : null;
        handle.lastActivityAtIso = new Date().toISOString();
      })
      .catch(() => {
        handle.exitCode = typeof proc.exitCode === 'number' ? proc.exitCode : null;
        const signal = (proc as any)?.signal;
        handle.signal = typeof signal === 'string' ? signal : null;
        handle.lastActivityAtIso = new Date().toISOString();
      });

    const events = new AsyncQueue<NibblerEvent>();
    const state: ProcState = {
      proc,
      handle,
      events,
      log,
      interactive,
      roleProfile: basename(configDir),
      sentCount: 0,
      logPath,
      mode: options?.mode === 'plan' ? 'plan' : 'normal',
      taskType,
      model,
      lineCount: 0,
      eventCount: 0,
    };
    this.byId.set(id, state);

    this.attachParsers(id);

    proc.finally(() => {
      if (handle.exitCode === undefined) {
        handle.exitCode = typeof proc.exitCode === 'number' ? proc.exitCode : null;
      }
      if (handle.signal === undefined) {
        const signal = (proc as any)?.signal;
        handle.signal = typeof signal === 'string' ? signal : null;
      }
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/25aab501-c72a-437e-b834-e0245fea140d',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'build-e2e-retry',hypothesisId:'H4',location:'src/core/session/cursor-adapter.ts:spawn/finally',message:'cursor session finished',data:{roleProfile:state.roleProfile,mode:state.mode,taskType:state.taskType,model:state.model,interactive:state.interactive,sentCount:state.sentCount,lineCount:state.lineCount,eventCount:state.eventCount,exitCode:handle.exitCode ?? null,signal:handle.signal ?? null},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      this.byId.delete(id);
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
    // In print mode, stdin is the prompt. In interactive mode, stdin stays open.
    st.handle.lastActivityAtIso = new Date().toISOString();

    const verbose = process.env.NIBBLER_VERBOSE === '1' && process.env.NIBBLER_QUIET !== '1';
    const sendIndex = st.sentCount + 1;
    st.sentCount = sendIndex;

    if (st.log) {
      try {
        st.log.write(`[nibbler] stdin message #${sendIndex} begin\n`);
        st.log.write(message);
        st.log.write(`\n[nibbler] stdin message #${sendIndex} end\n`);
      } catch {
        // ignore
      }
    }

    if (verbose) {
      try {
        const summary = summarizeText(message);
        process.stderr.write(`  ${chalkDim('[verbose]')} stdin #${sendIndex} roleProfile=${st.roleProfile} len=${summary.chars} lines=${summary.lines}\n`);
        if (st.logPath) process.stderr.write(`  ${chalkDim('[verbose]')} stdinLog: ${st.logPath}\n`);
        process.stderr.write(`  ${chalkDim('[verbose]')} stdinPayload:\n`);
        const rendered = renderVerbosePayload(message);
        for (const line of rendered.split('\n')) {
          process.stderr.write(`  ${line}\n`);
        }
        process.stderr.write('\n');
      } catch {
        // ignore
      }
    }

    st.proc.stdin?.write(message);
    st.proc.stdin?.write('\n');
    if (!st.interactive) st.proc.stdin?.end();
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

    if (proc.exitCode === null) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      await waitForProcessExit(proc, 1_500);

      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        await waitForProcessExit(proc, 2_500);
      }
    }

    // Always close the event stream so callers waiting on readEvents can proceed
    // even if the underlying process refuses to exit promptly.
    st.events.close();
    this.byId.delete(handle.id);
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
      st.lineCount += 1;
      try {
        st.log?.write(`${line}\n`);
      } catch {
        // ignore
      }

      // First, try direct NIBBLER_EVENT line.
      const direct = parseEventLine(line);
      if (direct) {
        st.eventCount += 1;
        st.events.push(direct);
      }

      // Then try NDJSON from stream-json output format.
      const ndjsonTexts = extractTextsFromNdjsonLine(line);
      for (const text of ndjsonTexts) {
        for (const l of text.split('\n')) {
          const ev = parseEventLine(l);
          if (ev) {
            st.eventCount += 1;
            st.events.push(ev);
          }
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

function resolveCursorModel(taskType: RunnerTaskType): string | null {
  const global = process.env.NIBBLER_CURSOR_MODEL?.trim();
  if (global) return global;

  if (taskType === 'plan') {
    return process.env.NIBBLER_CURSOR_MODEL_PLAN?.trim() || null;
  }

  return process.env.NIBBLER_CURSOR_MODEL_EXECUTE?.trim() || 'gemini-3-flash';
}

function safeEnvForVerbose(envVars: Record<string, string>, configDir: string): Record<string, string> {
  const out: Record<string, string> = { CURSOR_CONFIG_DIR: configDir };
  for (const [k, v] of Object.entries(envVars)) {
    if (k.startsWith('NIBBLER_')) out[k] = v;
  }
  return out;
}

function shellEscape(v: string): string {
  if (v.length === 0) return "''";
  // Safe unquoted subset
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(v)) return v;
  // POSIX-ish single-quote escape.
  // In shell, to embed a single quote inside a single-quoted string, use: '\''
  return `'${v.replaceAll("'", "'\\''")}'`;
}

function chalkDim(s: string): string {
  // Avoid importing theme/renderer from CLI into core; keep minimal.
  // Respect NO_COLOR via environment.
  if (process.env.NO_COLOR) return s;
  // ANSI dim
  return `\u001b[2m${s}\u001b[22m`;
}

function summarizeText(s: string): { chars: number; lines: number } {
  const chars = s.length;
  // Count '\n' without splitting the whole string in the common case.
  let lines = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) lines += 1;
  return { chars, lines };
}

function renderVerbosePayload(s: string): string {
  const maxChars = Number(process.env.NIBBLER_VERBOSE_PROMPT_MAX_CHARS ?? '') || 12_000;
  if (s.length <= maxChars) return fence(s);

  const head = s.slice(0, Math.max(0, maxChars - 2_000));
  const tail = s.slice(-2_000);
  const note = `\n\n[truncated: ${s.length} chars total; set NIBBLER_VERBOSE_PROMPT_MAX_CHARS to increase]\n\n`;
  return fence(head + note + tail);
}

function fence(s: string): string {
  // Use a neutral fence to preserve whitespace.
  return ['```text', s.trimEnd(), '```'].join('\n');
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

async function waitForProcessExit(proc: ReturnType<typeof execa>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      proc.then(() => undefined).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => resolve(), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

