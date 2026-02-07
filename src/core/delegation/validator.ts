import picomatch from 'picomatch';

import type { Contract } from '../contract/types.js';
import { isProtectedPath } from '../../workspace/protected-paths.js';
import type { DelegationPlan } from './types.js';

export interface DelegationValidationError {
  rule: 'delegation';
  message: string;
  details?: unknown;
}

export function validateDelegation(plan: DelegationPlan, contract: Contract): DelegationValidationError[] {
  const errors: DelegationValidationError[] = [];

  if (!plan.tasks || plan.tasks.length === 0) {
    errors.push({ rule: 'delegation', message: 'Delegation plan must contain at least one task' });
    return errors;
  }

  const roleIds = new Set(contract.roles.map((r) => r.id));
  const byTaskId = new Map<string, { roleId: string; dependsOn: string[] }>();

  for (const t of plan.tasks) {
    if (!roleIds.has(t.roleId)) {
      errors.push({ rule: 'delegation', message: `Unknown roleId '${t.roleId}' in task '${t.taskId}'` });
    }

    if (!t.description || t.description.trim().length === 0) {
      errors.push({ rule: 'delegation', message: `Task '${t.taskId}' must have a non-empty description` });
    }

    if (byTaskId.has(t.taskId)) {
      errors.push({ rule: 'delegation', message: `Duplicate taskId '${t.taskId}'` });
      continue;
    }

    const role = contract.roles.find((r) => r.id === t.roleId);
    const inRole = role ? picomatch(role.scope, { dot: true }) : null;
    const sharedMatchers = contract.sharedScopes
      .filter((s) => s.roles.includes(t.roleId))
      .map((s) => picomatch(s.patterns.length ? s.patterns : ['**/*'], { dot: true }));

    for (const hint of t.scopeHints ?? []) {
      if (isProtectedPath(hint)) {
        errors.push({
          rule: 'delegation',
          message: `Task '${t.taskId}' scopeHints includes protected path '${hint}'`,
          details: { taskId: t.taskId, hint }
        });
        continue;
      }

      const ok = inRole ? inRole(hint) : false;
      const inShared = sharedMatchers.some((m) => m(hint));
      if (!ok && !inShared) {
        errors.push({
          rule: 'delegation',
          message: `Task '${t.taskId}' scopeHints '${hint}' is not within role '${t.roleId}' scope (or shared scope)`,
          details: { taskId: t.taskId, roleId: t.roleId, hint }
        });
      }
    }

    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    byTaskId.set(t.taskId, { roleId: t.roleId, dependsOn: deps });
  }

  // dependsOn references must exist
  for (const [taskId, info] of byTaskId.entries()) {
    for (const dep of info.dependsOn) {
      if (!byTaskId.has(dep)) {
        errors.push({
          rule: 'delegation',
          message: `Task '${taskId}' dependsOn unknown taskId '${dep}'`,
          details: { taskId, dependsOn: dep }
        });
      }
    }
  }

  // Cycle detection
  errors.push(...detectDependencyCycles(byTaskId));

  return errors;
}

function detectDependencyCycles(
  byTaskId: Map<string, { roleId: string; dependsOn: string[] }>
): DelegationValidationError[] {
  const errors: DelegationValidationError[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const stack: string[] = [];

  const dfs = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      const cycle = cycleStart >= 0 ? stack.slice(cycleStart).concat(id) : [id];
      errors.push({ rule: 'delegation', message: `Delegation plan contains a dependency cycle: ${cycle.join(' -> ')}` });
      return;
    }
    visiting.add(id);
    stack.push(id);
    const deps = byTaskId.get(id)?.dependsOn ?? [];
    for (const dep of deps) dfs(dep);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of byTaskId.keys()) dfs(id);

  return errors;
}

