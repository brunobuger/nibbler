import { join } from 'node:path';

import type { ProjectState } from '../workspace/scanner.js';
import { fileExists, readText } from '../utils/fs.js';

export interface ArtifactIssue {
  severity: 'error' | 'warning';
  message: string;
}

export interface ArtifactQualityReport {
  file: string; // repo-root relative
  exists: boolean;
  issues: ArtifactIssue[];
  score: 'good' | 'needs-improvement' | 'insufficient';
}

export interface ArtifactValidationOptions {
  requireVision?: boolean; // default: true
  requireArchitecture?: boolean; // default: true
  requirePrd?: boolean; // default: false (optional)
}

export async function validateArtifacts(
  repoRoot: string,
  project: ProjectState,
  opts: ArtifactValidationOptions = {}
): Promise<ArtifactQualityReport[]> {
  const requireVision = opts.requireVision !== false;
  const requireArchitecture = opts.requireArchitecture !== false;
  const requirePrd = opts.requirePrd === true;

  const visionRel = project.visionMdPath ?? 'vision.md';
  const archRel = project.architectureMdPath ?? 'architecture.md';
  const prdRel = project.prdMdPath ?? 'PRD.md';

  const [vision, architecture, prd] = await Promise.all([
    validateVision(repoRoot, visionRel, { required: requireVision }),
    validateArchitecture(repoRoot, archRel, { required: requireArchitecture }),
    validatePrd(repoRoot, prdRel, { required: requirePrd })
  ]);

  return [vision, architecture, prd];
}

async function validateVision(repoRoot: string, rel: string, cfg: { required: boolean }): Promise<ArtifactQualityReport> {
  const abs = join(repoRoot, rel);
  const exists = await fileExists(abs);
  const issues: ArtifactIssue[] = [];

  if (!exists) {
    if (cfg.required) issues.push({ severity: 'error', message: `${rel} not found` });
    else issues.push({ severity: 'warning', message: `${rel} not found (optional)` });
    return { file: rel, exists, issues, score: scoreFromIssues(issues) };
  }

  const content = (await readText(abs)).trim();
  if (content.length < 120) {
    issues.push({ severity: 'error', message: `${rel} is too short to be a useful product vision` });
    return { file: rel, exists, issues, score: scoreFromIssues(issues) };
  }

  const lower = content.toLowerCase();
  const hasAudience = /\b(user|users|customer|customers|audience|persona|target)\b/.test(lower);
  const hasPurpose = /\b(problem|why|goal|vision|mission|we are building|build)\b/.test(lower);
  if (!hasAudience) issues.push({ severity: 'warning', message: `${rel} does not clearly state the target users/audience` });
  if (!hasPurpose) issues.push({ severity: 'warning', message: `${rel} does not clearly state the problem/goal` });

  return { file: rel, exists, issues, score: scoreFromIssues(issues) };
}

async function validateArchitecture(repoRoot: string, rel: string, cfg: { required: boolean }): Promise<ArtifactQualityReport> {
  const abs = join(repoRoot, rel);
  const exists = await fileExists(abs);
  const issues: ArtifactIssue[] = [];

  if (!exists) {
    if (cfg.required) issues.push({ severity: 'error', message: `${rel} not found` });
    else issues.push({ severity: 'warning', message: `${rel} not found (optional)` });
    return { file: rel, exists, issues, score: scoreFromIssues(issues) };
  }

  const content = (await readText(abs)).trim();
  if (content.length < 200) {
    issues.push({ severity: 'error', message: `${rel} is too short to describe a technical architecture` });
    return { file: rel, exists, issues, score: scoreFromIssues(issues) };
  }

  const headings = extractHeadings(content);
  const lower = content.toLowerCase();

  const sections = {
    techStack: hasAny(headings, ['tech stack', 'technology', 'stack', 'dependencies', 'languages', 'framework']),
    components: hasAny(headings, ['architecture', 'components', 'modules', 'services', 'structure', 'system design']),
    data: hasAny(headings, ['data', 'database', 'storage', 'persistence', 'schema', 'model']),
    deployment: hasAny(headings, ['deployment', 'infrastructure', 'infra', 'hosting', 'operations', 'ci', 'cd', 'runtime']),
  };

  const found = Object.entries(sections)
    .filter(([, ok]) => ok)
    .map(([k]) => k);

  if (found.length < 2) {
    issues.push({
      severity: 'error',
      message: `${rel} appears to be missing major sections (tech stack, components, data, deployment). Add explicit headings for at least the key areas.`
    });
    return { file: rel, exists, issues, score: scoreFromIssues(issues) };
  }

  if (!sections.techStack && !/\b(node|typescript|javascript|python|go|java|rust|postgres|mysql|sqlite|redis)\b/.test(lower)) {
    issues.push({ severity: 'warning', message: `${rel} does not clearly describe the chosen tech stack` });
  }
  if (!sections.data && !/\b(database|storage|persist|cache|schema)\b/.test(lower)) {
    issues.push({ severity: 'warning', message: `${rel} does not clearly describe the data/storage approach` });
  }
  if (!sections.deployment && !/\bdeploy|deployment|host|infra|docker|kubernetes|ci\/cd|pipeline\b/.test(lower)) {
    issues.push({ severity: 'warning', message: `${rel} does not clearly describe deployment/infrastructure expectations` });
  }
  if (!/\b(decision|trade-?off|rationale|alternative|why)\b/.test(lower)) {
    issues.push({ severity: 'warning', message: `${rel} lacks explicit decisions/tradeoffs (add rationale for key choices)` });
  }

  return { file: rel, exists, issues, score: scoreFromIssues(issues) };
}

async function validatePrd(repoRoot: string, rel: string, cfg: { required: boolean }): Promise<ArtifactQualityReport> {
  const abs = join(repoRoot, rel);
  const exists = await fileExists(abs);
  const issues: ArtifactIssue[] = [];

  if (!exists) {
    if (cfg.required) issues.push({ severity: 'error', message: `${rel} not found` });
    else issues.push({ severity: 'warning', message: `${rel} not found (optional but recommended)` });
    return { file: rel, exists, issues, score: scoreFromIssues(issues) };
  }

  const content = (await readText(abs)).trim();
  if (content.length < 200) {
    issues.push({ severity: 'error', message: `${rel} is too short to be a useful PRD` });
    return { file: rel, exists, issues, score: scoreFromIssues(issues) };
  }

  const headings = extractHeadings(content);
  const lower = content.toLowerCase();

  const hasProblem = hasAny(headings, ['problem', 'background', 'overview', 'motivation', 'context']) || /\bproblem\b/.test(lower);
  const hasScope = hasAny(headings, ['scope', 'goals', 'non-goals', 'out of scope', 'out-of-scope']) || /\b(out of scope|non-goals?)\b/.test(lower);
  const hasRequirements =
    hasAny(headings, ['requirements', 'user stories', 'acceptance criteria', 'functional requirements']) ||
    /\b(requirements?|acceptance criteria|user stor(y|ies))\b/.test(lower);
  const hasWorkflows = hasAny(headings, ['workflow', 'workflows', 'use cases', 'user journey', 'flows']) || /\b(workflow|use case|user journey|flow)\b/.test(lower);

  const present = [hasProblem, hasScope, hasRequirements, hasWorkflows].filter(Boolean).length;
  if (present < 2) {
    issues.push({
      severity: 'error',
      message: `${rel} appears to be missing core PRD structure (problem, scope, requirements/workflows). Add explicit sections so planning can be deterministic.`
    });
    return { file: rel, exists, issues, score: scoreFromIssues(issues) };
  }

  if (!hasProblem) issues.push({ severity: 'warning', message: `${rel} does not clearly state the problem/background` });
  if (!hasScope) issues.push({ severity: 'warning', message: `${rel} does not clearly define scope and non-goals` });
  if (!hasRequirements) issues.push({ severity: 'warning', message: `${rel} does not include concrete requirements (user stories / acceptance criteria)` });
  if (!hasWorkflows) issues.push({ severity: 'warning', message: `${rel} does not describe key user workflows/use-cases` });

  return { file: rel, exists, issues, score: scoreFromIssues(issues) };
}

function scoreFromIssues(issues: ArtifactIssue[]): ArtifactQualityReport['score'] {
  if (issues.some((i) => i.severity === 'error')) return 'insufficient';
  if (issues.length > 0) return 'needs-improvement';
  return 'good';
}

function extractHeadings(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^#{1,6}\s+/.test(l))
    .map((l) => l.replace(/^#{1,6}\s+/, '').trim().toLowerCase());
}

function hasAny(headings: string[], needles: string[]): boolean {
  const hs = headings.join('\n');
  return needles.some((n) => hs.includes(n.toLowerCase()));
}

