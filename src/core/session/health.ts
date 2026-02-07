import type { BudgetSpec } from '../contract/types.js';
import type { SessionHandle } from './types.js';

export interface SessionHealthMonitorOptions {
  pollIntervalMs?: number;
  inactivityTimeoutMs?: number;
  isAlive?: () => boolean;
}

export class SessionHealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private lastInactiveFiredAt = 0;
  private lastBudgetFiredAt = 0;

  private onBudgetExceededCb: (() => void) | null = null;
  private onInactiveCb: (() => void) | null = null;
  private onProcessDeathCb: (() => void) | null = null;

  constructor(
    private handle: SessionHandle,
    private budget: BudgetSpec,
    private opts: SessionHealthMonitorOptions = {}
  ) {}

  start(): void {
    const poll = this.opts.pollIntervalMs ?? 5_000;
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), poll);
  }

  onBudgetExceeded(cb: () => void): void {
    this.onBudgetExceededCb = cb;
  }

  onInactive(cb: () => void): void {
    this.onInactiveCb = cb;
  }

  onProcessDeath(cb: () => void): void {
    this.onProcessDeathCb = cb;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();

    const isAlive = this.opts.isAlive?.() ?? true;
    if (!isAlive) {
      this.onProcessDeathCb?.();
    }

    if (this.budget.maxTimeMs !== undefined) {
      const started = Date.parse(this.handle.startedAtIso);
      if (Number.isFinite(started) && now - started > this.budget.maxTimeMs) {
        // Avoid spamming the callback.
        if (now - this.lastBudgetFiredAt > 1_000) {
          this.lastBudgetFiredAt = now;
          this.onBudgetExceededCb?.();
        }
      }
    }

    const inactivityMs = this.opts.inactivityTimeoutMs ?? 60_000;
    const lastActivity = Date.parse(this.handle.lastActivityAtIso);
    const last = Number.isFinite(lastActivity) ? lastActivity : Date.parse(this.handle.startedAtIso);
    if (Number.isFinite(last) && now - last > inactivityMs) {
      if (now - this.lastInactiveFiredAt > 1_000) {
        this.lastInactiveFiredAt = now;
        this.onInactiveCb?.();
      }
    }
  }
}

