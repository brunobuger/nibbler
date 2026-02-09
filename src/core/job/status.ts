import { z } from 'zod';

import type { JobState, JobStatus, JobMode } from './types.js';

export const JobStatusSnapshotV1Schema = z.object({
  version: z.literal(1),
  job_id: z.string().min(1),
  repo_root: z.string().min(1).optional(),
  mode: z.custom<JobMode>().optional(),
  description: z.string().optional(),

  // Worktree-based job isolation (optional; present for jobs created by newer engines).
  worktree_path: z.string().min(1).nullable().optional(),
  source_branch: z.string().min(1).nullable().optional(),
  job_branch: z.string().min(1).nullable().optional(),

  state: z.custom<JobStatus>(),
  current_phase: z.string().nullable(),
  current_phase_actor_index: z.number().int().nonnegative().nullable().optional(),
  pending_gate_id: z.string().min(1).nullable().optional(),
  current_role: z.string().nullable(),
  session_active: z.boolean(),
  engine_pid: z.number().int().positive().optional(),

  session: z
    .object({
      handle_id: z.string().min(1).optional(),
      pid: z.number().int().positive().optional(),
      log_path: z.string().min(1).optional(),
      started_at: z.string().min(1).optional(),
      last_activity_at: z.string().min(1).optional()
    })
    .nullable(),

  started_at: z.string().min(1),
  updated_at: z.string().min(1),

  budget: z.object({
    global: z.object({
      limit_ms: z.number().int().positive().optional(),
      elapsed_ms: z.number().int().nonnegative()
    }),
    current_role: z
      .object({
        iterations: z.object({
          limit: z.number().int().positive().optional(),
          used: z.number().int().nonnegative().optional()
        })
      })
      .optional()
  }),

  progress: z.object({
    roles_completed: z.array(z.string()),
    roles_remaining: z.array(z.string())
  }),

  git: z
    .object({
      pre_session_commit: z.string().nullable().optional(),
      last_diff_summary: z
        .object({
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative(),
          filesChanged: z.number().int().nonnegative()
        })
        .nullable()
        .optional()
    })
    .optional()
});

export type JobStatusSnapshotV1 = z.infer<typeof JobStatusSnapshotV1Schema>;

export function buildJobStatusSnapshotV1(job: JobState): JobStatusSnapshotV1 {
  const nowIso = new Date().toISOString();
  const started = Date.parse(job.startedAtIso);
  const elapsedMs = Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;

  const rolesPlanned = Array.isArray(job.rolesPlanned) ? job.rolesPlanned : [];
  const rolesCompleted = Array.isArray(job.rolesCompleted) ? job.rolesCompleted : [];
  const completedSet = new Set(rolesCompleted);
  const rolesRemaining = rolesPlanned.filter((r) => !completedSet.has(r));

  const snapshot: JobStatusSnapshotV1 = {
    version: 1,
    job_id: job.jobId,
    repo_root: job.repoRoot,
    mode: job.mode,
    description: job.description,
    worktree_path: job.worktreePath ?? null,
    source_branch: job.sourceBranch ?? null,
    job_branch: job.jobBranch ?? null,
    state: (job.state ?? 'created') as JobStatus,
    current_phase: job.currentPhaseId ?? null,
    current_phase_actor_index: job.currentPhaseActorIndex ?? null,
    pending_gate_id: job.pendingGateId ?? null,
    current_role: job.currentRoleId ?? null,
    session_active: job.sessionActive === true,
    engine_pid: job.enginePid,
    session:
      job.sessionActive === true || job.sessionHandleId || job.sessionPid || job.sessionLogPath
        ? {
            handle_id: job.sessionHandleId ?? undefined,
            pid: job.sessionPid ?? undefined,
            log_path: job.sessionLogPath ?? undefined,
            started_at: job.sessionStartedAtIso ?? undefined,
            last_activity_at: job.sessionLastActivityAtIso ?? undefined
          }
        : null,
    started_at: job.startedAtIso,
    updated_at: nowIso,
    budget: {
      global: { limit_ms: job.globalBudgetLimitMs, elapsed_ms: elapsedMs },
      current_role: {
        iterations: {
          limit: job.currentRoleMaxIterations,
          used: job.currentRoleId ? job.attemptsByRole?.[job.currentRoleId] : undefined
        }
      }
    },
    progress: {
      roles_completed: rolesCompleted,
      roles_remaining: rolesRemaining
    },
    git: {
      pre_session_commit: job.preSessionCommit ?? null,
      last_diff_summary: job.lastDiff?.summary ?? null
    }
  };

  return JobStatusSnapshotV1Schema.parse(snapshot);
}

