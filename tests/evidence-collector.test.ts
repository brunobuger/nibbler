import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EvidenceCollector } from '../src/core/evidence/collector.js';

describe('evidence collector', () => {
  it('records diff and checks using per-role sequences', async () => {
    const base = await mkdtemp(join(tmpdir(), 'nibbler-evidence-'));
    const paths = {
      evidenceDir: base,
      diffsDir: join(base, 'diffs'),
      checksDir: join(base, 'checks'),
      commandsDir: join(base, 'commands'),
      gatesDir: join(base, 'gates')
    };

    const ec = new EvidenceCollector(paths);

    await ec.recordDiff('architect', { raw: 'diff --git', files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } });
    await ec.recordScopeCheck('architect', { ok: true });
    await ec.recordCompletionCheck('architect', { ok: true });

    const diffFiles = await readdir(paths.diffsDir);
    const checkFiles = await readdir(paths.checksDir);

    expect(diffFiles.some((f) => f.startsWith('architect-1') && f.endsWith('.diff'))).toBe(true);
    expect(checkFiles.some((f) => f.includes('architect-2-scope'))).toBe(true);
    expect(checkFiles.some((f) => f.includes('architect-3-completion'))).toBe(true);
  });
});

