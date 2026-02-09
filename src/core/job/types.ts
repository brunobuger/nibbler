import type { DiffResult } from '../../git/diff-parser.js';
import type { DelegationPlan } from '../delegation/types.js';

export interface SessionUsage {
  iterations: number;
  elapsedMs: number;
  diffLines: number;
}

export type JobMode = 'build' | 'fix' | 'resume';

export type JobStatus =
  | 'created'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'budget_exceeded';

export interface JobState {
  repoRoot: string;
  jobId: string;
  currentPhaseId: string;
  startedAtIso: string;

  /**
   * Optional git isolation for this job: a dedicated worktree and job branch.
   * When set, all git operations (diff/commit/reset/clean) should run against `worktreePath`,
   * while engine state/evidence remains rooted under `repoRoot` (main repo working directory).
   */
  worktreePath?: string; // absolute path to job worktree (workspace for sessions)
  sourceBranch?: string; // user's original branch to merge back into
  jobBranch?: string; // nibbler/job-<id> or nibbler/fix-<id>

  preSessionCommit?: string;
  lastDiff?: DiffResult;

  /**
   * Validated delegation plan produced by the Architect during planning.
   * Stored in memory for orchestration; artifacts on disk remain the source of truth.
   */
  delegationPlan?: DelegationPlan;

  /**
   * Job-local scope exceptions (engine-managed).
   * These are not persisted back into the base contract; they apply only within this job.
   */
  scopeOverridesByRole?: Record<
    string,
    Array<{
      kind: 'shared_scope' | 'extra_scope';
      patterns: string[];
      ownerRoleId?: string;
      phaseId: string;
      grantedAtIso: string;
      expiresAfterAttempt?: number;
      notes?: string;
    }>
  >;

  // Phase 6 extensions (optional so Phase 0–3 tests keep working).
  state?: JobStatus;
  currentRoleId?: string | null;
  statusPath?: string;
  feedbackByRole?: Record<string, unknown>;
  attemptsByRole?: Record<string, number>;

  // Phase 10 — observability + UX.
  mode?: JobMode;
  description?: string;
  enginePid?: number;

  sessionActive?: boolean;
  sessionHandleId?: string | null;
  sessionPid?: number | null;
  sessionLogPath?: string | null;
  sessionStartedAtIso?: string | null;
  sessionLastActivityAtIso?: string | null;

  globalBudgetLimitMs?: number;
  currentRoleMaxIterations?: number;
  rolesPlanned?: string[];
  rolesCompleted?: string[];

  // Contract-runner checkpointing (for `nibbler resume`).
  currentPhaseActorIndex?: number;

  // Gate checkpointing (for `nibbler resume`).
  pendingGateId?: string | null;
}

