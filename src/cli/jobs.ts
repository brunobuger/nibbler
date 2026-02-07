import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { fileExists, readJson } from '../utils/fs.js';
import { JobStatusSnapshotV1Schema, type JobStatusSnapshotV1 } from '../core/job/status.js';
import { LedgerReader } from '../core/ledger/reader.js';

export function jobsDir(repoRoot: string): string {
  return join(repoRoot, '.nibbler', 'jobs');
}

/**
 * Helper utilities for CLI commands that operate on `.nibbler/jobs/`.
 */
export function jobDir(repoRoot: string, jobId: string): string {
  return join(jobsDir(repoRoot), jobId);
}

export function jobStatusPath(repoRoot: string, jobId: string): string {
  return join(jobDir(repoRoot, jobId), 'status.json');
}

export function jobLedgerPath(repoRoot: string, jobId: string): string {
  return join(jobDir(repoRoot, jobId), 'ledger.jsonl');
}

export async function listJobIds(repoRoot: string): Promise<string[]> {
  const root = jobsDir(repoRoot);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => n.startsWith('j-'))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function resolveJobId(repoRoot: string, explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const ids = await listJobIds(repoRoot);
  return ids.length ? ids[ids.length - 1]! : null;
}

export async function readJobStatus(repoRoot: string, jobId: string): Promise<JobStatusSnapshotV1> {
  const abs = jobStatusPath(repoRoot, jobId);
  const raw = await readJson(abs);
  return JobStatusSnapshotV1Schema.parse(raw);
}

export async function jobExists(repoRoot: string, jobId: string): Promise<boolean> {
  return await fileExists(jobStatusPath(repoRoot, jobId));
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function joinRepoPath(repoRoot: string, repoRelative: string): string {
  // status.json stores repo-relative paths.
  const root = resolve(repoRoot);
  const rel = repoRelative.replaceAll('\\', '/').replace(/^\/+/, '');
  return join(root, rel);
}

export async function readLedgerTail(repoRoot: string, jobId: string, n: number): Promise<{ entries: unknown[]; warnings: string[] }> {
  const ledger = new LedgerReader(jobLedgerPath(repoRoot, jobId));
  const integrity = await ledger.verifyIntegrity();
  const entries = await ledger.tail(n);
  const warnings = integrity.ok ? [] : [integrity.message ?? 'ledger integrity check failed'];
  return { entries, warnings };
}

