import { describe, expect, it } from 'vitest';
import { execa } from 'execa';

import { createTempGitRepo } from './git-fixture.js';
import {
  clean,
  commit,
  createBranch,
  diff,
  diffFiles,
  getCurrentBranch,
  getCurrentCommit,
  git,
  isClean,
  lsFiles,
  resetHard
} from '../src/git/operations.js';

describe('git operations', () => {
  it('reports current commit and clean status', async () => {
    const { dir } = await createTempGitRepo();
    const repo = git(dir);

    const head = await getCurrentCommit(repo);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(await isClean(repo)).toBe(true);
  });

  it('creates a branch', async () => {
    const { dir } = await createTempGitRepo();
    const repo = git(dir);

    await createBranch(repo, 'nibbler/test-branch');
    expect(await getCurrentBranch(repo)).toBe('nibbler/test-branch');
  });

  it('diff() returns structured files and summary', async () => {
    const { dir } = await createTempGitRepo();
    const repo = git(dir);

    const base = await getCurrentCommit(repo);

    // Modify tracked file.
    await execa('bash', ['-lc', "printf 'hello\\n' >> README.md"], { cwd: dir });

    const result = await diff(repo, base);
    expect(result.raw).toContain('diff --git');
    expect(result.summary.filesChanged).toBeGreaterThanOrEqual(1);
    expect(result.files.some((f) => f.path === 'README.md')).toBe(true);
  });

  it('diffFiles() lists changed paths', async () => {
    const { dir } = await createTempGitRepo();
    const repo = git(dir);

    const base = await getCurrentCommit(repo);
    await execa('bash', ['-lc', "printf 'x\\n' > a.txt"], { cwd: dir });

    const files = await diffFiles(repo, base);
    expect(files).toContain('a.txt');
  });

  it('commit() stages and commits changes; resetHard() reverts; clean() removes untracked', async () => {
    const { dir } = await createTempGitRepo();
    const repo = git(dir);
    const base = await getCurrentCommit(repo);

    await execa('bash', ['-lc', "printf 'x\\n' > tracked.txt"], { cwd: dir });
    await commit(repo, 'add tracked');
    expect(await isClean(repo)).toBe(true);

    // Create untracked file.
    await execa('bash', ['-lc', "printf 'y\\n' > untracked.txt"], { cwd: dir });
    expect(await isClean(repo)).toBe(false);
    await clean(repo);

    // Modify and then reset.
    await execa('bash', ['-lc', "printf 'z\\n' >> tracked.txt"], { cwd: dir });
    await resetHard(repo, base);

    const tracked = await lsFiles(repo);
    expect(tracked).toContain('README.md');
  });
});

