import ora, { type Ora } from 'ora';

// ── TTY-Aware Spinner ───────────────────────────────────────────────────────
// Wraps `ora` with a consistent API. Falls back to static lines in non-TTY
// contexts (CI, piped output). Writes to stderr to keep stdout clean.

export interface SpinnerHandle {
  /** Update the spinner text while it's running. */
  update(text: string): void;
  /** Stop with a success checkmark and message. */
  succeed(text?: string): void;
  /** Stop with a failure cross and message. */
  fail(text?: string): void;
  /** Stop with a warning symbol and message. */
  warn(text?: string): void;
  /** Stop with an info symbol and message. */
  info(text?: string): void;
  /** Stop the spinner without a status symbol. */
  stop(): void;
}

/**
 * Create and start a spinner with the given text.
 * In non-TTY environments, prints a static line instead.
 */
export function startSpinner(text: string): SpinnerHandle {
  const isTTY = Boolean(process.stderr.isTTY || process.stdout.isTTY);
  const verbose = process.env.NIBBLER_VERBOSE === '1' && process.env.NIBBLER_QUIET !== '1';
  // Prefer stderr for normal runs (keeps stdout clean for piping), but in verbose mode
  // we print lots of debug lines to stderr, which can visually "erase" ora spinners.
  const stream: NodeJS.WritableStream =
    verbose && process.stdout.isTTY ? process.stdout : (process.stderr.isTTY ? process.stderr : process.stdout);

  // NOTE:
  // - `NO_COLOR` should disable colors, not spinners.
  // - Some environments set `CI=1` even locally; `ora` disables spinners by default
  //   in CI, so we explicitly force-enable when stderr is a TTY.
  if (!isTTY || process.env.NIBBLER_QUIET === '1') {
    // Non-interactive fallback: static lines.
    stream.write(`  ${text}\n`);
    return {
      update(t: string) {
        stream.write(`  ${t}\n`);
      },
      succeed(t?: string) {
        if (t) stream.write(`  ✔ ${t}\n`);
      },
      fail(t?: string) {
        if (t) stream.write(`  ✖ ${t}\n`);
      },
      warn(t?: string) {
        if (t) stream.write(`  ⚠ ${t}\n`);
      },
      info(t?: string) {
        if (t) stream.write(`  ℹ ${t}\n`);
      },
      stop() {
        // no-op for static mode
      },
    };
  }

  const spinner: Ora = ora({
    text,
    stream,
    spinner: 'dots',
    indent: 2,
    isEnabled: true,
  }).start();

  return {
    update(t: string) {
      spinner.text = t;
    },
    succeed(t?: string) {
      spinner.succeed(t ?? spinner.text);
    },
    fail(t?: string) {
      spinner.fail(t ?? spinner.text);
    },
    warn(t?: string) {
      spinner.warn(t ?? spinner.text);
    },
    info(t?: string) {
      spinner.info(t ?? spinner.text);
    },
    stop() {
      spinner.stop();
    },
  };
}
