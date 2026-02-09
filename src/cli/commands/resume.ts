import type { RunnerAdapter } from '../../core/session/runner.js';
import { runExistingJob } from './existing-job.js';

export interface ResumeCommandOptions {
  repoRoot?: string;
  jobId: string;
  runner?: RunnerAdapter;
}

/**
 * `nibbler resume <job-id>` — attaches to a running job when possible; otherwise resumes from the
 * persisted checkpoint (`current_phase` + `current_phase_actor_index`) in `status.json`.
 */
export async function runResumeCommand(opts: ResumeCommandOptions): Promise<{ ok: boolean; details?: unknown }> {
  const res = await runExistingJob({ repoRoot: opts.repoRoot, jobId: opts.jobId, runner: opts.runner });
  return res.ok ? { ok: true, details: res.details } : { ok: false, details: res.details };
}
