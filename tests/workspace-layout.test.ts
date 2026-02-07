import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearRoleOverlays, initJob, initWorkspace, isNibblerRepo, writeProtocolRule, writeRoleOverlay } from '../src/workspace/layout.js';

describe('workspace layout', () => {
  it('initializes workspace folders and detects nibbler repo', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-ws-'));
    expect(await isNibblerRepo(repoRoot)).toBe(false);

    const ws = await initWorkspace(repoRoot);
    expect(ws.contractDir).toContain('.nibbler/contract');
    expect(await isNibblerRepo(repoRoot)).toBe(true);
  });

  it('initializes job folders with evidence subdirs', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-ws-'));
    await initWorkspace(repoRoot);

    const job = await initJob(repoRoot, 'j-test');
    expect(job.evidenceDiffsDir).toContain('evidence/diffs');
    expect(job.evidenceChecksDir).toContain('evidence/checks');
    expect(job.evidenceCommandsDir).toContain('evidence/commands');
    expect(job.evidenceGatesDir).toContain('evidence/gates');
  });

  it('writes protocol rule and role overlay; clears role overlays', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-ws-'));
    await initWorkspace(repoRoot);

    await writeProtocolRule(repoRoot, 'protocol');
    await writeRoleOverlay(repoRoot, 'architect', 'overlay');

    await clearRoleOverlays(repoRoot);
  });
});

