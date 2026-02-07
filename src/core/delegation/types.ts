import { z } from 'zod';

export const DelegationTask = z.object({
  taskId: z.string().min(1),
  roleId: z.string().min(1),
  description: z.string().min(1),
  scopeHints: z.array(z.string().min(1)).default([]),
  dependsOn: z.array(z.string().min(1)).optional(),
  priority: z.number().int().default(0)
});

export const DelegationPlan = z.object({
  version: z.number().int().positive().default(1),
  tasks: z.array(DelegationTask).min(1)
});

export type DelegationTask = z.infer<typeof DelegationTask>;
export type DelegationPlan = z.infer<typeof DelegationPlan>;

