import { z } from 'zod';

export const EvidenceMeta = z.object({
  role: z.string(),
  timestamp: z.string(),
  seq: z.number().int().positive()
});

export const CommandEvidenceMeta = EvidenceMeta.extend({
  command: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative()
});

export type EvidenceMeta = z.infer<typeof EvidenceMeta>;
export type CommandEvidenceMeta = z.infer<typeof CommandEvidenceMeta>;

