import picomatch from 'picomatch';

import type { Contract, RoleDefinition, SharedScopeDeclaration } from '../contract/types.js';
import type { JobState } from '../job/types.js';

export interface ScopeViolationOwnerHint {
  file: string;
  owners: string[];
}

export function findOwnerRolesForPath(path: string, contract: Contract, opts: { excludeRoleId?: string } = {}): string[] {
  const owners: string[] = [];
  for (const r of contract.roles) {
    if (opts.excludeRoleId && r.id === opts.excludeRoleId) continue;
    const isMatch = picomatch(r.scope, { dot: true });
    if (isMatch(path)) owners.push(r.id);
  }
  return owners;
}

export function isStructuralOutOfScopeViolation(
  violatingPaths: string[],
  roleId: string,
  contract: Contract,
  opts: { manyThreshold?: number } = {}
): { structural: boolean; ownerHints: ScopeViolationOwnerHint[] } {
  const manyThreshold = opts.manyThreshold ?? 3;
  const ownerHints: ScopeViolationOwnerHint[] = [];

  if (violatingPaths.length >= manyThreshold) return { structural: true, ownerHints };

  for (const p of violatingPaths) {
    const owners = findOwnerRolesForPath(p, contract, { excludeRoleId: roleId });
    if (owners.length > 0) ownerHints.push({ file: p, owners });
  }
  return { structural: ownerHints.length > 0, ownerHints };
}

function activeOverridesForRole(job: JobState, roleId: string, opts: { phaseId: string; attempt: number }): NonNullable<JobState['scopeOverridesByRole']>[string] {
  const all = job.scopeOverridesByRole?.[roleId] ?? [];
  return all.filter((o) => {
    if (o.phaseId !== opts.phaseId) return false;
    if (o.expiresAfterAttempt !== undefined && opts.attempt > o.expiresAfterAttempt) return false;
    return true;
  });
}

export function buildEffectiveRoleDefinition(role: RoleDefinition, job: JobState, opts: { phaseId: string; attempt: number }): RoleDefinition {
  const overrides = activeOverridesForRole(job, role.id, opts);
  const extra = overrides.filter((o) => o.kind === 'extra_scope').flatMap((o) => o.patterns);
  if (extra.length === 0) return role;
  return { ...role, scope: Array.from(new Set([...role.scope, ...extra])) };
}

export function buildEffectiveSharedScopes(contract: Contract, job: JobState, opts: { phaseId: string; attemptByRole: Record<string, number> }): SharedScopeDeclaration[] {
  const base = contract.sharedScopes ?? [];
  const overrides = job.scopeOverridesByRole ?? {};
  const out: SharedScopeDeclaration[] = [...base];

  for (const [roleId, items] of Object.entries(overrides)) {
    const attempt = opts.attemptByRole[roleId] ?? 1;
    for (const o of items) {
      if (o.kind !== 'shared_scope') continue;
      if (o.phaseId !== opts.phaseId) continue;
      if (o.expiresAfterAttempt !== undefined && attempt > o.expiresAfterAttempt) continue;

      const owner = o.ownerRoleId ?? 'architect';
      if (owner === roleId) continue;
      out.push({
        roles: [roleId, owner],
        patterns: o.patterns
      });
    }
  }

  return out;
}

export function buildEffectiveContractForSession(
  contract: Contract,
  job: JobState,
  roleId: string,
  opts: { phaseId: string; attempt: number }
): Contract {
  const roles = contract.roles.map((r) => (r.id === roleId ? buildEffectiveRoleDefinition(r, job, { phaseId: opts.phaseId, attempt: opts.attempt }) : r));
  const attemptByRole: Record<string, number> = {};
  for (const r of contract.roles) attemptByRole[r.id] = job.attemptsByRole?.[r.id] ?? (r.id === roleId ? opts.attempt : 1);

  return {
    ...contract,
    roles,
    sharedScopes: buildEffectiveSharedScopes(contract, job, { phaseId: opts.phaseId, attemptByRole }),
  };
}

