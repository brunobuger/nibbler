import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { RunnerAdapter } from '../core/session/runner.js';
import type { NibblerEvent } from '../core/session/types.js';
import { CursorRunnerAdapter } from '../core/session/cursor-adapter.js';
import { scanProjectState, type ProjectClassification, type ProjectState } from '../workspace/scanner.js';
import { clearRoleOverlays, writeRoleOverlay } from '../workspace/layout.js';
import { fileExists, writeJson } from '../utils/fs.js';
import { promptInput } from '../cli/ui/prompts.js';
import { ingestMaterials } from './ingestion.js';
import type { IngestedContext } from './types.js';
import { renderDiscoveryPrompt } from '../templates/discovery-prompt.js';

export interface DiscoveryRunOptions {
  workspace: string;
  providedFiles: string[];
  planDir: string;
  runner?: RunnerAdapter;
  maxQuestionRounds?: number;
  maxQuestionsPerRound?: number;
  roundTimeoutMs?: number;
  projectState?: ProjectState;
  classification?: ProjectClassification | null;
}

export interface DiscoveryResult {
  context: IngestedContext;
  qna: Array<{ question: string; answer: string }>;
  wroteVision: boolean;
  wroteArchitecture: boolean;
  discoveryPlanPath: string;
}

/**
 * Run AI-driven discovery.
 *
 * This is intentionally NOT a hardcoded questionnaire. A Cursor agent reads the inputs,
 * asks only for genuine gaps (via NIBBLER_EVENT QUESTIONS), and writes vision.md + architecture.md.
 *
 * Works with both interactive runners and one-shot runners:
 * - If runner.capabilities().interactive, a single session is kept open and answers are sent back.
 * - Otherwise, we loop by spawning new sessions with prior Q&A included.
 */
export async function runDiscovery(opts: DiscoveryRunOptions): Promise<DiscoveryResult> {
  const workspace = resolve(opts.workspace);
  const planDir = resolve(opts.planDir);
  const providedFiles = (opts.providedFiles ?? []).map((p) => resolve(p));

  const runner = opts.runner ?? new CursorRunnerAdapter();
  const maxRounds = Math.max(1, opts.maxQuestionRounds ?? 12);
  const maxPerRound = Math.max(1, Math.min(opts.maxQuestionsPerRound ?? 3, 3));
  const roundTimeoutMs = resolveRoundTimeoutMs(opts.roundTimeoutMs);
  const verbose = process.env.NIBBLER_VERBOSE === '1';

  const project = opts.projectState ?? (await scanProjectState(workspace));
  const classification = opts.classification ?? null;
  const context = await ingestMaterials(providedFiles, workspace);

  const qna: Array<{ question: string; answer: string }> = [];
  const discoveryPlanPath = join(planDir, 'discovery.json');
  const sessionLogsDir = join(planDir, 'sessions');

  await mkdir(planDir, { recursive: true });
  await writeDiscoveryPlan(discoveryPlanPath, { project, classification, providedFiles, context, qna });

  // If the repo already has both artifacts, consider discovery complete.
  const visionAbs = join(workspace, 'vision.md');
  const archAbs = join(workspace, 'architecture.md');
  if (await fileExists(visionAbs) && await fileExists(archAbs)) {
    return { context, qna, wroteVision: true, wroteArchitecture: true, discoveryPlanPath };
  }

  const supportsInteractive = runner.capabilities().interactive;

  if (supportsInteractive) {
    await runInteractiveDiscoverySession({
      workspace,
      runner,
      project,
      classification,
      context,
      providedFiles,
      qna,
      maxRounds,
      maxPerRound,
      roundTimeoutMs,
      sessionLogPath: join(sessionLogsDir, `discovery-interactive.log`),
      verbose
    });
  } else {
    // One-shot fallback: each iteration is a fresh agent invocation with accumulated Q&A.
    for (let round = 1; round <= maxRounds; round += 1) {
      const ev = await runOneShotDiscoveryRound({
        workspace,
        runner,
        project,
        classification,
        context,
        providedFiles,
        qna,
        maxPerRound,
        round,
        roundTimeoutMs,
        sessionLogPath: join(sessionLogsDir, `discovery-round-${round}.log`),
        verbose
      });

      if (ev?.type === 'QUESTIONS') {
        await collectAnswers(ev.questions, qna);
        await writeDiscoveryPlan(discoveryPlanPath, { project, classification, providedFiles, context, qna });
        continue;
      }
      if (ev?.type === 'QUESTION') {
        await collectAnswers([ev.text], qna);
        await writeDiscoveryPlan(discoveryPlanPath, { project, classification, providedFiles, context, qna });
        continue;
      }
      if (ev?.type === 'PHASE_COMPLETE') break;
      // Any other event is treated as terminal for now.
      break;
    }
  }

  await writeDiscoveryPlan(discoveryPlanPath, { project, classification, providedFiles, context, qna });

  const wroteVision = await fileExists(visionAbs);
  const wroteArchitecture = await fileExists(archAbs);
  if (!wroteVision || !wroteArchitecture) {
    throw new Error(
      `Discovery did not produce required artifacts: ${!wroteVision ? 'vision.md ' : ''}${!wroteArchitecture ? 'architecture.md' : ''}`.trim()
    );
  }

  return { context, qna, wroteVision, wroteArchitecture, discoveryPlanPath };
}

async function runInteractiveDiscoverySession(args: {
  workspace: string;
  runner: RunnerAdapter;
  project: ProjectState;
  classification: ProjectClassification | null;
  context: IngestedContext;
  providedFiles: string[];
  qna: Array<{ question: string; answer: string }>;
  maxRounds: number;
  maxPerRound: number;
  roundTimeoutMs: number;
  sessionLogPath: string;
  verbose: boolean;
}): Promise<void> {
  const { workspace, runner, project, classification, context, providedFiles, qna, maxRounds, maxPerRound, roundTimeoutMs, sessionLogPath, verbose } = args;

  // Prepare a dedicated config dir for discovery (tight write scope).
  const configDir = join(workspace, '.nibbler', 'config', 'cursor-profiles', 'discovery');
  await mkdir(configDir, { recursive: true });
  await writeJson(join(configDir, 'cli-config.json'), discoveryCliConfig());

  // Ensure planDir/session log parent exists for Cursor adapter log writing.
  await mkdir(join(sessionLogPath, '..'), { recursive: true });

  await clearRoleOverlays(workspace);
  const prompt = renderDiscoveryPrompt({
    repoRoot: workspace,
    project,
    classification,
    ingested: context,
    providedFiles,
    priorQnA: qna,
    maxQuestionsPerRound: maxPerRound
  });
  await writeRoleOverlay(workspace, 'architect', prompt);

  if (verbose) {
    // Keep a durable copy of the prompt for debugging.
    await writeJson(join(workspace, '.nibbler-staging', 'discovery', 'prompt.meta.json'), {
      generatedAtIso: new Date().toISOString(),
      session: 'interactive',
      sessionLogPath,
      roundTimeoutMs
    }).catch(() => undefined);
  }

  const handle = await runner.spawn(
    workspace,
    { NIBBLER_SESSION_LOG_PATH: sessionLogPath },
    configDir,
    { mode: 'normal', interactive: true, taskType: 'plan' }
  );
  try {
    await runner.send(handle, prompt);

    let rounds = 0;
    const it = runner.readEvents(handle)[Symbol.asyncIterator]();
    while (true) {
      const next = await nextWithTimeout(it, roundTimeoutMs);
      if (next.timedOut) {
        throw new Error(`Discovery session timed out after ${roundTimeoutMs}ms. See log: ${sessionLogPath}`);
      }
      if (next.done) return;
      const ev = next.value;
      if (ev.type === 'PHASE_COMPLETE') return;

      if (ev.type === 'QUESTIONS') {
        rounds += 1;
        if (rounds > maxRounds) throw new Error('Discovery exceeded question rounds budget');

        const qs = ev.questions.slice(0, maxPerRound);
        await collectAnswers(qs, qna);
        await runner.send(handle, formatAnswersMessage(qs, qna));
        continue;
      }

      if (ev.type === 'QUESTION') {
        rounds += 1;
        if (rounds > maxRounds) throw new Error('Discovery exceeded question rounds budget');

        const qs = [ev.text].slice(0, maxPerRound);
        await collectAnswers(qs, qna);
        await runner.send(handle, formatAnswersMessage(qs, qna));
        continue;
      }

      if (ev.type === 'NEEDS_ESCALATION') {
        throw new Error(`Discovery agent needs escalation: ${ev.reason ?? 'unknown reason'}`);
      }
      if (ev.type === 'EXCEPTION') {
        throw new Error(`Discovery agent requested product exception: ${ev.reason ?? 'unknown reason'}`);
      }
    }
  } finally {
    await runner.stop(handle).catch(() => undefined);
  }
}

async function runOneShotDiscoveryRound(args: {
  workspace: string;
  runner: RunnerAdapter;
  project: ProjectState;
  classification: ProjectClassification | null;
  context: IngestedContext;
  providedFiles: string[];
  qna: Array<{ question: string; answer: string }>;
  maxPerRound: number;
  round: number;
  roundTimeoutMs: number;
  sessionLogPath: string;
  verbose: boolean;
}): Promise<NibblerEvent | null> {
  const { workspace, runner, project, classification, context, providedFiles, qna, maxPerRound, round, roundTimeoutMs, sessionLogPath, verbose } = args;

  const configDir = join(workspace, '.nibbler', 'config', 'cursor-profiles', 'discovery');
  await mkdir(configDir, { recursive: true });
  await writeJson(join(configDir, 'cli-config.json'), discoveryCliConfig());

  await mkdir(join(sessionLogPath, '..'), { recursive: true });

  await clearRoleOverlays(workspace);
  const prompt = renderDiscoveryPrompt({
    repoRoot: workspace,
    project,
    classification,
    ingested: context,
    providedFiles,
    priorQnA: qna,
    maxQuestionsPerRound: maxPerRound
  });
  await writeRoleOverlay(workspace, 'architect', prompt);

  if (verbose) {
    await writeJson(join(workspace, '.nibbler-staging', 'discovery', `prompt-round-${round}.json`), {
      generatedAtIso: new Date().toISOString(),
      round,
      sessionLogPath,
      roundTimeoutMs
    }).catch(() => undefined);
  }

  const handle = await runner.spawn(
    workspace,
    { NIBBLER_SESSION_LOG_PATH: sessionLogPath },
    configDir,
    { mode: 'normal', interactive: false, taskType: 'plan' }
  );
  try {
    await runner.send(handle, prompt);
    const it = runner.readEvents(handle)[Symbol.asyncIterator]();
    const next = await nextWithTimeout(it, roundTimeoutMs);
    if (next.timedOut) {
      throw new Error(`Discovery session timed out after ${roundTimeoutMs}ms. See log: ${sessionLogPath}`);
    }
    if (next.done) return null;
    return next.value;
  } finally {
    await runner.stop(handle).catch(() => undefined);
  }
}

async function collectAnswers(questions: string[], qna: Array<{ question: string; answer: string }>): Promise<void> {
  for (const q of questions) {
    const ans =
      process.env.NIBBLER_TEST_AUTO_APPROVE === '1' || process.env.NIBBLER_TEST_DISCOVERY_AUTO === '1'
        ? 'test'
        : await promptInput({ message: q });
    qna.push({ question: q, answer: (ans ?? '').trim() });
  }
}

function formatAnswersMessage(justAsked: string[], qna: Array<{ question: string; answer: string }>): string {
  const answers = justAsked.map((q) => {
    const last = [...qna].reverse().find((qa) => qa.question === q);
    return { question: q, answer: last?.answer ?? '' };
  });

  const lines: string[] = [];
  lines.push('Here are the PO answers to your last questions:');
  lines.push('```text');
  for (const a of answers) {
    lines.push(`Q: ${a.question}`);
    lines.push(`A: ${a.answer}`);
    lines.push('');
  }
  lines.push('```');
  lines.push('Continue discovery. If more input is needed, emit another QUESTIONS event. Otherwise, write vision.md and architecture.md and emit PHASE_COMPLETE.');
  return lines.join('\n');
}

function discoveryCliConfig(): any {
  return {
    version: 1,
    editor: { vimMode: false },
    permissions: {
      allow: ['Read(**/*)', 'Write(vision.md)', 'Write(architecture.md)', 'Write(.nibbler-staging/**)'],
      deny: ['Write(.nibbler/**)', 'Write(.cursor/**)', 'Read(.env*)', 'Read(**/.env*)', 'Write(**/*.key)']
    }
  };
}

async function writeDiscoveryPlan(
  discoveryPlanPath: string,
  value: {
    project: ProjectState;
    classification: ProjectClassification | null;
    providedFiles: string[];
    context: IngestedContext;
    qna: Array<{ question: string; answer: string }>;
  }
): Promise<void> {
  await writeJson(discoveryPlanPath, {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    providedFiles: value.providedFiles,
    repoState: value.context.repoState,
    classification: value.classification,
    scan: {
      kind: value.project.kind,
      hasPrdMd: value.project.hasPrdMd,
      hasVisionMd: value.project.hasVisionMd,
      hasArchitectureMd: value.project.hasArchitectureMd,
      hasPackageJson: value.project.hasPackageJson,
      hasSrcDir: value.project.hasSrcDir,
      topLevelEntries: value.project.topLevelEntries
    },
    qna: value.qna
  });
}

function resolveRoundTimeoutMs(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const fromEnv = Number(process.env.NIBBLER_DISCOVERY_ROUND_TIMEOUT_MS ?? '');
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  // Default: 3 minutes per discovery round.
  return 180_000;
}

async function nextWithTimeout<T>(
  it: AsyncIterator<T>,
  timeoutMs: number
): Promise<{ timedOut: boolean; done: boolean; value: T }> {
  const t = new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), timeoutMs));
  const n = it.next();
  const raced = await Promise.race([n, t]);
  if ((raced as any)?.timedOut === true) return { timedOut: true, done: false, value: undefined as any };
  const res = raced as IteratorResult<T>;
  return { timedOut: false, done: !!res.done, value: res.value as T };
}

