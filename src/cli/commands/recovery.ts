import type { JobOutcome } from '../../core/job-manager.js';
import type { JobState } from '../../core/job/types.js';

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatFailureForArchitect(out: JobOutcome, job: JobState): string {
  if (out.ok) return 'Job completed successfully.';

  const parts: string[] = [];
  parts.push(`JobId: ${job.jobId}`);
  parts.push(`Reason: ${out.reason}`);
  if (job.currentPhaseId) parts.push(`Phase: ${job.currentPhaseId}`);
  if (job.currentRoleId) parts.push(`Role: ${job.currentRoleId}`);

  const details = (out as any).details;
  if (details != null) {
    parts.push('---');
    parts.push('Details:');
    parts.push(typeof details === 'string' ? details : safeJson(details));
  }

  parts.push('---');
  parts.push(`Evidence: .nibbler/jobs/${job.jobId}/evidence/`);
  parts.push(`Ledger: .nibbler/jobs/${job.jobId}/ledger.jsonl`);

  return parts.join('\n');
}

