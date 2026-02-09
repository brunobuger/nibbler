import { execa } from 'execa';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { parseDiff, type DiffResult } from './diff-parser.js';

export interface GitRepo {
  repoRoot: string;
}

export function git(repoRoot: string): GitRepo {
  return { repoRoot };
}

async function run(repo: GitRepo, args: string[]): Promise<string> {
  const res = await execa('git', args, {
    cwd: repo.repoRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  });
  return res.stdout;
}

async function runRaw(repo: GitRepo, args: string[]): Promise<string> {
  // Keep stderr as part of errors.
  const res = await execa('git', args, {
    cwd: repo.repoRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  });
  return res.stdout;
}

export async function getCurrentCommit(repo: GitRepo): Promise<string> {
  return (await run(repo, ['rev-parse', 'HEAD'])).trim();
}

export async function getCurrentBranch(repo: GitRepo): Promise<string> {
  return (await run(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function createBranch(repo: GitRepo, name: string): Promise<void> {
  await runRaw(repo, ['checkout', '-b', name]);
}

/**
 * Create a local branch at a ref without checking it out.
 * Equivalent: `git branch <name> <ref>`
 */
export async function createBranchAt(repo: GitRepo, name: string, ref: string): Promise<void> {
  await runRaw(repo, ['branch', name, ref]);
}

/**
 * Resolve a stable worktree path for a job.
 *
 * Layout:
 *   <repoParent>/.nibbler-wt-<repoBasename>/<jobId>/
 */
export function resolveWorktreePath(repoRoot: string, jobId: string): string {
  const absRepo = resolvePath(repoRoot);
  const repoBase = basename(absRepo.replace(/\/+$/, '')) || 'repo';
  const repoParent = dirname(absRepo);
  return resolvePath(join(repoParent, `.nibbler-wt-${repoBase}`, jobId));
}

/**
 * Add a worktree for an existing branch.
 * Equivalent: `git worktree add <path> <branch>`
 */
export async function addWorktree(repo: GitRepo, worktreePath: string, branch: string): Promise<void> {
  await mkdir(dirname(worktreePath), { recursive: true });
  await runRaw(repo, ['worktree', 'add', worktreePath, branch]);
}

/**
 * Remove a worktree. By default uses --force to be resilient to stray untracked files.
 * Equivalent: `git worktree remove <path> --force`
 */
export async function removeWorktree(repo: GitRepo, worktreePath: string, opts?: { force?: boolean }): Promise<void> {
  const force = opts?.force ?? true;
  const args = ['worktree', 'remove', worktreePath];
  if (force) args.push('--force');
  await runRaw(repo, args);
}

/**
 * Merge a branch into the current branch.
 * Default: fast-forward only. Optionally allow a merge commit.
 */
export async function mergeBranch(
  repo: GitRepo,
  branch: string,
  opts?: { ffOnly?: boolean; allowNoFf?: boolean }
): Promise<void> {
  const ffOnly = opts?.ffOnly ?? true;
  try {
    if (ffOnly) {
      await runRaw(repo, ['merge', '--ff-only', branch]);
      return;
    }
    await runRaw(repo, ['merge', branch]);
  } catch (err) {
    if (ffOnly && opts?.allowNoFf) {
      // Best-effort fallback: create a merge commit (still fails on conflicts).
      await runRaw(repo, ['merge', '--no-ff', '--no-edit', branch]);
      return;
    }
    throw err;
  }
}

/**
 * Delete a local branch.
 * Equivalent: `git branch -d <name>`
 */
export async function deleteBranch(repo: GitRepo, name: string, opts?: { force?: boolean }): Promise<void> {
  const force = opts?.force ?? false;
  await runRaw(repo, ['branch', force ? '-D' : '-d', name]);
}

export async function statusPorcelain(repo: GitRepo): Promise<string> {
  return await run(repo, ['status', '--porcelain']);
}

function isNibblerEngineArtifactPath(p: string): boolean {
  if (p.startsWith('.nibbler/jobs/')) return true;
  if (p.startsWith('.nibbler/config/cursor-profiles/')) return true;
  if (p.startsWith('.nibbler-staging/')) return true;
  if (p.startsWith('.cursor/rules/20-role-') && p.endsWith('.mdc')) return true;
  // Common generated artifacts that should never be committed by the engine.
  if (p.startsWith('node_modules/')) return true;
  if (p.startsWith('.next/')) return true;
  if (p.startsWith('dist/')) return true;
  if (p.startsWith('out/')) return true;
  if (p.startsWith('coverage/')) return true;
  if (p.startsWith('test-results/')) return true;
  if (p.startsWith('playwright-report/')) return true;
  if (p.startsWith('.turbo/')) return true;
  if (p.startsWith('.vercel/')) return true;
  if (p.startsWith('.netlify/')) return true;
  if (p.startsWith('.cache/')) return true;
  if (p.startsWith('.parcel-cache/')) return true;
  return false;
}

function extractPathsFromPorcelainLine(line: string): string[] {
  // Format: XY <path> (or "?? <path>")
  // Rename format: "R  old -> new"
  const trimmed = line.trimEnd();
  if (trimmed.length < 4) return [];
  const rest = trimmed.slice(3).trim();
  if (!rest) return [];
  const arrow = ' -> ';
  if (rest.includes(arrow)) {
    const [a, b] = rest.split(arrow);
    return [a?.trim(), b?.trim()].filter((x): x is string => !!x);
  }
  return [rest];
}

export async function isClean(repo: GitRepo, opts?: { ignoreNibblerEngineArtifacts?: boolean }): Promise<boolean> {
  const out = await statusPorcelain(repo);
  const rawLines = out.split('\n').filter((l) => l.trim().length > 0);
  if (!opts?.ignoreNibblerEngineArtifacts) {
    return rawLines.length === 0;
  }

  for (const line of rawLines) {
    const paths = extractPathsFromPorcelainLine(line);
    const allEngine = paths.length > 0 && paths.every((p) => isNibblerEngineArtifactPath(p));
    if (!allEngine) {
      return false;
    }
  }
  return true;
}

export async function lsFiles(repo: GitRepo): Promise<string[]> {
  const out = await run(repo, ['ls-files']);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function listUntracked(repo: GitRepo): Promise<string[]> {
  const out = await run(repo, ['ls-files', '--others', '--exclude-standard']);
  const raw = out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const filtered: string[] = [];
  for (const p of raw) {
    const noise = isCommonNoisePath(p);
    if (!noise) filtered.push(p);
  }

  return filtered;
}

function isCommonNoisePath(p: string): boolean {
  // These are almost always generated artifacts that should not drive scope checks.
  // Prefer handling via `.gitignore`, but filtering here prevents huge untracked sets
  // (e.g. `node_modules/`) from causing structural scope violations.
  const prefixes = [
    'node_modules/',
    '.next/',
    'dist/',
    'out/',
    'coverage/',
    'test-results/',
    'playwright-report/',
    '.turbo/',
    '.vercel/',
    '.netlify/',
    '.cache/',
    '.parcel-cache/',
  ];
  return prefixes.some((pre) => p.startsWith(pre));
}

export async function diffFiles(
  repo: GitRepo,
  fromCommit: string,
  toCommit?: string
): Promise<string[]> {
  const range = toCommit ? `${fromCommit}..${toCommit}` : fromCommit;
  const [out, untracked] = await Promise.all([
    run(repo, ['diff', '--name-only', range]),
    // `git diff` does not include untracked files, but scope enforcement must see them.
    // For v1, we always include current untracked paths.
    listUntracked(repo)
  ]);

  const changed = out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  return Array.from(new Set([...changed, ...untracked])).sort();
}

export async function diff(repo: GitRepo, fromCommit: string, toCommit?: string): Promise<DiffResult> {
  const range = toCommit ? `${fromCommit}..${toCommit}` : fromCommit;

  // `git diff <commit>` diffs commit vs working tree (incl staged + unstaged).
  // `git diff a..b` diffs between commits.
  const [rawDiff, nameStatus, numStat] = await Promise.all([
    run(repo, ['diff', range]),
    run(repo, ['diff', '--name-status', range]),
    run(repo, ['diff', '--numstat', range])
  ]);

  const parsed = parseDiff({ rawDiff, nameStatus, numStat });

  // Include untracked files in structured list for scope checks.
  // They won't be present in raw `git diff` output.
  const untracked = await listUntracked(repo);
  const existing = new Set(parsed.files.map((f) => f.path));
  const files = [
    ...parsed.files,
    ...untracked
      .filter((p) => !existing.has(p))
      .map((p) => ({ path: p, changeType: 'added' as const, additions: 0, deletions: 0 }))
  ];

  return {
    raw: parsed.raw,
    files,
    summary: {
      additions: files.reduce((a, f) => a + f.additions, 0),
      deletions: files.reduce((a, f) => a + f.deletions, 0),
      filesChanged: files.length
    }
  };
}

export async function resetHard(repo: GitRepo, commit: string): Promise<void> {
  await runRaw(repo, ['reset', '--hard', commit]);
}

export async function clean(repo: GitRepo): Promise<void> {
  await runRaw(repo, ['clean', '-fd']);
}

export async function commit(repo: GitRepo, message: string, opts?: { includeEngineArtifacts?: boolean }): Promise<void> {
  const includeEngineArtifacts = opts?.includeEngineArtifacts ?? false;
  await runRaw(repo, ['add', '-A']);
  let staged = (await run(repo, ['diff', '--cached', '--name-only'])).trim();
  if (!staged) return; // nothing to commit

  if (!includeEngineArtifacts) {
    const stagedPaths = staged
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const enginePaths = stagedPaths.filter((p) => isNibblerEngineArtifactPath(p));
    if (enginePaths.length > 0) {
      // Unstage engine artifacts so they never get merged back.
      await runRaw(repo, ['reset', '--', ...enginePaths]);
    }
    staged = (await run(repo, ['diff', '--cached', '--name-only'])).trim();
    if (!staged) return; // only engine artifacts changed
  }

  await runRaw(repo, ['commit', '-m', message]);
}

