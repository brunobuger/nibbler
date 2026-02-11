import { execa } from 'execa';
import picomatch from 'picomatch';
import { readdir, readFile } from 'node:fs/promises';
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
  // authority.allowedPaths grants additional write access (e.g. scaffold/bootstrap work).
  // The init prompt instructs contracts to use allowedPaths for files outside the role's
  // normal scope, so the engine must respect them during verification.
  const allowedPaths = roleDef.authority.allowedPaths ?? [];
  const inAllowed = allowedPaths.length > 0 ? picomatch(allowedPaths, { dot: true }) : null;
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
    if (inAllowed?.(path)) continue;

    const inShared = sharedMatchers.some(
      (s) => s.roles.includes(roleDef.id) && s.isMatch(path)
    );
    if (!inShared) {
      violations.push({
        file: path,
        role: roleDef.id,
        allowed: [...roleDef.scope, ...allowedPaths],
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
  const delegatedTasks = (job.delegationPlan?.tasks ?? []).filter((t) => t.roleId === role);
  for (const c of phase.completionCriteria) {
    const deferDecision = shouldDeferCriterionForRole(c, role, contract, delegatedTasks);
    if (deferDecision.defer) {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/25aab501-c72a-437e-b834-e0245fea140d',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'build-e2e-retry',hypothesisId:'H6',location:'src/core/policy-engine.ts:verifyCompletion',message:'deferred completion criterion outside role scope',data:{phaseId:job.currentPhaseId,roleId:role,criterionType:c.type,criterionPathHints:deferDecision.criterionPathHints,roleWritablePatterns:deferDecision.roleWritablePatterns,delegatedScopeHints:deferDecision.delegatedScopeHints},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      results.push({
        passed: true,
        message: `${c.type} deferred for role '${role}' (outside role scope)`,
        evidence: {
          deferred: true,
          reason: deferDecision.reason,
          criterionPathHints: deferDecision.criterionPathHints,
          roleWritablePatterns: deferDecision.roleWritablePatterns,
          delegatedScopeHints: deferDecision.delegatedScopeHints
        }
      });
      continue;
    }
    results.push(await evaluateCriterion(c, job, { roleId: role }));
  }

  // Engine-level completion extension: when delegation exists, verify task coverage deterministically.
  // This prevents "diff_non_empty" from succeeding with unrelated changes.
  const hasDelegationCriterion = phase.completionCriteria.some((c) => c.type === 'delegation_coverage');
  if (!hasDelegationCriterion && delegatedTasks.length > 0) {
    results.push(await evaluateCriterion({ type: 'delegation_coverage' } as any, job, { roleId: role }));
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

async function evaluateCriterion(c: Criterion, job: JobState, ctx: { roleId: string }): Promise<CriterionResult> {
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
    case 'markdown_has_headings': {
      const relPath = substituteTokens(c.path, { id: job.jobId });
      const roots = jobSearchRoots(job);

      // Find the file in the first root where it exists.
      let content: string | null = null;
      let foundAt: string | null = null;
      for (const root of roots) {
        try {
          const abs = join(root, relPath);
          content = await readFile(abs, 'utf8');
          foundAt = abs;
          break;
        } catch {
          // keep looking
        }
      }

      if (content == null) {
        return {
          passed: false,
          message: `markdown_has_headings(${relPath}): file not found`,
          evidence: { path: relPath, rootsTried: roots }
        };
      }

      const headings = extractMarkdownHeadings(content);
      const foundNorm = Array.from(new Set(headings.map((h) => normalizeHeading(h))));

      const required = c.requiredHeadings;
      const requiredNorm = required.map((h) => normalizeHeading(h));

      const missing: string[] = [];
      for (let i = 0; i < requiredNorm.length; i++) {
        const req = requiredNorm[i]!;
        const ok = foundNorm.some((f) => f === req || f.startsWith(req));
        if (!ok) missing.push(required[i]!);
      }

      const len = content.length;
      const minChars = c.minChars ?? 0;
      const lenOk = minChars > 0 ? len >= minChars : true;

      const passed = missing.length === 0 && lenOk;
      return {
        passed,
        message: passed
          ? `markdown_has_headings(${relPath})`
          : `markdown_has_headings(${relPath}) failed (${missing.length ? `missing headings: ${missing.join(', ')}` : ''}${missing.length && !lenOk ? '; ' : ''}${!lenOk ? `minChars ${len}/${minChars}` : ''})`,
        evidence: {
          path: relPath,
          foundAt,
          requiredHeadings: required,
          minChars: c.minChars,
          fileLengthChars: len,
          extractedHeadings: headings,
          missingHeadings: missing
        }
      };
    }
    case 'command_succeeds': {
      const r = await runCommand(jobWorkspaceRoot(job), c.command);
      return r.exitCode === 0
        ? { passed: true, message: `command_succeeds`, evidence: r }
        : { passed: false, message: `command_succeeds failed (exit=${r.exitCode})`, evidence: r };
    }
    case 'local_http_smoke': {
      const timeoutMs = c.timeoutMs ?? 60_000;
      const requestTimeoutMs = c.requestTimeoutMs ?? 5_000;
      const startedAt = Date.now();

      const cwd = jobWorkspaceRoot(job);
      const startCommand = c.startCommand;
      const url = c.url;
      let urlUsed = url;
      const candidateLastTriedAtMs = new Map<string, number>();
      const probeAttempts: Array<{
        kind: 'primary' | 'candidate';
        url: string;
        ok: boolean;
        status?: number;
        error?: string;
      }> = [];

      // Keep a bounded tail of logs for evidence (avoid massive output).
      const MAX_LOG_CHARS = 64_000;
      let stdoutTail = '';
      let stderrTail = '';
      const appendTail = (current: string, chunk: string) => {
        const next = (current + chunk).slice(-MAX_LOG_CHARS);
        return next;
      };

      // Mitigate EMFILE (too many open files) in dev server file watchers.
      // Dev servers like Vite use chokidar to watch files. In nibbler worktrees with many
      // directories (.nibbler/, .nibbler-staging/, node_modules/), native fs.watch() can
      // exhaust inotify limits. Defenses:
      // 1. CHOKIDAR_USEPOLLING=1 — tells chokidar v2/v3 to use polling instead of inotify
      // 2. The startCommand should ideally specify a framework config that limits the root
      //    (e.g. `npx vite --config frontend/vite.config.ts` with `root: 'frontend'`).
      const smokeEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        CHOKIDAR_USEPOLLING: '1',
        CHOKIDAR_INTERVAL: '5000',
      };

      const child = execa(startCommand, {
        cwd,
        shell: true,
        reject: false,
        stdout: 'pipe',
        stderr: 'pipe',
        env: smokeEnv,
        killSignal: 'SIGTERM',
        forceKillAfterDelay: 2_000,
        detached: true,
      });

      child.stdout?.on('data', (d: Buffer) => {
        stdoutTail = appendTail(stdoutTail, d.toString('utf8'));
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderrTail = appendTail(stderrTail, d.toString('utf8'));
      });

      let ok = false;
      let lastStatus: number | null = null;
      let lastError: string | null = null;
      let responseSnippet: string | null = null;

      try {
        while (Date.now() - startedAt < timeoutMs) {
          // If the process already exited, stop waiting.
          if (child.exitCode != null) break;

          // Try the requested URL first.
          const res = await tryFetchOk(url, requestTimeoutMs);
          if (probeAttempts.length < 40) {
            probeAttempts.push({
              kind: 'primary',
              url,
              ok: res.ok,
              status: res.status,
              error: res.error
            });
          }
          if (res.ok) {
            ok = true;
            lastStatus = res.status ?? null;
            responseSnippet = res.bodySnippet ?? null;
            break;
          }

          lastStatus = res.status ?? null;
          lastError = res.error ?? null;

          // Port conflicts are common (especially on localhost:3000). Some dev servers (notably Next.js)
          // automatically select another port and print the final URL to stdout/stderr.
          // As soon as we discover a different local URL, probe it while the dev server is still running.
          const combined = `${stdoutTail}\n${stderrTail}`;
          const candidates = expandLocalUrlCandidates(extractLocalUrlsFromLogs(combined));
          for (const candidate of candidates) {
            if (!candidate || candidate === url) continue;
            const lastTriedAt = candidateLastTriedAtMs.get(candidate) ?? 0;
            // Avoid hammering the same URL too frequently, but DO retry:
            // some servers print the chosen URL before they are actually ready.
            if (Date.now() - lastTriedAt < 1500) continue;
            candidateLastTriedAtMs.set(candidate, Date.now());

            const alt = await tryFetchOk(candidate, requestTimeoutMs);
            if (probeAttempts.length < 40) {
              probeAttempts.push({
                kind: 'candidate',
                url: candidate,
                ok: alt.ok,
                status: alt.status,
                error: alt.error
              });
            }
            if (alt.ok) {
              ok = true;
              urlUsed = candidate;
              lastStatus = alt.status ?? null;
              responseSnippet = alt.bodySnippet ?? null;
              lastError = null;
              break;
            }
            // Keep evidence aligned with what was most recently observed, even when candidate probing fails.
            urlUsed = candidate;
            lastStatus = alt.status ?? null;
            responseSnippet = alt.bodySnippet ?? null;
            lastError = alt.error ?? null;
          }

          if (ok) break;
          await sleep(500);
        }
      } finally {
        // Always terminate the process (best-effort).
        await terminateProcess(child).catch(() => {});
      }

      // If HTTP succeeded, give the dev server a brief settle period so that module
      // resolution / dependency optimization errors have time to surface in stdout/stderr.
      if (ok) {
        await sleep(2000);
      }

      const durationMs = Date.now() - startedAt;

      // Detect fatal module-resolution errors even when the HTML shell returns HTTP 200.
      // Dev servers often serve the HTML shell immediately but log dependency resolution
      // errors asynchronously.  These patterns are generic across bundlers (Vite, Webpack,
      // Rollup, esbuild, etc.).
      const FATAL_PATTERNS: RegExp[] = [
        /dependencies are imported but could not be resolved/i,
        /Failed to resolve import/i,
        /Module not found/i,
        /Cannot find module/i,
        /Could not resolve/i,
      ];
      const combinedOutput = stdoutTail + '\n' + stderrTail;
      const fatalMatch = FATAL_PATTERNS.find((p) => p.test(combinedOutput));
      if (ok && fatalMatch) {
        // Extract the first matching line for a useful error message.
        const matchingLine = combinedOutput.split('\n').find((l) => fatalMatch.test(l))?.trim() ?? '';
        return {
          passed: false,
          message:
            urlUsed === url
              ? `local_http_smoke(${url}) HTTP 200 but fatal module error detected`
              : `local_http_smoke(${url}) resolved to ${urlUsed} HTTP 200 but fatal module error detected`,
          evidence: {
            cwd,
            startCommand,
            url,
            resolvedUrl: urlUsed === url ? undefined : urlUsed,
            timeoutMs,
            requestTimeoutMs,
            durationMs,
            httpStatus: lastStatus,
            responseSnippet,
            fatalError: matchingLine,
            stdoutTail,
            stderrTail,
          },
        };
      }

      if (ok) {
        return {
          passed: true,
          message: urlUsed === url ? `local_http_smoke(${url})` : `local_http_smoke(${url}) resolved to ${urlUsed}`,
          evidence: {
            cwd,
            startCommand,
            url,
            resolvedUrl: urlUsed === url ? undefined : urlUsed,
            timeoutMs,
            requestTimeoutMs,
            durationMs,
            httpStatus: lastStatus,
            responseSnippet,
            stdoutTail,
            stderrTail,
          },
        };
      }

      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/25aab501-c72a-437e-b834-e0245fea140d',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'build-e2e-retry',hypothesisId:'H1',location:'src/core/policy-engine.ts:local_http_smoke',message:'local_http_smoke failed after probe attempts',data:{configuredUrl:url,resolvedUrl:urlUsed,startCommand,lastStatus,lastError,durationMs,probeAttemptsTail:probeAttempts.slice(-12)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      return {
        passed: false,
        message: `local_http_smoke(${url}) failed`,
        evidence: {
          cwd,
          startCommand,
          url,
          resolvedUrl: urlUsed === url ? undefined : urlUsed,
          timeoutMs,
          requestTimeoutMs,
          durationMs,
          httpStatus: lastStatus,
          lastError,
          probeAttempts: probeAttempts.slice(-20),
          processExitCode: child.exitCode,
          stdoutTail,
          stderrTail,
        },
      };
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
    case 'delegation_coverage': {
      const diffFiles = job.lastDiff?.files ?? [];
      const changedPaths = diffFiles.map((f) => f.path);
      const delegated = (job.delegationPlan?.tasks ?? []).filter((t) => t.roleId === ctx.roleId);
      if (delegated.length === 0) {
        return {
          passed: true,
          message: 'delegation_coverage: no delegated tasks for role',
          evidence: { role: ctx.roleId }
        };
      }

      const requireAllTasks = c.requireAllTasks ?? true;
      const requireScopeHints = c.requireScopeHints ?? true;

      // Build a set of existing files in the workspace for lenient coverage checks.
      // If a task's scopeHints match pre-existing files (not just changed files),
      // the task is considered covered — the agent may have verified/reviewed existing code
      // without needing to modify it.
      const wsRoot = jobWorkspaceRoot(job);
      let existingFiles: string[] | null = null;
      const getExistingFiles = async (): Promise<string[]> => {
        if (existingFiles !== null) return existingFiles;
        try {
          existingFiles = await listFilesRec(wsRoot, ['.git', 'node_modules', '.nibbler', '.nibbler-staging']);
        } catch {
          existingFiles = [];
        }
        return existingFiles;
      };

      const taskResults: Array<{ taskId: string; passed: boolean; reason: string; scopeHints: string[]; matches: string[] }> = [];
      for (const t of delegated) {
        const hints = t.scopeHints ?? [];
        if (hints.length === 0) {
          taskResults.push({
            taskId: t.taskId,
            passed: !requireScopeHints,
            reason: 'missing_scope_hints',
            scopeHints: hints,
            matches: [] as string[]
          });
          continue;
        }
        const isMatch = picomatch(hints, { dot: true });
        const matches = changedPaths.filter((p) => isMatch(p));
        if (matches.length > 0) {
          taskResults.push({
            taskId: t.taskId,
            passed: true,
            reason: 'matched',
            scopeHints: hints,
            matches
          });
          continue;
        }
        // Lenient fallback: if no changed files match but existing files in the workspace
        // already satisfy the scopeHints, consider the task covered. This handles the common
        // case where the project was previously built and the code already exists.
        const existing = await getExistingFiles();
        const existingMatches = existing.filter((p) => isMatch(p));
        if (existingMatches.length > 0) {
          taskResults.push({
            taskId: t.taskId,
            passed: true,
            reason: 'pre_existing_files',
            scopeHints: hints,
            matches: existingMatches.slice(0, 10)
          });
          continue;
        }
        taskResults.push({
          taskId: t.taskId,
          passed: false,
          reason: 'no_matching_changes',
          scopeHints: hints,
          matches: []
        });
      }

      const covered = taskResults.filter((r) => r.passed).length;
      const passed = requireAllTasks ? covered === taskResults.length : covered > 0;

      const missingScopeHints = taskResults.filter((r) => r.reason === 'missing_scope_hints').map((r) => r.taskId);
      const uncovered = taskResults.filter((r) => !r.passed).map((r) => r.taskId);

      const summary =
        passed
          ? `delegation_coverage: covered ${covered}/${taskResults.length} tasks`
          : `delegation_coverage failed: covered ${covered}/${taskResults.length} tasks (uncovered=${uncovered.join(', ') || 'none'})`;

      return {
        passed,
        message: summary,
        evidence: {
          role: ctx.roleId,
          requireAllTasks,
          requireScopeHints,
          changedFiles: diffFiles.length,
          changedPathsSample: changedPaths.slice(0, 25),
          missingScopeHints,
          uncovered,
          taskResults
        }
      };
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

function extractMarkdownHeadings(markdown: string): string[] {
  const out: string[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.push(m[2]!);
  }
  return out;
}

function normalizeHeading(h: string): string {
  // Normalize headings so stylistic prefix/suffix (emoji/punctuation) doesn't break checks.
  // Example: "🚀 Quickstart" should satisfy required heading "Quickstart".
  return h
    .trim()
    .replace(/^#+\s+/, '')
    .normalize('NFKD')
    .toLowerCase()
    // Replace any non-letter/number runs (incl emoji/punct) with spaces.
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replaceAll(/\s+/g, ' ');
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

interface CriterionDeferDecision {
  defer: boolean;
  reason?: string;
  criterionPathHints?: string[];
  roleWritablePatterns?: string[];
  delegatedScopeHints?: string[];
}

function shouldDeferCriterionForRole(
  criterion: Criterion,
  roleId: string,
  contract: Contract,
  delegatedTasks: Array<{ scopeHints?: string[] }>
): CriterionDeferDecision {
  if (criterion.type !== 'local_http_smoke') return { defer: false };

  const roleDef = contract.roles.find((r) => r.id === roleId);
  if (!roleDef) return { defer: false };

  const criterionPathHints = extractCommandPathHints(criterion.startCommand);
  if (criterionPathHints.length === 0) return { defer: false };

  const roleWritablePatterns = collectWritablePatterns(roleDef, contract);
  const delegatedScopeHints = Array.from(
    new Set(
      delegatedTasks.flatMap((t) => t.scopeHints ?? [])
    )
  );
  const roleMatcher = roleWritablePatterns.length > 0 ? picomatch(roleWritablePatterns, { dot: true }) : null;
  const delegatedMatcher = delegatedScopeHints.length > 0 ? picomatch(delegatedScopeHints, { dot: true }) : null;

  const roleCanTouchCriterionSurface =
    roleMatcher != null ? criterionPathHints.some((hint) => roleMatcher(hint)) : false;
  const delegatedCanTouchCriterionSurface =
    delegatedMatcher != null ? criterionPathHints.some((hint) => delegatedMatcher(hint)) : false;

  if (roleCanTouchCriterionSurface || delegatedCanTouchCriterionSurface) {
    return { defer: false };
  }

  return {
    defer: true,
    reason: 'outside_role_scope',
    criterionPathHints,
    roleWritablePatterns,
    delegatedScopeHints
  };
}

function collectWritablePatterns(roleDef: RoleDefinition, contract: Contract): string[] {
  const patterns = new Set<string>([
    ...roleDef.scope,
    ...(roleDef.authority.allowedPaths ?? [])
  ]);

  for (const shared of contract.sharedScopes) {
    if (!shared.roles.includes(roleDef.id)) continue;
    for (const p of shared.patterns) patterns.add(p);
  }

  return Array.from(patterns);
}

function extractCommandPathHints(command: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|`[^`]*`|\S+/g) ?? [];
  const hints = new Set<string>();

  for (const rawToken of tokens) {
    const unquoted = rawToken.replace(/^['"`]|['"`]$/g, '');
    if (!unquoted) continue;
    if (unquoted.startsWith('-')) continue;
    if (/^https?:\/\//i.test(unquoted)) continue;

    const normalized = unquoted.replaceAll('\\', '/').replace(/[;,]+$/g, '').replace(/\/+$/g, '');
    if (!normalized.includes('/')) continue;
    // Ignore npm package names like "@scope/pkg".
    if (normalized.startsWith('@') && !normalized.startsWith('./') && !normalized.startsWith('../')) continue;

    const rel = normalized.startsWith('./') ? normalized.slice(2) : normalized;
    if (!rel || rel.startsWith('/')) continue;
    hints.add(rel);
  }

  return Array.from(hints);
}

function extractLocalUrlsFromLogs(text: string): string[] {
  // Prefer later lines (they often contain the final chosen port).
  const re = /(https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5})/gi;
  const ordered = new Set<string>();
  for (const m of text.matchAll(re)) {
    const u = String(m[1] ?? '').trim();
    if (!u) continue;
    // Keep last occurrence order.
    if (ordered.has(u)) ordered.delete(u);
    ordered.add(u);
  }
  // Return last-seen first.
  return Array.from(ordered).reverse();
}

function expandLocalUrlCandidates(candidates: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (u: string) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };

  for (const raw of candidates) {
    add(raw);
    try {
      const parsed = new URL(raw);
      // Some environments resolve `localhost` to IPv6 first; servers often bind to IPv4 only.
      // Try both `localhost` and `127.0.0.1` to avoid false timeouts.
      if (parsed.hostname === 'localhost') {
        parsed.hostname = '127.0.0.1';
        add(parsed.toString().replace(/\/$/, ''));
      } else if (parsed.hostname === '127.0.0.1') {
        parsed.hostname = 'localhost';
        add(parsed.toString().replace(/\/$/, ''));
      }
    } catch {
      // ignore invalid URL
    }
  }

  return out;
}

async function tryFetchOk(
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; status?: number; error?: string; bodySnippet?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' as any });
    const status = res.status;
    // 2xx/3xx = "responding"
    const responding = status >= 200 && status < 400;
    let bodySnippet: string | undefined;
    try {
      const text = await res.text();
      bodySnippet = text.slice(0, 500);
    } catch {
      // ignore
    }
    return responding ? { ok: true, status, bodySnippet } : { ok: false, status, bodySnippet };
  } catch (err: any) {
    const msg = String(err?.name === 'AbortError' ? 'request_timeout' : err?.message ?? err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

async function terminateProcess(child: any): Promise<void> {
  // Execa child is a promise-like process with .kill(). Best-effort termination.
  if (!child) return;
  if (child.exitCode != null) return;

  const pid = Number(child.pid) || null;
  killProcess(pid, 'SIGTERM');
  await waitForChildExit(child, 1_500);
  if (child.exitCode != null) return;

  killProcess(pid, 'SIGKILL');
  await waitForChildExit(child, 2_500);
}

function killProcess(pid: number | null, signal: NodeJS.Signals): void {
  if (!pid) return;
  // When detached=true, -pid targets the process group (dev server + children).
  try {
    process.kill(-pid, signal);
  } catch {
    // ignore
  }
  // Fallback for platforms/shells where group signalling is unavailable.
  try {
    process.kill(pid, signal);
  } catch {
    // ignore
  }
}

async function waitForChildExit(child: any, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      Promise.resolve(child).then(() => undefined).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => resolve(), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

