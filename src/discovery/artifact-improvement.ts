import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunnerAdapter } from '../core/session/runner.js';
import type { SessionHandle } from '../core/session/types.js';
import type { ProjectState } from '../workspace/scanner.js';
import { clearRoleOverlays, writeRoleOverlay } from '../workspace/layout.js';
import { fileExists, readText, writeJson, writeText } from '../utils/fs.js';
import type { ArtifactQualityReport } from './artifact-validator.js';

export interface ArtifactImprovementOptions {
  workspace: string;
  runner: RunnerAdapter;
  project: ProjectState;
  reports: ArtifactQualityReport[];
  outputDirAbs: string; // absolute output directory (staging)
  sessionLogPath: string;
  timeoutMs?: number; // default: 10 minutes
}

export interface ArtifactImprovementResult {
  proposed: Array<{ targetRel: string; proposedAbs: string }>;
}

/**
 * Generate proposed improvements for artifacts into a staging directory.
 * The agent MUST NOT write to repo-root docs directly; it writes proposals under outputDirAbs.
 */
export async function runArtifactImprovement(opts: ArtifactImprovementOptions): Promise<ArtifactImprovementResult> {
  const { workspace, runner, project, reports, outputDirAbs, sessionLogPath } = opts;
  const timeoutMs = Math.max(10_000, Math.floor(opts.timeoutMs ?? 600_000));

  await mkdir(outputDirAbs, { recursive: true });

  // Tight write scope: only staging.
  const configDir = join(workspace, '.nibbler', 'config', 'cursor-profiles', 'artifact-improve');
  await mkdir(configDir, { recursive: true });
  await writeJson(join(configDir, 'cli-config.json'), artifactImproveCliConfig());

  // Ensure log parent exists.
  await mkdir(join(sessionLogPath, '..'), { recursive: true });

  const prompt = renderArtifactImprovementPrompt({
    repoRoot: workspace,
    outputDirAbs,
    project,
    reports
  });

  await clearRoleOverlays(workspace);
  await writeRoleOverlay(workspace, 'architect', prompt);

  // Keep a durable copy for debugging (best effort).
  if (process.env.NIBBLER_VERBOSE === '1') {
    await writeText(join(outputDirAbs, 'prompt.txt'), prompt).catch(() => undefined);
  }

  const handle = await runner.spawn(
    workspace,
    { NIBBLER_SESSION_LOG_PATH: sessionLogPath },
    configDir,
    { mode: 'normal', interactive: runner.capabilities().interactive, taskType: 'plan' }
  );
  try {
    await runner.send(handle, prompt);
    await waitForPhaseCompleteOrDone(runner, handle, timeoutMs);
  } finally {
    await runner.stop(handle).catch(() => undefined);
  }

  const proposed: Array<{ targetRel: string; proposedAbs: string }> = [];
  for (const r of reports) {
    const proposedAbs = join(outputDirAbs, r.file);
    if (await fileExists(proposedAbs)) {
      // Ignore empty proposals.
      const content = (await readText(proposedAbs)).trim();
      if (content.length > 0) proposed.push({ targetRel: r.file, proposedAbs });
    }
  }

  return { proposed };
}

function artifactImproveCliConfig(): any {
  return {
    version: 1,
    editor: { vimMode: false },
    permissions: {
      allow: ['Read(**/*)', 'Write(.nibbler-staging/**)'],
      deny: ['Write(.nibbler/**)', 'Write(.cursor/**)', 'Read(.env*)', 'Read(**/.env*)', 'Write(**/*.key)']
    }
  };
}

function renderArtifactImprovementPrompt(ctx: {
  repoRoot: string;
  outputDirAbs: string;
  project: ProjectState;
  reports: ArtifactQualityReport[];
}): string {
  const outputDirRel = ctx.outputDirAbs.startsWith(ctx.repoRoot)
    ? ctx.outputDirAbs.slice(ctx.repoRoot.length).replace(/^\/+/, '')
    : '.nibbler-staging/artifact-improvements';

  const lines: string[] = [];
  lines.push('You are the Architect agent running in ARTIFACT IMPROVEMENT mode for Nibbler.');
  lines.push('');
  lines.push('## Mission');
  lines.push('- Read the existing repository documents and codebase context.');
  lines.push('- Propose IMPROVEMENTS to the listed artifacts that address the structural issues reported by the engine.');
  lines.push('- DO NOT modify repo-root docs directly.');
  lines.push(`- Write your proposed improved versions ONLY under this staging directory: ${outputDirRel}`);
  lines.push('');
  lines.push('## Rules');
  lines.push('- Preserve filenames exactly as listed (case-sensitive).');
  lines.push('- Keep changes additive/clarifying; do not invent unknown facts.');
  lines.push('- If something is unknown, add a TODO/Assumption block and keep it explicit.');
  lines.push('');
  lines.push('## Inputs available');
  lines.push(`- repoRoot: ${ctx.repoRoot}`);
  lines.push(`- hasPRD: ${ctx.project.hasPrdMd ? 'yes' : 'no'}`);
  lines.push(`- hasVision: ${ctx.project.hasVisionMd ? 'yes' : 'no'}`);
  lines.push(`- hasArchitecture: ${ctx.project.hasArchitectureMd ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Artifacts to improve (engine report)');
  lines.push('For each artifact below, write an improved version to the corresponding staging output path.');
  lines.push('');
  lines.push('```text');
  for (const r of ctx.reports) {
    lines.push(`${r.file} -> ${join(outputDirRel, r.file)}`);
    for (const i of r.issues) lines.push(`  - [${i.severity}] ${i.message}`);
    if (r.issues.length === 0) lines.push('  - (no issues)');
    lines.push('');
  }
  lines.push('```');
  lines.push('');
  lines.push('## Completion protocol');
  lines.push('When proposals are written, emit:');
  lines.push('NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"artifact improvement proposals complete"}');
  lines.push('');
  return lines.join('\n');
}

async function waitForPhaseCompleteOrDone(runner: RunnerAdapter, handle: SessionHandle, timeoutMs: number): Promise<void> {
  const it = runner.readEvents(handle)[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Artifact improvement session timed out after ${timeoutMs}ms`);
    const next = await nextWithTimeout(it, Math.min(remaining, 5_000));
    if (next.done) return;
    if (!next.timedOut && next.value?.type === 'PHASE_COMPLETE') return;
    // Continue draining until completion or process ends.
  }
}

async function nextWithTimeout<T>(
  it: AsyncIterator<T>,
  timeoutMs: number
): Promise<{ timedOut: boolean; done: boolean; value: T }> {
  let t: any;
  try {
    const race = await Promise.race([
      it.next(),
      new Promise<{ timedOut: true }>((resolve) => {
        t = setTimeout(() => resolve({ timedOut: true } as any), timeoutMs);
      })
    ]);
    if ((race as any).timedOut) return { timedOut: true, done: false, value: undefined as any };
    const r = race as IteratorResult<T>;
    return { timedOut: false, done: !!r.done, value: r.value as any };
  } finally {
    if (t) clearTimeout(t);
  }
}

