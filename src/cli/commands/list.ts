import { resolve } from 'node:path';

import { listJobIds, readJobStatus } from '../jobs.js';
import { getRenderer } from '../ui/renderer.js';
import { theme, INDENT } from '../ui/theme.js';
import { padRight } from '../ui/format.js';

export interface ListCommandOptions {
  repoRoot?: string;
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'budget_exceeded']);

/**
 * `nibbler list` — scans `.nibbler/jobs/JOB_ID/status.json` snapshots and prints active/paused jobs.
 */
export async function runListCommand(opts: ListCommandOptions): Promise<{ ok: boolean; details?: unknown }> {
  const r = getRenderer();
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const ids = await listJobIds(repoRoot);

  if (ids.length === 0) {
    r.dim('No jobs found.');
    return { ok: true, details: 'No jobs found.' };
  }

  const active: Array<{ id: string; state: string; updatedAt: string; description?: string; currentRole?: string }> = [];
  for (const id of ids) {
    try {
      const st = await readJobStatus(repoRoot, id);
      if (!TERMINAL_STATES.has(String(st.state))) {
        active.push({
          id: st.job_id,
          state: String(st.state),
          updatedAt: st.updated_at,
          description: st.description,
          currentRole: st.current_role ?? undefined,
        });
      }
    } catch {
      // ignore invalid status
    }
  }

  r.text(`${INDENT}${theme.bold('Active Jobs')}`);
  r.blank();

  if (active.length === 0) {
    r.dim('No active jobs.');
    r.blank();
    return { ok: true };
  }

  const maxIdLen = Math.max(...active.map((j) => j.id.length), 6);
  for (const j of active) {
    const stateColor = j.state === 'executing' ? theme.warning : j.state === 'paused' ? theme.info : theme.dim;
    const roleInfo = j.currentRole ? ` ${theme.dim('role=')}${theme.role(j.currentRole)(j.currentRole)}` : '';
    const desc = j.description ? `  ${theme.dim(`"${j.description}"`)}` : '';
    r.text(`${INDENT}  ${padRight(j.id, maxIdLen + 2)}${stateColor(padRight(j.state, 12))}${roleInfo}${desc}`);
  }

  r.blank();
  return { ok: true };
}
