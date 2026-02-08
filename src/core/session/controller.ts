import type { Contract } from '../contract/types.js';
import type { JobState } from '../job/types.js';
import { compileContext } from '../context/compiler.js';
import { renderOverlay } from '../context/overlay.js';
import { generatePermissionsConfig, generatePlanPermissionsConfig, writePermissionsProfile } from '../context/permissions.js';
import { clearRoleOverlays, writeRoleOverlay } from '../../workspace/layout.js';
import type { RunnerAdapter } from './runner.js';
import type { BudgetSpec } from '../contract/types.js';
import type { SessionHandle, SessionOutcome } from './types.js';
import { SessionHealthMonitor } from './health.js';
import type { DelegationTask } from '../delegation/types.js';

export interface SessionControllerOptions {
  inactivityTimeoutMs?: number;
  bootstrapPrompt?: string;
}

export type SessionMode = 'plan' | 'implement';

export class SessionController {
  constructor(
    private runner: RunnerAdapter,
    private workspace: string,
    private opts: SessionControllerOptions = {}
  ) {}

  async startSession(
    roleId: string,
    job: JobState,
    contract: Contract,
    options: {
      mode?: SessionMode;
      bootstrapPrompt?: string;
      delegatedTasks?: DelegationTask[];
      implementationPlanRel?: string;
    } = {}
  ): Promise<SessionHandle> {
    await clearRoleOverlays(this.workspace);

    const mode: SessionMode = options.mode ?? 'implement';
    const ctx = compileContext(roleId, job.currentPhaseId, job, contract, {
      delegatedTasks: options.delegatedTasks,
      implementationPlanRel: options.implementationPlanRel,
      sessionMode: mode
    });
    const overlay = renderOverlay(ctx);
    await writeRoleOverlay(this.workspace, roleId, overlay);

    const role = contract.roles.find((r) => r.id === roleId);
    if (!role) throw new Error(`Unknown role '${roleId}'`);

    const cursorConfig = mode === 'plan' ? generatePlanPermissionsConfig() : generatePermissionsConfig(role, contract);
    const { profileDir } = await writePermissionsProfile(this.workspace, roleId, cursorConfig);

    const env: Record<string, string> = {};
    if (job.sessionLogPath) {
      // Job stores repo-relative path for portability; runner receives absolute.
      env.NIBBLER_SESSION_LOG_PATH = joinPath(this.workspace, job.sessionLogPath);
    }
    env.NIBBLER_JOB_ID = job.jobId;
    env.NIBBLER_ROLE_ID = roleId;

    const handle = await this.runner.spawn(this.workspace, env, profileDir, {
      mode: mode === 'plan' ? 'plan' : 'normal',
      taskType: mode === 'plan' ? 'plan' : 'execute'
    });
    await this.runner.send(
      handle,
      options.bootstrapPrompt ?? this.opts.bootstrapPrompt ?? 'Begin your assigned work as described in the project rules overlay.'
    );
    return handle;
  }

  async waitForCompletion(handle: SessionHandle, budget: BudgetSpec): Promise<SessionOutcome> {
    const inactivityTimeoutMs = this.opts.inactivityTimeoutMs ?? 60_000;

    let inactive = false;
    let dead = false;
    let budgetExceeded = false;

    const monitor = new SessionHealthMonitor(handle, budget, {
      inactivityTimeoutMs,
      pollIntervalMs: 1_000,
      isAlive: () => this.runner.isAlive(handle)
    });
    monitor.onInactive(() => {
      inactive = true;
    });
    monitor.onProcessDeath(() => {
      dead = true;
    });
    monitor.onBudgetExceeded(() => {
      budgetExceeded = true;
    });
    monitor.start();

    try {
      for await (const ev of this.runner.readEvents(handle)) {
        // Any parsed event is terminal for v1 orchestration.
        return { kind: 'event', event: ev };
      }

      if (budgetExceeded) return { kind: 'inactive_timeout' };
      if (inactive) return { kind: 'inactive_timeout' };
      if (dead) return { kind: 'process_exit', exitCode: null, signal: 'dead' };
      return { kind: 'process_exit', exitCode: null, signal: null };
    } finally {
      monitor.stop();
    }
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    await this.runner.stop(handle);
  }

  async swapSession(fromRole: string, toRole: string, job: JobState, contract: Contract): Promise<void> {
    // v1: swap is implemented as stopping any active session and preparing overlay/profile for the next.
    // The Job Manager handles verification and committing; SessionController only swaps context+permissions.
    await clearRoleOverlays(this.workspace);
    const ctx = compileContext(toRole, job.currentPhaseId, job, contract);
    await writeRoleOverlay(this.workspace, toRole, renderOverlay(ctx));

    const role = contract.roles.find((r) => r.id === toRole);
    if (!role) throw new Error(`Unknown role '${toRole}'`);
    await writePermissionsProfile(this.workspace, toRole, generatePermissionsConfig(role, contract));

    void fromRole;
  }
}

function joinPath(root: string, rel: string): string {
  // Avoid importing node:path in core hot path; keep simple.
  if (rel.startsWith('/')) return rel;
  return `${root.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`;
}

