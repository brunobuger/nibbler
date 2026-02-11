import type { ProjectClassification, ProjectState } from '../workspace/scanner.js';
import type { IngestedContext } from '../discovery/types.js';

export interface DiscoveryPromptContext {
  repoRoot: string;
  project: ProjectState;
  classification?: ProjectClassification | null;
  ingested?: IngestedContext;
  providedFiles: string[];
  outputVisionPathRel?: string; // default: vision.md
  outputArchitecturePathRel?: string; // default: architecture.md
  maxQuestionsPerRound?: number; // default: 3
  priorQnA?: Array<{ question: string; answer: string }>;
}

/**
 * Prompt for the discovery agent session.
 *
 * Design goals:
 * - Avoid hardcoded questionnaires.
 * - Force the agent to read existing inputs first.
 * - Ask only for missing info, in small batches.
 * - Produce durable artifacts: vision.md + architecture.md.
 */
export function renderDiscoveryPrompt(ctx: DiscoveryPromptContext): string {
  const visionRel = ctx.outputVisionPathRel ?? 'vision.md';
  const archRel = ctx.outputArchitecturePathRel ?? 'architecture.md';
  const maxQ = Math.max(1, Math.min(ctx.maxQuestionsPerRound ?? 3, 3));

  const lines: string[] = [];

  lines.push('You are the Architect agent running in DISCOVERY mode for Nibbler.');
  lines.push('');
  lines.push('## Mission');
  lines.push('- Read the existing repository files and any provided documents.');
  lines.push('- Extract a complete enough product vision to plan implementation.');
  lines.push(`- Write/overwrite these durable artifacts at repo root: ${visionRel}, ${archRel}`);
  lines.push('- Ask the Product Owner questions ONLY if genuinely required to fill gaps.');
  lines.push('');

  lines.push('## How to behave');
  lines.push('- Do not ask a long questionnaire.');
  lines.push('- First, read the available inputs and infer answers when possible.');
  lines.push('- Only ask for what is missing or ambiguous.');
  lines.push('- Ask questions in small batches (max 3).');
  lines.push('- If the inputs already answer something, do not ask it again.');
  lines.push('');

  // Guidance (non-prescriptive) – adapted from PRD tiering, but not a schema.
  lines.push('## What information is typically needed (guidance, not a checklist)');
  lines.push('- Product: problem, target users, one-sentence description, core loop, MVP workflows, out-of-scope.');
  lines.push('- Access: user types/roles, auth model (if any), hierarchy (if any).');
  lines.push('- Constraints: timeline/budget, compliance/security, deployment expectations, integrations.');
  lines.push('- Data model: key entities and relationships (conceptual).');
  lines.push('- Success: success metrics and near-term roadmap notes (optional).');
  lines.push('');

  lines.push('## Inputs available');
  lines.push(`- repoRoot: ${ctx.repoRoot}`);
  lines.push(
    `- providedFiles: ${ctx.providedFiles.length ? ctx.providedFiles.map((p) => toContextRef(p, ctx.repoRoot)).join(', ') : '(none)'}`
  );
  lines.push(`- hasPRD: ${ctx.project.hasPrdMd ? 'yes' : 'no'}`);
  lines.push(`- hasExistingVision: ${ctx.project.hasVisionMd ? 'yes' : 'no'}`);
  lines.push(`- hasExistingArchitecture: ${ctx.project.hasArchitectureMd ? 'yes' : 'no'}`);
  if (ctx.classification?.projectType) {
    lines.push(`- projectTypeGuess: ${ctx.classification.projectType} (${ctx.classification.confidence} confidence)`);
    if (ctx.classification.traits.length) lines.push(`- traits: ${ctx.classification.traits.join(', ')}`);
    if (ctx.classification.reasons.length) lines.push(`- reasons: ${ctx.classification.reasons.join(', ')}`);
  } else if (ctx.project.projectType) {
    lines.push(`- projectTypeGuess: ${ctx.project.projectType} (${ctx.project.classificationConfidence ?? 'low'} confidence)`);
    if (ctx.project.traits?.length) lines.push(`- traits: ${ctx.project.traits.join(', ')}`);
    if (ctx.project.classificationReasons?.length) lines.push(`- reasons: ${ctx.project.classificationReasons.join(', ')}`);
  }
  lines.push('');

  if (ctx.priorQnA && ctx.priorQnA.length) {
    lines.push('## Prior Q&A (authoritative)');
    lines.push('Use these answers; do not re-ask them.');
    lines.push('```text');
    for (const qa of ctx.priorQnA) {
      lines.push(`Q: ${qa.question}`);
      lines.push(`A: ${qa.answer}`);
      lines.push('');
    }
    lines.push('```');
    lines.push('');
  }

  lines.push('## Output requirements');
  lines.push(`- Write ${visionRel} as a structured product brief (human-readable, concise but complete enough to plan).`);
  lines.push(`- Write ${archRel} as a technical architecture aligned to the vision and existing repo (if any).`);
  lines.push('- If the repo already has architecture/vision docs, reconcile and update them to match reality.');
  lines.push('- Keep decisions explicit, but avoid over-specifying.');
  lines.push('');

  lines.push('## Question protocol');
  lines.push(`If you need PO input, emit exactly one single-line event like this, then stop:`);
  lines.push('```text');
  lines.push(`NIBBLER_EVENT {"type":"QUESTIONS","questions":["Question 1","Question 2"]}`);
  lines.push('```');
  lines.push(`- Ask at most ${maxQ} questions per event.`);
  lines.push('- Questions must be specific and only for missing info.');
  lines.push('');

  lines.push('## Completion protocol');
  lines.push('When discovery is complete (and the artifacts are written), emit:');
  lines.push('```text');
  lines.push('NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"discovery complete"}');
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

function toContextRef(path: string, repoRoot: string): string {
  const p = String(path ?? '').trim();
  if (!p) return '(unknown)';
  // Keep cross-repo absolute paths as plain text hints (Cursor cannot always resolve them).
  if (p.startsWith('/') && !p.startsWith(`${repoRoot.replace(/\/+$/, '')}/`)) {
    return p;
  }
  const rel = p.startsWith(`${repoRoot.replace(/\/+$/, '')}/`)
    ? p.slice(repoRoot.replace(/\/+$/, '').length + 1)
    : p;
  if (rel.startsWith('@')) return rel;
  return `@${rel}`;
}

