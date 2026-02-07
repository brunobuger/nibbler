export type CancelSignal = 'SIGINT' | 'SIGTERM';
export type CancelSource = 'signal' | 'keypress';

export interface CancelInfo {
  signal: CancelSignal;
  source: CancelSource;
}

export interface InstalledCliCancellation {
  /** AbortSignal that flips when cancellation is requested. */
  signal: AbortSignal;
  /** Number of cancellation triggers seen (Ctrl+C presses, SIGTERM, etc). */
  count: number;
  /** Remove handlers and clear active signal. */
  dispose(): void;
}

let _activeCancelSignal: AbortSignal | null = null;

/**
 * Current active CLI cancellation signal (if any command installed one).
 * Used to abort interactive prompts.
 */
export function getActiveCancelSignal(): AbortSignal | null {
  return _activeCancelSignal;
}

export function installCliCancellation(opts: {
  /**
   * Called on the first cancellation trigger (SIGINT/SIGTERM or Ctrl+C keypress in raw mode).
   * Should initiate best-effort graceful shutdown.
   */
  onCancel?: (info: CancelInfo) => void | Promise<void>;
  /**
   * Called on the second+ cancellation trigger. Defaults to `process.exit(...)`.
   * Use this to force exit if graceful shutdown is stuck (e.g., blocked in a prompt).
   */
  onForceExit?: (info: CancelInfo & { count: number }) => void;
} = {}): InstalledCliCancellation {
  const controller = new AbortController();
  _activeCancelSignal = controller.signal;

  let count = 0;
  let disposed = false;

  const defaultForceExit = (info: CancelInfo & { count: number }) => {
    // Conventional exit codes:
    // - 130 = 128 + SIGINT(2)
    // - 143 = 128 + SIGTERM(15)
    const code = info.signal === 'SIGTERM' ? 143 : 130;
    process.exit(code);
  };

  const trigger = (info: CancelInfo) => {
    if (disposed) return;
    count += 1;

    // First trigger: abort + graceful cancel callback.
    if (count === 1) {
      try {
        controller.abort(info);
      } catch {
        // ignore
      }
      if (opts.onCancel) {
        Promise.resolve(opts.onCancel(info)).catch(() => {
          // best-effort; never throw from signal path
        });
      }
      return;
    }

    // Second trigger: force exit.
    try {
      (opts.onForceExit ?? defaultForceExit)({ ...info, count });
    } catch {
      defaultForceExit({ ...info, count });
    }
  };

  const onSigint = () => trigger({ signal: 'SIGINT', source: 'signal' });
  const onSigterm = () => trigger({ signal: 'SIGTERM', source: 'signal' });

  // NOTE: use `on`, not `once`: we implement "press twice to force quit".
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  // In raw-mode TTY input (common for interactive prompts), Ctrl+C may not emit SIGINT.
  // Detect it as a keypress byte (0x03) so users can always cancel.
  const wantsStdin = !!process.stdin?.isTTY;
  const onStdinData = (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.includes(3)) {
      trigger({ signal: 'SIGINT', source: 'keypress' });
    }
  };
  if (wantsStdin) {
    process.stdin.on('data', onStdinData);
    // Ensure stdin is flowing while we're listening.
    process.stdin.resume();
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    if (wantsStdin) {
      process.stdin.off('data', onStdinData);
      // Avoid keeping the process alive if we were the only data listener.
      try {
        if (process.stdin.listenerCount('data') === 0) process.stdin.pause();
      } catch {
        // ignore
      }
    }
    if (_activeCancelSignal === controller.signal) _activeCancelSignal = null;
  };

  return {
    get signal() {
      return controller.signal;
    },
    get count() {
      return count;
    },
    dispose,
  };
}

