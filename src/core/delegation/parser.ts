import { readYaml } from '../../utils/fs.js';
import { DelegationPlan } from './types.js';
import type { DelegationPlan as DelegationPlanT } from './types.js';

export async function readDelegationPlanYaml(path: string): Promise<DelegationPlanT> {
  const raw = await readYaml<unknown>(path);
  return DelegationPlan.parse(raw);
}

