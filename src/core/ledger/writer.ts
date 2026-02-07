import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LedgerEntrySchema, type LedgerEntry, type LedgerEntryInput } from './types.js';

export class LedgerWriter {
  private nextSeq: number;
  private ledgerPath: string;

  private constructor(ledgerPath: string, nextSeq: number) {
    this.ledgerPath = ledgerPath;
    this.nextSeq = nextSeq;
  }

  static async open(ledgerPath: string): Promise<LedgerWriter> {
    await mkdir(dirname(ledgerPath), { recursive: true });

    const nextSeq = (await computeNextSeq(ledgerPath)) ?? 1;
    return new LedgerWriter(ledgerPath, nextSeq);
  }

  async append(event: LedgerEntryInput): Promise<LedgerEntry> {
    const entry: LedgerEntry = LedgerEntrySchema.parse({
      ...event,
      seq: this.nextSeq,
      timestamp: new Date().toISOString()
    });

    // One JSON object per line (JSONL). Append-only.
    const fh = await open(this.ledgerPath, 'a');
    try {
      await fh.writeFile(`${JSON.stringify(entry)}\n`, { encoding: 'utf8', flush: true });
    } finally {
      await fh.close();
    }

    this.nextSeq += 1;
    return entry;
  }
}

async function computeNextSeq(ledgerPath: string): Promise<number | null> {
  try {
    const content = await readFile(ledgerPath, 'utf8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return 1;

    // Be resilient to a trailing partial/garbled line (e.g. crash mid-write).
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as { seq?: unknown };
        const lastSeq = typeof parsed.seq === 'number' ? parsed.seq : null;
        if (lastSeq && Number.isFinite(lastSeq)) return lastSeq + 1;
      } catch {
        continue;
      }
    }

    return 1;
  } catch (err: any) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return 1;
    throw err;
  }
}

