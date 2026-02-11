export type NibblerEvent =
  | { type: 'PHASE_COMPLETE'; summary?: string }
  | { type: 'NEEDS_ESCALATION'; reason?: string; context?: unknown }
  | { type: 'EXCEPTION'; reason?: string; impact?: string }
  | { type: 'QUESTIONS'; questions: string[] }
  | { type: 'QUESTION'; text: string };

export interface RunnerCapabilities {
  interactive: boolean;
  permissions: boolean;
  streamJson: boolean;
}

export interface SessionHandle {
  id: string;
  pid?: number;
  startedAtIso: string;
  lastActivityAtIso: string;
  exitCode?: number | null;
  signal?: string | null;
}

export type SessionOutcome =
  | { kind: 'event'; event: NibblerEvent }
  | { kind: 'budget_exceeded' }
  | { kind: 'inactive_timeout' }
  | { kind: 'process_exit'; exitCode: number | null; signal: string | null };

