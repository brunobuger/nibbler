import type { Contract } from './types.js';

/**
 * Select a reasonable start phase for recovery/fix flows.
 * Prefer planning (so the Architect can re-plan), otherwise start from execution.
 */
export function pickFixStartPhase(contract: Contract): string {
  const ids = new Set(contract.phases.map((p) => p.id));
  if (ids.has('planning')) return 'planning';
  if (ids.has('execution')) return 'execution';
  return contract.phases[0]?.id ?? 'start';
}

