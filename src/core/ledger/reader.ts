import { readFile } from 'node:fs/promises';
import { LedgerEntrySchema, type LedgerEntry } from './types.js';

export class LedgerReader {
  constructor(private ledgerPath: string) {}

  async readAll(): Promise<LedgerEntry[]> {
    const { entries } = await this.readAllSafe();
    return entries;
  }

  async readAllSafe(): Promise<{ entries: LedgerEntry[]; warnings: string[] }> {
    const warnings: string[] = [];
    const entries: LedgerEntry[] = [];

    const lines = await readJsonlLines(this.ledgerPath);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      try {
        const obj = JSON.parse(line);
        entries.push(LedgerEntrySchema.parse(obj));
      } catch (err: any) {
        // Common corruption: trailing partial line. Treat as warning and stop parsing further.
        const isLast = i === lines.length - 1;
        warnings.push(`ledger parse failed at line ${i + 1}${isLast ? ' (last line)' : ''}: ${String(err?.message ?? err)}`);
        if (isLast) break;
        // If corruption happens mid-file, skip the bad line but keep going.
        continue;
      }
    }

    return { entries, warnings };
  }

  async tail(n: number): Promise<LedgerEntry[]> {
    const { entries } = await this.readAllSafe();
    return entries.slice(Math.max(0, entries.length - n));
  }

  async findByType(type: string): Promise<LedgerEntry[]> {
    const { entries } = await this.readAllSafe();
    return entries.filter((e) => e.type === type);
  }

  async verifyIntegrity(): Promise<{ ok: boolean; message?: string }> {
    const { entries, warnings } = await this.readAllSafe();
    if (warnings.length) {
      return { ok: false, message: warnings.join('\n') };
    }
    for (let i = 0; i < entries.length; i++) {
      const expected = i + 1;
      if (entries[i].seq !== expected) {
        return { ok: false, message: `Sequence gap at index ${i} (expected seq=${expected}, got ${entries[i].seq})` };
      }
    }
    return { ok: true };
  }
}

async function readJsonlLines(path: string): Promise<string[]> {
  try {
    const content = await readFile(path, 'utf8');
    return content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err: any) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return [];
    throw err;
  }
}

