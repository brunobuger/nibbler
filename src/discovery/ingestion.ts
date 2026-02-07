import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CodebaseSignals, IngestedContext, IngestedFile, RepoState } from './types.js';

async function tryReadText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function safeJson(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function listDirNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => e.name).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function classifyRepoState(signals: CodebaseSignals, provided: IngestedFile[], hasVision: boolean, hasArch: boolean): RepoState {
  const docsProvided = provided.length > 0 || hasVision || hasArch || signals.hasReadme;
  const hasCodeSignals =
    signals.hasPackageJson ||
    signals.topLevelEntries.includes('src') ||
    signals.topLevelEntries.includes('app') ||
    signals.topLevelEntries.includes('lib');

  if (hasCodeSignals) return 'has_code';
  if (docsProvided) return 'docs_only';
  return 'empty';
}

/**
 * Try multiple case-variants of a filename and return the first match.
 * This handles repos where ARCHITECTURE.md vs architecture.md varies.
 */
async function findCaseInsensitive(workspace: string, variants: string[]): Promise<{ path: string; content: string } | null> {
  for (const v of variants) {
    const abs = join(workspace, v);
    const content = await tryReadText(abs);
    if (content !== null) return { path: abs, content };
  }
  return null;
}

export async function ingestMaterials(providedFiles: string[], workspace: string): Promise<IngestedContext> {
  const provided: IngestedFile[] = [];
  for (const p of providedFiles) {
    const content = await tryReadText(p);
    if (content !== null) provided.push({ path: p, content });
  }

  // Case-insensitive detection for common doc files.
  const visionResult = await findCaseInsensitive(workspace, ['vision.md', 'VISION.md', 'Vision.md']);
  const archResult = await findCaseInsensitive(workspace, ['architecture.md', 'ARCHITECTURE.md', 'Architecture.md']);
  const prdResult = await findCaseInsensitive(workspace, ['prd.md', 'PRD.md', 'Prd.md']);

  // PRD is treated as a provided doc (feeds into the text blob for classification).
  if (prdResult && !provided.some((f) => f.path === prdResult.path)) {
    provided.push({ path: prdResult.path, content: prdResult.content });
  }

  const pkgPath = join(workspace, 'package.json');
  const readmePath = join(workspace, 'README.md');

  const [pkgRaw, readmeRaw, topLevelEntries, srcEntries] = await Promise.all([
    tryReadText(pkgPath),
    tryReadText(readmePath),
    listDirNames(workspace),
    listDirNames(join(workspace, 'src'))
  ]);

  const pkg = pkgRaw ? safeJson(pkgRaw) : null;

  const signals: CodebaseSignals = {
    hasPackageJson: pkgRaw !== null,
    packageJson: pkg
      ? {
          name: typeof pkg.name === 'string' ? pkg.name : undefined,
          dependencies: isRecord(pkg.dependencies) ? (pkg.dependencies as Record<string, string>) : undefined,
          devDependencies: isRecord(pkg.devDependencies) ? (pkg.devDependencies as Record<string, string>) : undefined,
          bin: typeof pkg.bin === 'string' || isRecord(pkg.bin) ? (pkg.bin as any) : undefined
        }
      : undefined,
    hasReadme: readmeRaw !== null,
    topLevelEntries,
    srcEntries
  };

  const hasVision = visionResult !== null;
  const hasArch = archResult !== null;

  const repoState = classifyRepoState(signals, provided, hasVision, hasArch);

  return {
    provided,
    existingVision: visionResult ? { path: visionResult.path, content: visionResult.content } : undefined,
    existingArchitecture: archResult ? { path: archResult.path, content: archResult.content } : undefined,
    repoState,
    signals
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

