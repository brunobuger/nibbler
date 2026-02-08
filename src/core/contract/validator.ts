import picomatch from 'picomatch';

import { isProtectedPath, PROTECTED_PATH_PATTERNS } from '../../workspace/protected-paths.js';
import type { Contract, GateDefinition, PhaseDefinition, RoleDefinition } from './types.js';

export interface ValidationError {
  rule: string;
  message: string;
  details?: unknown;
}

export function validateContract(contract: Contract): ValidationError[] {
  const errors: ValidationError[] = [];

  // Domain 1 — Identity & Scope
  for (const role of contract.roles) {
    if (!role.scope || role.scope.length === 0) {
      errors.push({ rule: '1.1', message: `Rule 1.1: Role '${role.id}' has no scope` });
    }
    if (!role.budget) {
      errors.push({ rule: '4.1', message: `Rule 4.1: Role '${role.id}' has no budget` });
    }
    if (!role.verificationMethod) {
      errors.push({
        rule: '3.1',
        message: `Rule 3.1: Role '${role.id}' has no verification method`
      });
    }
    if (!role.budget?.exhaustionEscalation) {
      errors.push({
        rule: '4.2',
        message: `Rule 4.2: Role '${role.id}' budget has no escalation path on exhaustion`
      });
    }
  }

  // Protected paths excluded (Rule 5.3) — reject any scope that matches protected paths.
  for (const role of contract.roles) {
    for (const pattern of role.scope) {
      for (const protectedPath of PROTECTED_PATH_PATTERNS) {
        // If a pattern can match a protected path, it's invalid.
        // For glob patterns, we test by checking whether the pattern matches the literal protected path string.
        const matcher = picomatch(pattern, { dot: true });
        if (matcher(protectedPath.replaceAll('**', 'x'))) {
          errors.push({
            rule: '5.3',
            message: `Rule 5.3: Role '${role.id}' scope pattern '${pattern}' may include protected path '${protectedPath}'`
          });
        }
      }
      if (isProtectedPath(pattern)) {
        errors.push({
          rule: '5.3',
          message: `Rule 5.3: Role '${role.id}' scope includes protected path pattern '${pattern}'`
        });
      }
    }
  }

  // Scope overlap detection (Rule 1.3) — heuristic overlap check.
  for (let i = 0; i < contract.roles.length; i++) {
    for (let j = i + 1; j < contract.roles.length; j++) {
      const a = contract.roles[i];
      const b = contract.roles[j];
      if (!rolesMayOverlap(a, b)) continue;
      if (!hasSharedScope(contract, a.id, b.id)) {
        errors.push({
          rule: '1.3',
          message: `Rule 1.3: Undeclared overlap between '${a.id}' and '${b.id}'`,
          details: { a: a.scope, b: b.scope }
        });
      }
    }
  }

  // Domain 2 — Artifact Flow (Rule 2.1)
  for (const phase of contract.phases) {
    if (!phase.inputBoundaries || phase.inputBoundaries.length === 0) {
      errors.push({ rule: '2.1', message: `Rule 2.1: Phase '${phase.id}' has no input boundaries` });
    }
    if (!phase.outputBoundaries || phase.outputBoundaries.length === 0) {
      errors.push({ rule: '2.1', message: `Rule 2.1: Phase '${phase.id}' has no output boundaries` });
    }
    if (!phase.completionCriteria || phase.completionCriteria.length === 0) {
      errors.push({
        rule: '3.1',
        message: `Rule 3.1: Phase '${phase.id}' has no completion criteria`
      });
    }
  }

  // Dependency satisfaction (Rule 2.2).
  //
  // IMPORTANT: A phase may legitimately consume pre-existing repo artifacts that are not produced by any
  // phase output boundary (e.g. `vision.md`/`architecture.md` created during `nibbler init`, or an existing `src/**` tree).
  //
  // For v1 we only enforce 2.2 for inputs that look like engine-managed job artifacts (e.g. `.nibbler/jobs/<id>/...`),
  // which cannot be pre-existing outside of a job run. This avoids rejecting valid contracts that start at planning.
  const outputs = contract.phases.flatMap((p) => p.outputBoundaries.map((pat) => ({ phase: p.id, pat })));
  for (const phase of contract.phases) {
    for (const input of phase.inputBoundaries) {
      const ok = outputs.some((o) => patternsMayOverlap(input, o.pat));
      if (!ok && shouldRequireUpstreamProducer(input)) {
        errors.push({
          rule: '2.2',
          message: `Rule 2.2: Phase '${phase.id}' requires input '${input}' but no phase output boundary appears to produce it`
        });
      }
    }
  }

  // Domain 3 — Transitions & Gating
  errors.push(...validatePhaseGraph(contract.phases));
  errors.push(...validateGates(contract.gates));

  // Domain 4 — Budgets & Termination
  if (!contract.globalLifetime) {
    errors.push({ rule: '4.3', message: 'Rule 4.3: No global job lifetime defined' });
  }

  // Domain 5 — PO gate existence (Rule 5.5)
  if (!contract.gates.some((g) => g.audience === 'PO')) {
    errors.push({ rule: '5.5', message: 'Rule 5.5: Contract has no PO gates' });
  }

  return errors;
}

function hasSharedScope(contract: Contract, roleA: string, roleB: string): boolean {
  return contract.sharedScopes.some((s) => s.roles.includes(roleA) && s.roles.includes(roleB));
}

function rolesMayOverlap(a: RoleDefinition, b: RoleDefinition): boolean {
  for (const pa of a.scope) for (const pb of b.scope) if (patternsMayOverlap(pa, pb)) return true;
  return false;
}

/**
 * Heuristic overlap: compare static prefixes up to first glob meta, and treat broad patterns as overlapping.
 * This is intentionally conservative for v1.
 */
function patternsMayOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const ap = staticPrefix(a);
  const bp = staticPrefix(b);

  // Broad patterns are those without a meaningful prefix (e.g. '**/*', '*', or globs starting immediately).
  const aBroad = a === '**/*' || a === '*' || ap.length === 0;
  const bBroad = b === '**/*' || b === '*' || bp.length === 0;
  if (aBroad && bBroad) return true;
  if (!ap || !bp) return aBroad || bBroad;
  return ap.startsWith(bp) || bp.startsWith(ap);
}

function staticPrefix(pat: string): string {
  // Stop at first glob metachar.
  const m = /[*?[\]{}()!+@]/.exec(pat);
  const idx = m ? m.index : pat.length;
  const prefix = pat.slice(0, idx);
  return prefix.replace(/\/+$/, '');
}

function shouldRequireUpstreamProducer(inputBoundary: string): boolean {
  const p = inputBoundary.trim();
  if (!p) return false;
  // Job-scoped placeholders / paths are always engine-produced.
  if (p.includes('<id>') || p.includes('<job-id>') || p.includes('<jobId>')) return true;
  // Anything under .nibbler/ is engine-managed state, not pre-existing repo content.
  return p.startsWith('.nibbler/') || p.startsWith('.nibbler\\');
}

function validateGates(gates: GateDefinition[]): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const gate of gates) {
    if (!gate.outcomes || typeof gate.outcomes !== 'object') {
      errors.push({ rule: '3.4', message: `Rule 3.4: Gate '${gate.id}' has no outcomes` });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(gate.outcomes, 'approve')) {
      errors.push({ rule: '3.4', message: `Rule 3.4: Gate '${gate.id}' has no approve outcome` });
    }
    if (!Object.prototype.hasOwnProperty.call(gate.outcomes, 'reject')) {
      errors.push({ rule: '3.4', message: `Rule 3.4: Gate '${gate.id}' has no reject outcome` });
    }
  }
  return errors;
}

function validatePhaseGraph(phases: PhaseDefinition[]): ValidationError[] {
  const errors: ValidationError[] = [];

  const byId = new Map(phases.map((p) => [p.id, p] as const));
  const indegree = new Map<string, number>(phases.map((p) => [p.id, 0]));
  const edges = new Map<string, string[]>();

  for (const p of phases) edges.set(p.id, []);
  for (const p of phases) {
    for (const s of p.successors ?? []) {
      if (!byId.has(s.next)) {
        errors.push({
          rule: '3.3',
          message: `Rule 3.3: Phase '${p.id}' has successor '${s.next}' which is not a known phase`
        });
        continue;
      }
      edges.get(p.id)!.push(s.next);
      indegree.set(s.next, (indegree.get(s.next) ?? 0) + 1);
    }
  }

  // Find start candidates (zero indegree).
  const queue: string[] = [];
  for (const [id, deg] of indegree.entries()) if (deg === 0) queue.push(id);
  if (queue.length === 0 && phases.length > 0) {
    errors.push({ rule: '3.3', message: 'Rule 3.3: Phase graph has no start node (cycle suspected)' });
    return errors;
  }

  // Kahn's algorithm for DAG detection.
  const topo: string[] = [];
  const indegreeWork = new Map(indegree);
  const q = [...queue];
  while (q.length) {
    const id = q.shift()!;
    topo.push(id);
    for (const to of edges.get(id) ?? []) {
      indegreeWork.set(to, (indegreeWork.get(to) ?? 0) - 1);
      if (indegreeWork.get(to) === 0) q.push(to);
    }
  }

  if (topo.length !== phases.length) {
    errors.push({ rule: '3.3', message: 'Rule 3.3: Phase graph contains a cycle' });
  }

  // Reachable terminal state (Rule 3.3)
  const start = queue[0];
  const reachable = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const to of edges.get(cur) ?? []) stack.push(to);
  }

  const terminals = phases.filter((p) => p.isTerminal === true).map((p) => p.id);
  if (terminals.length === 0) {
    errors.push({ rule: '3.3', message: 'Rule 3.3: Phase graph has no terminal phase (isTerminal=true)' });
  } else if (!terminals.some((t) => reachable.has(t))) {
    errors.push({ rule: '3.3', message: 'Rule 3.3: No reachable terminal state from start phase' });
  }

  return errors;
}

