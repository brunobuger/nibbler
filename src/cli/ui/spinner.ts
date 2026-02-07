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
  const isTTY = process.stderr.isTTY;

  if (!isTTY || process.env.NIBBLER_QUIET === '1' || process.env.NO_COLOR != null) {
    // Non-interactive fallback: static lines.
    process.stderr.write(`  ${text}\n`);
    return {
      update(t: string) {
        process.stderr.write(`  ${t}\n`);
      },
      succeed(t?: string) {
        if (t) process.stderr.write(`  ✔ ${t}\n`);
      },
      fail(t?: string) {
        if (t) process.stderr.write(`  ✖ ${t}\n`);
      },
      warn(t?: string) {
        if (t) process.stderr.write(`  ⚠ ${t}\n`);
      },
      info(t?: string) {
        if (t) process.stderr.write(`  ℹ ${t}\n`);
      },
      stop() {
        // no-op for static mode
      },
    };
  }

  const spinner: Ora = ora({
    text,
    stream: process.stderr,
    spinner: 'dots',
    indent: 2,
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
