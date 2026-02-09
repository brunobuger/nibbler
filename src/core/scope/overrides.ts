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
  const validRoleIds = new Set(contract.roles.map((r) => r.id));

  for (const [roleId, items] of Object.entries(overrides)) {
    const attempt = opts.attemptByRole[roleId] ?? 1;
    for (const o of items) {
      if (o.kind !== 'shared_scope') continue;
      if (o.phaseId !== opts.phaseId) continue;
      if (o.expiresAfterAttempt !== undefined && attempt > o.expiresAfterAttempt) continue;

      let owner = o.ownerRoleId ?? 'architect';
      if (!validRoleIds.has(owner)) owner = 'architect';
      if (owner === roleId) {
        // If the Architect decision set `ownerRoleId` to the same role, still grant access by sharing with Architect.
        owner = 'architect';
      }
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
  const nextLike = isNextJsLikeContract(contract);
  const roles = contract.roles.map((r) => {
    const effective = r.id === roleId ? buildEffectiveRoleDefinition(r, job, { phaseId: opts.phaseId, attempt: opts.attempt }) : r;
    return applyEngineDefaultRoleScope(effective, { nextLike });
  });
  const attemptByRole: Record<string, number> = {};
  for (const r of contract.roles) attemptByRole[r.id] = job.attemptsByRole?.[r.id] ?? (r.id === roleId ? opts.attempt : 1);

  return {
    ...contract,
    roles,
    sharedScopes: applyEngineDefaultSharedScopes(
      buildEffectiveSharedScopes(contract, job, { phaseId: opts.phaseId, attemptByRole }),
      contract
    ),
  };
}

function applyEngineDefaultRoleScope(role: RoleDefinition, opts: { nextLike: boolean }): RoleDefinition {
  // Next.js scaffolding commonly generates `next-env.d.ts` at repo root.
  if (opts.nextLike && role.id === 'frontend' && !role.scope.includes('next-env.d.ts')) {
    return { ...role, scope: [...role.scope, 'next-env.d.ts'] };
  }
  return role;
}

function applyEngineDefaultSharedScopes(sharedScopes: SharedScopeDeclaration[], contract: Contract): SharedScopeDeclaration[] {
  // `.gitignore` is a common repo-hygiene file needed during scaffolding. Treat it as globally shared.
  const hasGitignore = sharedScopes.some((s) => (s.patterns ?? []).includes('.gitignore'));
  if (hasGitignore) return sharedScopes;

  const roleIds = contract.roles.map((r) => r.id);
  return [
    ...sharedScopes,
    {
      roles: roleIds,
      patterns: ['.gitignore']
    }
  ];
}

function isNextJsLikeContract(contract: Contract): boolean {
  const pats: string[] = [];
  for (const r of contract.roles) pats.push(...(r.scope ?? []));
  for (const s of contract.sharedScopes ?? []) pats.push(...(s.patterns ?? []));
  return pats.some((p) => p === 'next.config.*' || p.startsWith('next.config.'));
}

