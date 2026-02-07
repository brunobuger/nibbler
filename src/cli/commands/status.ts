import { resolve } from 'node:path';

import { readJobStatus, readLedgerTail, resolveJobId } from '../jobs.js';
import { getRenderer } from '../ui/renderer.js';
import { theme, INDENT } from '../ui/theme.js';
import { keyValue, padRight } from '../ui/format.js';

export interface StatusCommandOptions {
  repoRoot?: string;
  jobId?: string;
  tail?: number;
}

/**
 * `nibbler status [job-id]` — reads `.nibbler/jobs/<id>/status.json` and prints a structured view.
 */
export async function runStatusCommand(opts: StatusCommandOptions): Promise<{ ok: boolean; details?: unknown }> {
  const r = getRenderer();
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const jobId = await resolveJobId(repoRoot, opts.jobId);
  if (!jobId) return { ok: false, details: 'No jobs found under .nibbler/jobs/' };

  const status = await readJobStatus(repoRoot, jobId);
  const tailN = opts.tail ?? 10;
  const { entries, warnings } = await readLedgerTail(repoRoot, jobId, tailN);

  // ── Header ────────────────────────────────────────────────────────────────
  const description = status.description ? `  —  "${status.description}"` : '';
  r.text(`${INDENT}${theme.bold(`Job ${status.job_id}`)}${description}`);
  r.blank();

  // ── State ─────────────────────────────────────────────────────────────────
  const stateColor = stateStyle(String(status.state));
  r.text(keyValue('State', stateColor(String(status.state))));
  r.text(keyValue('Phase', status.current_phase ?? theme.dim('(none)')));

  if (status.current_role) {
    const roleColor = theme.role(status.current_role);
    const roleInfo = status.session_active ? ' (active)' : '';
    r.text(keyValue('Role', roleColor(theme.bold(status.current_role)) + theme.dim(roleInfo)));
  }

  if (status.engine_pid) {
    r.text(keyValue('Engine PID', String(status.engine_pid)));
  }

  r.blank();

  // ── Progress ──────────────────────────────────────────────────────────────
  r.text(`${INDENT}${theme.bold('Progress')}`);

  const completed = new Set(status.progress.roles_completed ?? []);
  const remaining = status.progress.roles_remaining ?? [];
  const allRoles = [...(status.progress.roles_completed ?? []), ...remaining];

  if (allRoles.length > 0) {
    const maxRoleLen = Math.max(...allRoles.map((r) => r.length), 6);
    for (const role of allRoles) {
      const roleColor = theme.role(role);
      const rolePadded = padRight(role, maxRoleLen + 2);
      let state: string;
      if (completed.has(role) && !(role === status.current_role && status.session_active)) {
        state = theme.success('done');
      } else if (role === status.current_role && status.session_active) {
        state = theme.warning('active');
      } else if (role === status.current_role) {
        state = theme.dim('current');
      } else {
        state = theme.dim('pending');
      }
      r.text(`${INDENT}  ${roleColor(rolePadded)}${state}`);
    }
  } else {
    r.text(`${INDENT}  ${theme.dim('(no roles scheduled)')}`);
  }

  r.blank();

  // ── Recent Events ─────────────────────────────────────────────────────────
  r.text(`${INDENT}${theme.bold(`Recent Events`)} ${theme.dim(`(last ${tailN})`)}`);

  if (warnings.length) {
    for (const w of warnings) {
      r.text(`${INDENT}  ${theme.warning('⚠')} ${w}`);
    }
  }

  if (entries.length === 0) {
    r.text(`${INDENT}  ${theme.dim('(no events)')}`);
  } else {
    for (const e of entries) {
      const entry = e as Record<string, unknown>;
      const ts = entry.timestamp ? formatTimestamp(String(entry.timestamp)) : '';
      const type = String(entry.type ?? '').padEnd(20);
      const data = entry.data;
      const detail = formatEventDetail(data);
      r.text(`${INDENT}  ${theme.dim(ts)}  ${type}${detail ? `  ${theme.dim(detail)}` : ''}`);
    }
  }

  r.blank();
  return { ok: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stateStyle(state: string): (s: string) => string {
  switch (state) {
    case 'executing':
      return theme.warning;
    case 'completed':
      return theme.success;
    case 'failed':
    case 'budget_exceeded':
    case 'cancelled':
      return theme.error;
    case 'paused':
      return theme.info;
    default:
      return (s: string) => s;
  }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso.slice(11, 19);
  }
}

function formatEventDetail(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const parts: string[] = [];
  if (d.role) parts.push(String(d.role));
  if (d.gateId) parts.push(`gate=${String(d.gateId)}`);
  if (d.decision) parts.push(String(d.decision));
  if (d.scopePassed !== undefined) parts.push(`scope=${d.scopePassed ? 'pass' : 'fail'}`);
  return parts.join('  ');
}
