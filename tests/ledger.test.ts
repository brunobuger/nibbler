import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LedgerReader } from '../src/core/ledger/reader.js';
import { LedgerWriter } from '../src/core/ledger/writer.js';

describe('ledger', () => {
  it('appends JSONL entries with monotonic seq and verifies integrity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nibbler-ledger-'));
    const ledgerPath = join(dir, 'ledger.jsonl');

    const writer = await LedgerWriter.open(ledgerPath);
    const e1 = await writer.append({ type: 'job_created', data: { jobId: 'j-20260207-001' } });
    const e2 = await writer.append({ type: 'session_start', data: { role: 'architect', commit: 'abc' } });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.timestamp).toMatch(/Z$/);

    const reader = new LedgerReader(ledgerPath);
    const all = await reader.readAll();
    expect(all).toHaveLength(2);

    const integrity = await reader.verifyIntegrity();
    expect(integrity.ok).toBe(true);
  });

  it('detects sequence gaps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nibbler-ledger-'));
    const ledgerPath = join(dir, 'ledger.jsonl');

    await writeFile(
      ledgerPath,
      `${JSON.stringify({ seq: 1, timestamp: new Date().toISOString(), type: 'job_created', data: { jobId: 'x' } })}\n` +
        `${JSON.stringify({ seq: 3, timestamp: new Date().toISOString(), type: 'job_completed', data: {} })}\n`,
      'utf8'
    );

    const reader = new LedgerReader(ledgerPath);
    const res = await reader.verifyIntegrity();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('Sequence gap');
  });
});

