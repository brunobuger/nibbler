import { execa } from 'execa';
import picomatch from 'picomatch';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { DiffResult } from '../git/diff-parser.js';
import { isProtectedPath } from '../workspace/protected-paths.js';
import type { Contract, Criterion, GateDefinition, RoleDefinition } from './contract/types.js';
import type { JobState, SessionUsage } from './job/types.js';

export interface ScopeViolation {
  file: string;
  role: string;
  allowed: string[];
  reason: 'out_of_scope' | 'protected_path';
}

export interface ScopeResult {
  passed: boolean;
  violations: ScopeViolation[];
  diffSummary: DiffResult['summary'];
  checkedAtIso: string;
}

export function verifyScope(diff: DiffResult, roleDef: RoleDefinition, contract: Contract): ScopeResult {
  const violations: ScopeViolation[] = [];
  const inRole = picomatch(roleDef.scope, { dot: true });
  const sharedMatchers = contract.sharedScopes.map((s) => ({
    roles: s.roles,
    isMatch: picomatch(s.patterns.length ? s.patterns : ['**/*'], { dot: true })
  }));

  for (const f of diff.files) {
    const path = f.path;

    if (isProtectedPath(path)) {
      violations.push({
        file: path,
        role: roleDef.id,
        allowed: roleDef.scope,
        reason: 'protected_path'
      });
      continue;
    }

    if (inRole(path)) continue;

    const inShared = sharedMatchers.some(
      (s) => s.roles.includes(roleDef.id) && s.isMatch(path)
    );
    if (!inShared) {
      violations.push({
        file: path,
        role: roleDef.id,
        allowed: roleDef.scope,
        reason: 'out_of_scope'
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    diffSummary: diff.summary,
    checkedAtIso: new Date().toISOString()
  };
}

export interface CriterionResult {
  passed: boolean;
  message: string;
  evidence?: unknown;
}

export interface CompletionResult {
  passed: boolean;
  criteriaResults: CriterionResult[];
  checkedAtIso: string;
}

export async function verifyCompletion(role: string, job: JobState, contract: Contract): Promise<CompletionResult> {
  const phase = contract.phases.find((p) => p.id === job.currentPhaseId);
  if (!phase) {
    return {
      passed: false,
      criteriaResults: [{ passed: false, message: `Unknown phase '${job.currentPhaseId}'` }],
      checkedAtIso: new Date().toISOString()
    };
  }

  const results: CriterionResult[] = [];
  for (const c of phase.completionCriteria) {
    results.push(await evaluateCriterion(c, job));
  }

  return {
    passed: results.every((r) => r.passed),
    criteriaResults: results,
    checkedAtIso: new Date().toISOString()
  };
}

function jobWorkspaceRoot(job: JobState): string {
  // When a worktree is used, sessions and git operations run there, while evidence lives in repoRoot.
  // Completion criteria should be evaluated against the session workspace first.
  return job.worktreePath ?? job.repoRoot;
}

function jobSearchRoots(job: JobState): string[] {
  const primary = jobWorkspaceRoot(job);
  if (primary === job.repoRoot) return [primary];
  return [primary, job.repoRoot];
}

async function evaluateCriterion(c: Criterion, job: JobState): Promise<CriterionResult> {
  switch (c.type) {
    case 'artifact_exists': {
      const pat = substituteTokens(c.pattern, { id: job.jobId });
      const roots: string[] = [];

      // Planning artifacts are written under a job-local staging directory,
      // then materialized into `.nibbler/jobs/<id>/plan/` before verification.
      // Contracts often reference artifacts like `docs/plans/**` without the staging prefix,
      // so we search those plan roots transparently during planning verification.
      if (job.currentPhaseId === 'planning') {
        const ws = jobWorkspaceRoot(job);
        roots.push(join(ws, '.nibbler-staging', 'plan', job.jobId));
        roots.push(join(job.repoRoot, '.nibbler', 'jobs', job.jobId, 'plan'));
      }

      roots.push(...jobSearchRoots(job));

      // De-dup while preserving order.
      const uniqRoots = Array.from(new Set(roots));

      for (const root of uniqRoots) {
        const found = await globExists(root, pat);
        if (found) {
          return { passed: true, message: `artifact_exists(${pat})`, evidence: found };
        }
      }
      return { passed: false, message: `artifact_exists(${pat}) not found` };
    }
    case 'command_succeeds': {
      const r = await runCommand(jobWorkspaceRoot(job), c.command);
      return r.exitCode === 0
        ? { passed: true, message: `command_succeeds`, evidence: r }
        : { passed: false, message: `command_succeeds failed (exit=${r.exitCode})`, evidence: r };
    }
    case 'command_fails': {
      const r = await runCommand(jobWorkspaceRoot(job), c.command);
      return r.exitCode !== 0
        ? { passed: true, message: `command_fails`, evidence: r }
        : { passed: false, message: `command_fails expected non-zero`, evidence: r };
    }
    case 'diff_non_empty': {
      const changed = job.lastDiff?.files?.length ?? 0;
      return changed > 0
        ? { passed: true, message: `diff_non_empty`, evidence: { filesChanged: changed } }
        : { passed: false, message: `diff_non_empty: no diff available or empty` };
    }
    case 'diff_within_budget': {
      const diff = job.lastDiff;
      if (!diff) return { passed: false, message: 'diff_within_budget: no diff available' };
      const maxFiles = c.maxFiles ?? Number.POSITIVE_INFINITY;
      const maxLines = c.maxLines ?? Number.POSITIVE_INFINITY;
      const lines = diff.summary.additions + diff.summary.deletions;
      const ok = diff.summary.filesChanged <= maxFiles && lines <= maxLines;
      return ok
        ? { passed: true, message: 'diff_within_budget', evidence: { files: diff.summary.filesChanged, lines } }
        : {
            passed: false,
            message: `diff_within_budget exceeded (files=${diff.summary.filesChanged}/${maxFiles}, lines=${lines}/${maxLines})`,
            evidence: { files: diff.summary.filesChanged, lines, maxFiles, maxLines }
          };
    }
    case 'custom': {
      const r = await runCommand(jobWorkspaceRoot(job), c.script);
      return r.exitCode === 0
        ? { passed: true, message: `custom`, evidence: r }
        : { passed: false, message: `custom failed (exit=${r.exitCode})`, evidence: r };
    }
    default: {
      const _exhaustive: never = c;
      return { passed: false, message: `Unknown criterion ${(c as any).type}` };
    }
  }
}

function substituteTokens(value: string, tokens: Record<string, string>): string {
  return value.replaceAll(/<([a-zA-Z0-9_-]+)>/g, (_m, key: string) => tokens[key] ?? `<${key}>`);
}

async function runCommand(cwd: string, command: string): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const start = Date.now();
  try {
    const res = await execa(command, {
      cwd,
      shell: true,
      reject: false,
      stdout: 'pipe',
      stderr: 'pipe'
    });
    return { exitCode: res.exitCode ?? 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '', durationMs: Date.now() - start };
  } catch (err: any) {
    return { exitCode: 1, stdout: '', stderr: String(err?.message ?? err), durationMs: Date.now() - start };
  }
}

async function globExists(repoRoot: string, pattern: string): Promise<string[] | null> {
  try {
    const files = await listFilesRec(repoRoot, ['.git', 'node_modules']);
    const isMatch = picomatch(pattern, { dot: true });
    const matches = files.filter((p) => isMatch(p));
    return matches.length ? matches : null;
  } catch {
    return null;
  }
}

async function listFilesRec(root: string, ignoreDirs: string[]): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string) {
    const abs = join(root, rel);
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if (ignoreDirs.includes(e.name)) continue;
        await walk(join(rel, e.name));
      } else if (e.isFile()) {
        out.push(join(rel, e.name).replaceAll('\\', '/'));
      }
    }
  }
  await walk('');
  return out.filter((p) => p.length > 0);
}

export interface BudgetResult {
  passed: boolean;
  exceeded?: Record<string, { limit: number; actual: number }>;
  escalation?: string;
}

export function checkBudget(usage: SessionUsage, roleDef: RoleDefinition): BudgetResult {
  const exceeded: Record<string, { limit: number; actual: number }> = {};
  const b = roleDef.budget;

  if (b.maxIterations !== undefined && usage.iterations > b.maxIterations) {
    exceeded.iterations = { limit: b.maxIterations, actual: usage.iterations };
  }
  if (b.maxTimeMs !== undefined && usage.elapsedMs > b.maxTimeMs) {
    exceeded.timeMs = { limit: b.maxTimeMs, actual: usage.elapsedMs };
  }
  if (b.maxDiffLines !== undefined && usage.diffLines > b.maxDiffLines) {
    exceeded.diffLines = { limit: b.maxDiffLines, actual: usage.diffLines };
  }

  if (Object.keys(exceeded).length) {
    return { passed: false, exceeded, escalation: b.exhaustionEscalation };
  }
  return { passed: true };
}

export function checkGlobalBudget(job: JobState, contract: Contract): BudgetResult {
  const exceeded: Record<string, { limit: number; actual: number }> = {};
  const b = contract.globalLifetime;
  const started = Date.parse(job.startedAtIso);
  const elapsed = Number.isFinite(started) ? Date.now() - started : 0;
  if (b.maxTimeMs !== undefined && elapsed > b.maxTimeMs) {
    exceeded.timeMs = { limit: b.maxTimeMs, actual: elapsed };
  }
  if (Object.keys(exceeded).length) return { passed: false, exceeded, escalation: b.exhaustionEscalation };
  return { passed: true };
}

export function shouldEnforceGate(transition: string, contract: Contract): GateDefinition | null {
  return contract.gates.find((g) => g.trigger === transition) ?? null;
}

