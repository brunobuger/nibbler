import { execa } from 'execa';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createTempGitRepo(): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'nibbler-git-'));
  await execa('git', ['init'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Nibbler Test'], { cwd: dir });

  // Initial commit to diff against.
  await writeFile(join(dir, 'README.md'), '# temp\n', 'utf8');
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['commit', '-m', 'init'], { cwd: dir });

  return { dir };
}

export async function writeFileInRepo(repoDir: string, relPath: string, content: string) {
  await writeFile(join(repoDir, relPath), content, 'utf8');
}

