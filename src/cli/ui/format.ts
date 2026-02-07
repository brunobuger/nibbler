import { theme, INDENT, RULE_WIDTH, ROLE_LABEL_WIDTH } from './theme.js';

// ── Time Formatting ─────────────────────────────────────────────────────────

/**
 * Format milliseconds into a compact human-readable string.
 * Examples: "124ms", "3.2s", "1m 42s", "2h 15m"
 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/**
 * Format seconds into a compact human-readable string.
 */
export function formatSeconds(seconds: number): string {
  return formatMs(seconds * 1000);
}

// ── Table Alignment ─────────────────────────────────────────────────────────

/**
 * Pad a string to a fixed width (right-pad with spaces).
 */
export function padRight(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

/**
 * Pad a string to a fixed width (left-pad with spaces).
 */
export function padLeft(str: string, width: number): string {
  if (str.length >= width) return str;
  return ' '.repeat(width - str.length) + str;
}

/**
 * Format a role label at a fixed width for the threaded view.
 */
export function roleLabel(role: string, width: number = ROLE_LABEL_WIDTH): string {
  const color = theme.role(role);
  return color(theme.bold(padRight(role, width)));
}

/**
 * Format indented continuation lines under a role label.
 */
export function roleContinuation(text: string, width: number = ROLE_LABEL_WIDTH): string {
  return ' '.repeat(width) + text;
}

// ── Horizontal Rules ────────────────────────────────────────────────────────

/**
 * A solid dim horizontal rule: ──────────────────────
 */
export function horizontalRule(width: number = RULE_WIDTH): string {
  return theme.dim('─'.repeat(width));
}

/**
 * A dashed dim separator: ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
 */
export function dashedRule(width: number = RULE_WIDTH): string {
  const segment = '─ ';
  const count = Math.floor(width / segment.length);
  return theme.dim(segment.repeat(count));
}

/**
 * A phase banner:  ── Discovery ────────────────────────
 */
export function phaseBanner(phaseName: string, width: number = RULE_WIDTH): string {
  const prefix = '── ';
  const label = phaseName.charAt(0).toUpperCase() + phaseName.slice(1);
  const suffixLen = Math.max(4, width - prefix.length - label.length - 1);
  const suffix = '─'.repeat(suffixLen);
  return theme.dim(prefix) + theme.bold(label) + theme.dim(' ' + suffix);
}

// ── Box Drawing ─────────────────────────────────────────────────────────────

/**
 * Draw a box with rounded corners around content lines.
 *
 * ```
 * ╭─── Title ─────────────────────────╮
 * │                                    │
 * │  content line 1                    │
 * │  content line 2                    │
 * │                                    │
 * ╰────────────────────────────────────╯
 * ```
 */
export function drawBox(title: string, lines: string[], width: number = RULE_WIDTH): string {
  const style = theme.gate.border;

  // Top border with title
  const titleText = ` ${title} `;
  const topFillLen = Math.max(0, width - 2 - 3 - titleText.length);
  const topLine = style('╭───') + theme.gate.title(titleText) + style('─'.repeat(topFillLen) + '╮');

  // Bottom border
  const bottomLine = style('╰' + '─'.repeat(width - 2) + '╯');

  // Empty line
  const emptyLine = style('│') + ' '.repeat(width - 2) + style('│');

  // Content lines
  const contentLines = lines.map((line) => {
    // Strip ANSI for length calculation
    const stripped = stripAnsi(line);
    const padLen = Math.max(0, width - 4 - stripped.length);
    return style('│') + '  ' + line + ' '.repeat(padLen) + style(' │');
  });

  return [topLine, emptyLine, ...contentLines, emptyLine, bottomLine].join('\n');
}

// ── Key-Value Formatting ────────────────────────────────────────────────────

/**
 * Format a label-value pair with alignment:
 * "  State       executing"
 */
export function keyValue(label: string, value: string, labelWidth: number = 14): string {
  return INDENT + theme.dim(padRight(label, labelWidth)) + value;
}

// ── Verification Result Formatting ──────────────────────────────────────────

export interface VerificationLine {
  name: string;
  passed: boolean;
  detail?: string;
}

/**
 * Format a verification result line:
 *   ✔ Scope check     12 files changed, 0 violations
 *   ✖ Tests           npm test -- exit 1
 */
export function verificationLine(item: VerificationLine, nameWidth: number = 20): string {
  const icon = item.passed ? theme.check : theme.cross;
  const name = padRight(item.name, nameWidth);
  const detail = item.detail ? theme.dim(item.detail) : '';
  return `${INDENT}${icon} ${name}${detail}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Strip ANSI escape codes from a string (for width calculations).
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Safely JSON-stringify a value.
 */
export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '"[unserializable]"';
  }
}
