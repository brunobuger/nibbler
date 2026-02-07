import { z } from 'zod';

export const TimestampIso = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'timestamp must be ISO datetime' });

export const LedgerEnvelope = z.object({
  seq: z.number().int().positive(),
  timestamp: TimestampIso,
  type: z.string(),
  data: z.unknown()
});

// Canonical event types (ARCHITECTURE.md §11.3). This list can grow over time.
export const LedgerEventType = z.enum([
  'job_created',
  'job_completed',
  'job_failed',
  'job_cancelled',
  'job_budget_exceeded',
  'phase_started',
  'phase_completed',
  'session_start',
  'session_complete',
  'session_reverted',
  'session_escalated',
  'scope_check',
  'completion_check',
  'command_executed',
  'gate_presented',
  'gate_resolved',
  'escalation',
  'architect_resolution',
  // Scope exception decision flow (job-local, engine-managed).
  'scope_exception_requested',
  'scope_exception_granted',
  'scope_exception_denied'
]);

export const JobCreatedEvent = z.object({
  seq: z.number().int().positive(),
  timestamp: TimestampIso,
  type: z.literal('job_created'),
  data: z.object({
    jobId: z.string(),
    branch: z.string().optional(),
    repoRoot: z.string().optional()
  })
});

export const SessionStartEvent = z.object({
  seq: z.number().int().positive(),
  timestamp: TimestampIso,
  type: z.literal('session_start'),
  data: z.object({
    role: z.string(),
    commit: z.string().optional()
  })
});

export const GateResolvedEvent = z.object({
  seq: z.number().int().positive(),
  timestamp: TimestampIso,
  type: z.literal('gate_resolved'),
  data: z.object({
    gateId: z.string(),
    audience: z.string(),
    decision: z.enum(['approve', 'reject', 'exception']).optional(),
    notes: z.string().optional()
  })
});

// For now we accept an open union of a few typed events + a generic envelope.
export const LedgerEntrySchema = z.union([JobCreatedEvent, SessionStartEvent, GateResolvedEvent, LedgerEnvelope]);

export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export type LedgerEntryInput = Omit<LedgerEntry, 'seq' | 'timestamp'> & {
  seq?: never;
  timestamp?: never;
};

