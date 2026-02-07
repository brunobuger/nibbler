import { execa } from 'execa';
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

export async function isClean(repo: GitRepo): Promise<boolean> {
  const out = await run(repo, ['status', '--porcelain']);
  return out.trim().length === 0;
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
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
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

export async function commit(repo: GitRepo, message: string): Promise<void> {
  await runRaw(repo, ['add', '-A']);
  const staged = (await run(repo, ['diff', '--cached', '--name-only'])).trim();
  if (!staged) return; // nothing to commit (e.g., only ignored engine artifacts changed)
  await runRaw(repo, ['commit', '-m', message]);
}

