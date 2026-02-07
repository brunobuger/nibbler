import chalk, { type ChalkInstance } from 'chalk';

// ── Semantic Colors ─────────────────────────────────────────────────────────
// Centralized color definitions. Respects NO_COLOR / FORCE_COLOR via chalk.

export const theme = {
  // Structural
  bold: chalk.bold,
  dim: chalk.dim,
  reset: chalk.reset,

  // Semantic
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  info: chalk.blue,
  muted: chalk.dim,

  // Symbols
  check: chalk.green('✔'),
  cross: chalk.red('✖'),
  bullet: chalk.dim('•'),
  arrow: chalk.dim('→'),
  dash: chalk.dim('─'),

  // Phase / Section
  banner: chalk.bold,
  rule: chalk.dim,

  // Roles — each role gets a distinct color for the threaded conversation view.
  // Falls back gracefully in 8-color terminals.
  role: (name: string): ChalkInstance => {
    const map: Record<string, ChalkInstance> = {
      architect: chalk.blue,
      sdet: chalk.cyan,
      backend: chalk.yellow,
      frontend: chalk.magenta,
      worker: chalk.white,
    };
    return map[name.toLowerCase()] ?? chalk.white;
  },

  // Gate chrome
  gate: {
    border: chalk.cyan,
    title: chalk.bold.cyan,
    label: chalk.bold,
    value: chalk.reset,
  },
} as const;

// ── Layout Constants ────────────────────────────────────────────────────────

/** Default indent for nested content (two spaces). */
export const INDENT = '  ';

/** Width used for horizontal rules and box drawing. */
export const RULE_WIDTH = 56;

/** Minimum column width for role labels in the threaded view. */
export const ROLE_LABEL_WIDTH = 12;
