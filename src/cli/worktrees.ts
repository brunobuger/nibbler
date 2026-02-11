import {
  addWorktree,
  createBranchAt,
  deleteBranch,
  getCurrentBranch,
  git,
  isClean,
  mergeBranch,
  removeWorktree,
  resolveWorktreePath,
  stashPop,
  stashPush
} from '../git/operations.js';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readWorktreeGitdir(worktreePath: string): Promise<string | null> {
  try {
    const raw = await readFile(join(worktreePath, '.git'), 'utf8');
    const m = /^gitdir:\s*(.+)\s*$/m.exec(raw);
    if (!m) return null;
    const candidate = m[1].trim();
    // git may write either absolute or relative paths here
    return resolvePath(worktreePath, candidate);
  } catch {
    return null;
  }
}

async function isActiveWorktreeDir(worktreePath: string): Promise<{ active: boolean; gitdir: string | null; gitdirExists: boolean }> {
  const gitdir = await readWorktreeGitdir(worktreePath);
  const gitdirExists = gitdir ? await pathExists(gitdir) : false;
  return { active: !!gitdir && gitdirExists, gitdir, gitdirExists };
}

async function moveAsideStaleWorktreeDir(worktreePath: string): Promise<{ moved: boolean; movedTo?: string }> {
  const movedTo = `${worktreePath}.stale-${Date.now()}-${process.pid}`;
  try {
    await rename(worktreePath, movedTo);
    return { moved: true, movedTo };
  } catch {
    // Last resort: remove the directory to unblock worktree creation.
    await rm(worktreePath, { recursive: true, force: true });
    return { moved: true, movedTo: undefined };
  }
}

export async function prepareJobWorktree(args: {
  repoRoot: string;
  jobId: string;
  jobBranch: string;
}): Promise<{ sourceBranch: string; worktreePath: string }> {
  const repo = git(args.repoRoot);
  const sourceBranch = await getCurrentBranch(repo).catch(() => 'HEAD');
  const worktreePath = resolveWorktreePath(args.repoRoot, args.jobId);

  // If the directory exists, it may be:
  // - an active worktree (safe to reuse)
  // - a stale leftover (e.g., metadata removed but directory left behind)
  const exists = await pathExists(worktreePath);

  if (exists) {
    const inspected = await isActiveWorktreeDir(worktreePath);
    if (inspected.active) {
      return { sourceBranch, worktreePath };
    }
    await moveAsideStaleWorktreeDir(worktreePath);
  }

  // Create branch at current HEAD (if it already exists, preserve it for recovery).
  let createdBranch = false;
  try {
    await createBranchAt(repo, args.jobBranch, 'HEAD');
    createdBranch = true;
  } catch {
    // branch likely already exists; keep going
  }
  try {
    await addWorktree(repo, worktreePath, args.jobBranch);
  } catch (err) {
    // Best-effort rollback if worktree creation fails.
    if (createdBranch) {
      try {
        await deleteBranch(repo, args.jobBranch, { force: true });
      } catch {
        // ignore
      }
    }
    throw err;
  }

  return { sourceBranch, worktreePath };
}

export async function ensureWorktreeForExistingBranch(args: {
  repoRoot: string;
  worktreePath: string;
  jobBranch: string;
}): Promise<{ worktreePath: string; reused: boolean; movedStaleTo?: string }> {
  const repo = git(args.repoRoot);
  const exists = await pathExists(args.worktreePath);
  let movedStaleTo: string | undefined;
  if (exists) {
    const inspected = await isActiveWorktreeDir(args.worktreePath);
    if (inspected.active) {
      return { worktreePath: args.worktreePath, reused: true };
    }
    const moved = await moveAsideStaleWorktreeDir(args.worktreePath);
    movedStaleTo = moved.movedTo;
  }

  await addWorktree(repo, args.worktreePath, args.jobBranch);
  return { worktreePath: args.worktreePath, reused: false, movedStaleTo };
}

export async function mergeBackIfSafe(args: {
  repoRoot: string;
  sourceBranch: string;
  jobBranch: string;
  allowNoFf?: boolean;
}): Promise<{ merged: boolean; reason?: string; autostash?: { used: boolean; popHadConflicts?: boolean } }> {
  const repo = git(args.repoRoot);

  if (!args.sourceBranch || args.sourceBranch === 'HEAD') {
    return { merged: false, reason: 'source_branch_unknown_or_detached' };
  }

  const current = await getCurrentBranch(repo).catch(() => 'HEAD');
  if (current !== args.sourceBranch) {
    return { merged: false, reason: `current_branch_changed (${current} != ${args.sourceBranch})` };
  }

  // Avoid merging into a dirty working tree.
  let clean = await isClean(repo, { ignoreNibblerEngineArtifacts: true }).catch(() => false);
  let usedAutostash = false;
  if (!clean) {
    // Make this transparent: stash, merge, then restore the stash.
    const pushed = await stashPush(repo, {
      includeUntracked: true,
      message: `nibbler:auto-stash:merge:${args.jobBranch}:${Date.now()}:${process.pid}`,
    }).catch(() => ({ stashed: false, output: '' }));
    usedAutostash = pushed.stashed;
    clean = await isClean(repo, { ignoreNibblerEngineArtifacts: true }).catch(() => false);
    if (!clean) {
      return { merged: false, reason: 'working_tree_not_clean', autostash: { used: usedAutostash } };
    }
  }

  await mergeBranch(repo, args.jobBranch, { ffOnly: true, allowNoFf: args.allowNoFf ?? true });
  if (usedAutostash) {
    const popped = await stashPop(repo).catch(() => ({ applied: false, hadConflicts: true, output: '' }));
    if (!popped.applied && popped.hadConflicts) {
      return { merged: true, reason: 'autostash_pop_conflicts', autostash: { used: true, popHadConflicts: true } };
    }
    // Even if pop failed without obvious conflicts, keep merge as success but surface a reason for UX.
    if (!popped.applied) {
      return { merged: true, reason: 'autostash_pop_failed', autostash: { used: true, popHadConflicts: false } };
    }
  }
  return { merged: true, autostash: usedAutostash ? { used: true, popHadConflicts: false } : { used: false } };
}

export async function cleanupJobWorktreeBestEffort(args: {
  repoRoot: string;
  worktreePath: string;
  jobBranch: string;
}): Promise<{ removedWorktree: boolean; deletedBranch: boolean }> {
  const repo = git(args.repoRoot);
  let removedWorktree = false;
  let deletedBranch = false;

  try {
    await removeWorktree(repo, args.worktreePath, { force: true });
    removedWorktree = true;
  } catch {
    // keep going
  }

  // If git removed metadata but couldn't delete the directory (common on crash/locks),
  // ensure we don't leave behind a stale worktree folder that blocks future runs.
  if (removedWorktree) {
    try {
      await rm(args.worktreePath, { recursive: true, force: true });
    } catch {
      // keep going
    }
  }

  try {
    await deleteBranch(repo, args.jobBranch);
    deletedBranch = true;
  } catch {
    // keep going
  }

  return { removedWorktree, deletedBranch };
}

