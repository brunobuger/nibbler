import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { fileExists, readText, resolveDocVariant } from '../utils/fs.js';
import { ingestMaterials } from '../discovery/ingestion.js';
import { classifyProjectTypeDetailed } from '../discovery/classification.js';
import { detectTraits } from '../discovery/traits.js';
import type { Confidence, ProjectType } from '../discovery/types.js';

export interface ProjectState {
  repoRoot: string;
  hasContract: boolean;
  hasArchitectureMd: boolean;
  hasVisionMd: boolean;
  hasPrdMd: boolean;
  /**
   * Resolved doc filename (relative to repo root), preserving on-disk casing.
   * Present only when the file exists.
   */
  architectureMdPath?: string;
  /**
   * Resolved doc filename (relative to repo root), preserving on-disk casing.
   * Present only when the file exists.
   */
  visionMdPath?: string;
  /**
   * Resolved doc filename (relative to repo root), preserving on-disk casing.
   * Present only when the file exists.
   */
  prdMdPath?: string;
  hasPackageJson: boolean;
  hasSrcDir: boolean;
  topLevelEntries: string[];
  packageJsonPreview?: { name?: string; dependenciesCount?: number; devDependenciesCount?: number; bin?: unknown };
  kind: 'greenfield' | 'existing';
  projectType?: ProjectType;
  traits?: string[];
  classificationConfidence?: Confidence;
  classificationReasons?: string[];
}

async function listDir(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => e.name).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Resolve the filename variant that exists (if any), preserving casing.
 */
async function resolveExistingDoc(repoRoot: string, variants: string[], defaultName: string): Promise<{ exists: boolean; rel?: string }> {
  const rel = await resolveDocVariant(repoRoot, variants, defaultName);
  const exists = await fileExists(join(repoRoot, rel));
  return { exists, rel: exists ? rel : undefined };
}

export async function scanProjectState(repoRoot: string): Promise<ProjectState> {
  const contractDir = join(repoRoot, '.nibbler', 'contract');
  const [topLevelEntries, hasContract, arch, vision, prd, hasPackageJson, hasSrcDir] = await Promise.all([
    listDir(repoRoot),
    fileExists(contractDir),
    resolveExistingDoc(repoRoot, ['architecture.md', 'ARCHITECTURE.md', 'Architecture.md'], 'architecture.md'),
    resolveExistingDoc(repoRoot, ['vision.md', 'VISION.md', 'Vision.md'], 'vision.md'),
    resolveExistingDoc(repoRoot, ['prd.md', 'PRD.md', 'Prd.md'], 'PRD.md'),
    fileExists(join(repoRoot, 'package.json')),
    fileExists(join(repoRoot, 'src'))
  ]);
  const hasArchitectureMd = arch.exists;
  const hasVisionMd = vision.exists;
  const hasPrdMd = prd.exists;

  let packageJsonPreview: ProjectState['packageJsonPreview'];
  if (hasPackageJson) {
    const raw = await readText(join(repoRoot, 'package.json'));
    try {
      const pkg = JSON.parse(raw) as any;
      packageJsonPreview = {
        name: typeof pkg?.name === 'string' ? pkg.name : undefined,
        dependenciesCount: pkg?.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies).length : undefined,
        devDependenciesCount:
          pkg?.devDependencies && typeof pkg.devDependencies === 'object' ? Object.keys(pkg.devDependencies).length : undefined,
        bin: pkg?.bin
      };
    } catch {
      packageJsonPreview = undefined;
    }
  }

  // "existing" = the repo has meaningful content (code or documentation) for the Architect to use.
  const kind: ProjectState['kind'] = hasPackageJson || hasSrcDir || hasArchitectureMd || hasPrdMd ? 'existing' : 'greenfield';

  const classification = await classifyProject(repoRoot).catch(() => null);

  return {
    repoRoot,
    hasContract,
    hasArchitectureMd,
    hasVisionMd,
    hasPrdMd,
    architectureMdPath: arch.rel,
    visionMdPath: vision.rel,
    prdMdPath: prd.rel,
    hasPackageJson,
    hasSrcDir,
    topLevelEntries,
    packageJsonPreview,
    kind,
    projectType: classification?.projectType ?? undefined,
    traits: classification?.traits ?? undefined,
    classificationConfidence: classification?.confidence ?? undefined,
    classificationReasons: classification?.reasons ?? undefined
  };
}

export interface ProjectClassification {
  projectType: ProjectType | null;
  confidence: Confidence;
  reasons: string[];
  traits: string[];
}

/**
 * Classify the repository as early as possible to inform init team composition.
 * This is best-effort and should never throw in normal operation.
 */
export async function classifyProject(repoRoot: string): Promise<ProjectClassification> {
  const ctx = await ingestMaterials([], repoRoot);
  const type = classifyProjectTypeDetailed(ctx);
  const traits = detectTraits(ctx);
  return {
    projectType: type.projectType,
    confidence: type.confidence,
    reasons: type.reasons,
    traits
  };
}

