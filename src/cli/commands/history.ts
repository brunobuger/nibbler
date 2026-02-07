import { resolve } from 'node:path';

import { listJobIds, readJobStatus, jobLedgerPath } from '../jobs.js';
import { LedgerReader } from '../../core/ledger/reader.js';
import { getRenderer } from '../ui/renderer.js';
import { theme, INDENT } from '../ui/theme.js';
import { formatMs, padRight } from '../ui/format.js';

export interface HistoryCommandOptions {
  repoRoot?: string;
  detailJobId?: string;
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'budget_exceeded']);

/**
 * `nibbler history` — scans `.nibbler/jobs/JOB_ID/status.json` snapshots and prints terminal jobs.
 * Use `--detail JOB_ID` to print the full ledger formatted as a timeline.
 */
export async function runHistoryCommand(opts: HistoryCommandOptions): Promise<{ ok: boolean; details?: unknown }> {
  const r = getRenderer();
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());

  // ── Detail view for a specific job ──────────────────────────────────────
  if (opts.detailJobId) {
    const jobId = opts.detailJobId;
    const ledger = new LedgerReader(jobLedgerPath(repoRoot, jobId));
    const { entries, warnings } = await ledger.readAllSafe();
    const integrity = await ledger.verifyIntegrity();

    r.text(`${INDENT}${theme.bold(`History: ${jobId}`)}`);
    r.blank();

    if (!integrity.ok) {
      r.warn(`Ledger integrity: ${integrity.message ?? 'failed'}`);
    }
    if (warnings.length) {
      for (const w of warnings) {
        r.warn(w);
      }
    }

    if (entries.length === 0) {
      r.dim('No ledger entries found.');
    } else {
      for (const e of entries) {
        const entry = e as Record<string, unknown>;
        const ts = entry.timestamp ? formatTimestamp(String(entry.timestamp)) : '';
        const type = String(entry.type ?? '').padEnd(22);
        const detail = formatEventSummary(entry.data);
        r.text(`${INDENT}  ${theme.dim(ts)}  ${type}${detail ? `  ${theme.dim(detail)}` : ''}`);
      }
    }

    r.blank();
    return { ok: true };
  }

  // ── Summary view of all completed jobs ─────────────────────────────────
  const ids = await listJobIds(repoRoot);
  if (ids.length === 0) {
    r.dim('No jobs found.');
    return { ok: true, details: 'No jobs found.' };
  }

  const rows: Array<{ id: string; state: string; durationMs: number | null; description?: string }> = [];
  for (const id of ids) {
    try {
      const st = await readJobStatus(repoRoot, id);
      if (!TERMINAL_STATES.has(String(st.state))) continue;
      const started = Date.parse(st.started_at);
      const ended = Date.parse(st.updated_at);
      const durationMs = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null;
      rows.push({ id: st.job_id, state: String(st.state), durationMs, description: st.description });
    } catch {
      // ignore invalid
    }
  }

  r.text(`${INDENT}${theme.bold('Completed Jobs')}`);
  r.blank();

  if (rows.length === 0) {
    r.dim('No completed jobs.');
    r.blank();
    return { ok: true };
  }

  const maxIdLen = Math.max(...rows.map((j) => j.id.length), 6);
  for (const j of rows) {
    const stateColor = j.state === 'completed' ? theme.success : theme.error;
    const duration = j.durationMs != null ? formatMs(j.durationMs) : theme.dim('unknown');
    const desc = j.description ? `  ${theme.dim(`"${j.description}"`)}` : '';
    r.text(`${INDENT}  ${padRight(j.id, maxIdLen + 2)}${stateColor(padRight(j.state, 14))}${theme.dim('duration=')}${duration}${desc}`);
  }

  r.blank();
  r.dim(`Run \`nibbler history --detail <job-id>\` for full event timeline.`);
  r.blank();
  return { ok: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso.slice(11, 19);
  }
}

function formatEventSummary(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const parts: string[] = [];
  if (d.role) parts.push(String(d.role));
  if (d.gateId) parts.push(`gate=${String(d.gateId)}`);
  if (d.decision) parts.push(String(d.decision));
  if (d.jobId) parts.push(`job=${String(d.jobId)}`);
  return parts.join('  ');
}
