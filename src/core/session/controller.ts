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
import { readFile } from 'node:fs/promises';

export interface SessionControllerOptions {
  inactivityTimeoutMs?: number;
  bootstrapPrompt?: string;
}

export interface WaitForCompletionOptions {
  onHeartbeat?: (args: { nowIso: string; lastActivityAtIso: string }) => void | Promise<void>;
  heartbeatIntervalMs?: number;
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
      // Logs should be written under the main repo root so `nibbler resume` can locate them
      // even when sessions run inside a separate worktree.
      env.NIBBLER_SESSION_LOG_PATH = joinPath(job.repoRoot, job.sessionLogPath);
    }
    env.NIBBLER_JOB_ID = job.jobId;
    env.NIBBLER_ROLE_ID = roleId;

    const handle = await this.runner.spawn(this.workspace, env, profileDir, {
      mode: mode === 'plan' ? 'plan' : 'normal',
      taskType: mode === 'plan' ? 'plan' : 'execute'
    });
    const safe = roleId.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
    const overlayRel = `.cursor/rules/20-role-${safe}.mdc`;
    const protocolRel = `.cursor/rules/00-nibbler-protocol.mdc`;
    const workflowRel = `.cursor/rules/10-nibbler-workflow.mdc`;

    const basePrompt = options.bootstrapPrompt ?? this.opts.bootstrapPrompt;
    const inlineRules = shouldInlineRules();
    const rulesHeader = `Read and follow:\n- @${overlayRel}\n- @${workflowRel}\n- @${protocolRel}`;
    let rulesPayload = `${rulesHeader}\n\nBegin your assigned work as described in the role overlay.\n`;

    if (inlineRules) {
      let overlayText = '';
      let protocolText = '';
      let workflowText = '';
      try {
        overlayText = await readFile(joinPath(this.workspace, overlayRel), 'utf8');
      } catch {
        // ignore
      }
      try {
        protocolText = await readFile(joinPath(this.workspace, protocolRel), 'utf8');
      } catch {
        // ignore
      }
      try {
        workflowText = await readFile(joinPath(this.workspace, workflowRel), 'utf8');
      } catch {
        // ignore
      }

      const inlinedRules = [
        '',
        '---',
        `BEGIN ${overlayRel}`,
        overlayText || '(missing)',
        `END ${overlayRel}`,
        '---',
        `BEGIN ${workflowRel}`,
        workflowText || '(missing)',
        `END ${workflowRel}`,
        '---',
        `BEGIN ${protocolRel}`,
        protocolText || '(missing)',
        `END ${protocolRel}`,
        '---',
        ''
      ].join('\n');
      rulesPayload = `${rulesHeader}\n${inlinedRules}`;
    }

    const prompt = basePrompt ? `${basePrompt}\n\n${rulesPayload}` : rulesPayload;

    await this.runner.send(handle, prompt);
    return handle;
  }

  async waitForCompletion(
    handle: SessionHandle,
    budget: BudgetSpec,
    options: WaitForCompletionOptions = {}
  ): Promise<SessionOutcome> {
    const inactivityTimeoutMs = this.opts.inactivityTimeoutMs ?? 60_000;
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 2_000;

    let inactive = false;
    let dead = false;
    let budgetExceeded = false;

    const emitHeartbeat = () => {
      if (!options.onHeartbeat) return;
      const nowIso = new Date().toISOString();
      const lastActivityAtIso = handle.lastActivityAtIso || nowIso;
      Promise.resolve(options.onHeartbeat({ nowIso, lastActivityAtIso })).catch(() => {
        // best-effort heartbeat callback
      });
    };
    let heartbeatTimer: NodeJS.Timeout | null = null;
    if (options.onHeartbeat) {
      emitHeartbeat();
      heartbeatTimer = setInterval(() => emitHeartbeat(), heartbeatIntervalMs);
    }

    const monitor = new SessionHealthMonitor(handle, budget, {
      inactivityTimeoutMs,
      pollIntervalMs: 1_000,
      isAlive: () => this.runner.isAlive(handle)
    });
    monitor.onInactive(() => {
      inactive = true;
      // In `--print` mode, the agent may hang without emitting events/output.
      // Stop the runner so stdout closes and the loop below can return.
      void this.runner.stop(handle);
    });
    monitor.onProcessDeath(() => {
      dead = true;
    });
    monitor.onBudgetExceeded(() => {
      budgetExceeded = true;
      void this.runner.stop(handle);
    });
    monitor.start();

    try {
      for await (const ev of this.runner.readEvents(handle)) {
        // Any parsed event is terminal for v1 orchestration.
        return { kind: 'event', event: ev };
      }

      if (budgetExceeded) return { kind: 'budget_exceeded' };
      if (inactive) return { kind: 'inactive_timeout' };
      if (dead) {
        return {
          kind: 'process_exit',
          exitCode: handle.exitCode ?? null,
          signal: handle.signal ?? 'dead'
        };
      }
      return {
        kind: 'process_exit',
        exitCode: handle.exitCode ?? null,
        signal: handle.signal ?? null
      };
    } finally {
      monitor.stop();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
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

function shouldInlineRules(): boolean {
  return process.env.NIBBLER_INLINE_RULES === '1';
}

