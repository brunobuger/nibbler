import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { DiffResult } from '../../git/diff-parser.js';
import { writeJson } from '../../utils/fs.js';

export interface JobEvidencePaths {
  evidenceDir: string;
  diffsDir: string;
  checksDir: string;
  commandsDir: string;
  gatesDir: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export class EvidenceCollector {
  private seqByRole = new Map<string, number>();

  constructor(private paths: JobEvidencePaths) {}

  nextSeq(role: string): number {
    const next = (this.seqByRole.get(role) ?? 0) + 1;
    this.seqByRole.set(role, next);
    return next;
  }

  async recordDiff(role: string, diff: DiffResult): Promise<{ diffPath: string; metaPath: string }> {
    const seq = this.nextSeq(role);
    const diffPath = join(this.paths.diffsDir, `${role}-${seq}.diff`);
    const metaPath = join(this.paths.diffsDir, `${role}-${seq}.diff.meta.json`);

    await mkdir(dirname(diffPath), { recursive: true });
    await writeFile(diffPath, diff.raw, 'utf8');
    await writeJson(metaPath, {
      role,
      seq,
      timestamp: new Date().toISOString(),
      summary: diff.summary,
      files: diff.files
    });

    return { diffPath, metaPath };
  }

  async recordScopeCheck(role: string, result: unknown): Promise<string> {
    return await this.recordCheck(role, 'scope', result);
  }

  async recordCompletionCheck(role: string, result: unknown): Promise<string> {
    return await this.recordCheck(role, 'completion', result);
  }

  async recordCustomCheck(role: string, kind: string, result: unknown): Promise<string> {
    return await this.recordCheck(role, kind, result);
  }

  async recordCommand(role: string, checkName: string, result: CommandResult): Promise<{ stdoutPath: string; stderrPath: string; metaPath: string }> {
    const seq = this.nextSeq(role);
    const safeName = sanitize(checkName);
    const base = join(this.paths.commandsDir, `${role}-${seq}-${safeName}`);
    const stdoutPath = `${base}.stdout`;
    const stderrPath = `${base}.stderr`;
    const metaPath = `${base}.meta.json`;

    await mkdir(dirname(stdoutPath), { recursive: true });
    await writeFile(stdoutPath, result.stdout ?? '', 'utf8');
    await writeFile(stderrPath, result.stderr ?? '', 'utf8');
    await writeJson(metaPath, {
      role,
      seq,
      timestamp: new Date().toISOString(),
      command: checkName,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutFile: basename(stdoutPath),
      stderrFile: basename(stderrPath)
    });

    return { stdoutPath, stderrPath, metaPath };
  }

  async recordGateInputs(gateId: string, inputs: unknown): Promise<string> {
    const path = join(this.paths.gatesDir, `${gateId}-inputs.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeJson(path, inputs);
    return path;
  }

  async recordGateResolution(gateId: string, resolution: unknown): Promise<string> {
    const path = join(this.paths.gatesDir, `${gateId}-resolution.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeJson(path, resolution);
    return path;
  }

  async captureFinalState(data: unknown): Promise<string> {
    const path = join(this.paths.evidenceDir, 'final-status.json');
    await mkdir(dirname(path), { recursive: true });
    await writeJson(path, data);
    return path;
  }

  async captureFinalTree(files: string[]): Promise<string> {
    const path = join(this.paths.evidenceDir, 'final-tree.txt');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${files.join('\n')}\n`, 'utf8');
    return path;
  }

  private async recordCheck(role: string, kind: string, result: unknown): Promise<string> {
    const seq = this.nextSeq(role);
    const path = join(this.paths.checksDir, `${role}-${seq}-${kind}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeJson(path, {
      role,
      seq,
      timestamp: new Date().toISOString(),
      kind,
      result
    });
    return path;
  }
}

function sanitize(s: string): string {
  return s.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
}

