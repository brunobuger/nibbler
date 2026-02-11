import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { execa } from 'execa';

import { readContract, writeContract } from '../../core/contract/reader.js';
import { validateContract, type ValidationError } from '../../core/contract/validator.js';
import type { Contract } from '../../core/contract/types.js';
import { CursorRunnerAdapter } from '../../core/session/cursor-adapter.js';
import type { RunnerAdapter } from '../../core/session/runner.js';
import type { SessionHandle } from '../../core/session/types.js';
import { fileExists, readText, writeJson, writeText, writeYaml } from '../../utils/fs.js';
import { initWorkspace, writeProtocolRule, writeRoleOverlay, writeWorkflowRules } from '../../workspace/layout.js';
import { scanProjectState } from '../../workspace/scanner.js';
import { renderInitBootstrapPrompt } from '../../templates/bootstrap-prompt.js';
import { commit, git, isClean } from '../../git/operations.js';
import { exampleContracts } from '../../templates/contract-examples/index.js';
import { runDiscovery } from '../../discovery/engine.js';
import { validateArtifacts, type ArtifactQualityReport } from '../../discovery/artifact-validator.js';
import { runArtifactImprovement } from '../../discovery/artifact-improvement.js';
import { getRenderer } from '../ui/renderer.js';
import { theme } from '../ui/theme.js';
import { formatMs } from '../ui/format.js';
import { installCliCancellation } from '../cancel.js';
import { promptInput, promptSelect } from '../ui/prompts.js';

export interface InitCommandOptions {
  repoRoot?: string;
  review?: boolean;
  skipDiscovery?: boolean;
  files?: string[];
  dryRun?: boolean;
  runner?: RunnerAdapter;
}

export async function runInitCommand(opts: InitCommandOptions = {}): Promise<{ ok: boolean; contract?: Contract; errors?: unknown }> {
  const r = getRenderer();
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const runner = opts.runner ?? new CursorRunnerAdapter();
  let activeHandle: SessionHandle | null = null;

  const cancellation = installCliCancellation({
    onCancel: async () => {
      // Best-effort: stop any active Cursor session.
      try {
        r.warn('Cancellation requested. Stopping...');
      } catch {
        // ignore
      }
      if (activeHandle) {
        try {
          await runner.stop(activeHandle);
        } catch {
          // best-effort
        }
      }
    },
    onForceExit: async () => {
      if (!activeHandle) return;
      try {
        await runner.stop(activeHandle);
      } catch {
        // best-effort
      }
    }
  });

  try {
    // ── Step 0: Version + Brand ──────────────────────────────────────────────
    const version = detectVersion(repoRoot);
    r.welcome(version);
    r.blank();

    // ── Step 1: Workspace Scan ───────────────────────────────────────────────
    const scanSpinner = r.spinner('Scanning workspace...');

    await initWorkspace(repoRoot);
    await ensureGitInitialized(repoRoot);
    await ensureGitignore(repoRoot);
    await writeProtocolRule(repoRoot, defaultProtocolRule());

    let project = await scanProjectState(repoRoot);

    // Determine repo cleanliness
    let repoClean = true;
    try {
      repoClean = await isClean(git(repoRoot));
    } catch {
      // ignore — git may not be available in tests
    }

    // Detect language from package.json or file extensions
    let language: string | undefined;
    let fileCount: number | undefined;
    if (project.hasPackageJson) {
      language = 'TypeScript/JavaScript';
      fileCount = project.topLevelEntries.length;
    } else if (project.hasSrcDir) {
      language = 'unknown';
      fileCount = project.topLevelEntries.length;
    }

    scanSpinner.succeed('Workspace scanned');

    r.workspaceScan({
      repoPath: repoRoot,
      isClean: repoClean,
      hasCode: project.kind === 'has_code',
      language,
      fileCount,
      hasArchitecture: project.hasArchitectureMd,
      hasVision: project.hasVisionMd,
      hasPrd: project.hasPrdMd,
      hasContract: project.hasContract,
      isReview: !!opts.review,
      projectType: project.projectType ?? undefined,
      traits: project.traits,
    });

    // ── Step 2: Onboarding Explanation (first-time only) ─────────────────────
    if (!project.hasContract && !opts.review) {
      r.initExplanation();
    }

    // ── Step 3: Discovery (AI-driven, produces vision.md + architecture.md) ─
    {
      const wantDiscovery = !opts.skipDiscovery;
      const hasVision = project.hasVisionMd;
      const hasArch = project.hasArchitectureMd;
      const providedFiles = (opts.files ?? []).map((p) => resolve(p));

      if (!wantDiscovery) {
        if (!hasVision || !hasArch) {
          return {
            ok: false,
            errors: `Discovery skipped but required artifacts are missing: ${!hasVision ? 'vision.md ' : ''}${!hasArch ? 'architecture.md' : ''}`.trim(),
          };
        }
      } else {
        // If either artifact is missing, run discovery.
        if (!hasVision || !hasArch) {
          const discSpinner = r.spinner('Running discovery (vision + architecture)...');
          const discDir = join(repoRoot, '.nibbler-staging', 'discovery');
          await resetDir(discDir);
          const start = Date.now();
          try {
            await runDiscovery({
              workspace: repoRoot,
              providedFiles,
              planDir: discDir,
              runner,
              projectState: project,
              classification: null,
            });
            discSpinner.succeed(`Discovery complete ${theme.dim(`(${formatMs(Date.now() - start)})`)}`);
            // Refresh scan so subsequent prompts know these exist now.
            project = await scanProjectState(repoRoot);
          } catch (err: any) {
            discSpinner.fail(`Discovery failed ${theme.dim(`(${formatMs(Date.now() - start)})`)}`);
            const msg = String(err?.message ?? err);
            if (isVerbose()) {
              r.dim(theme.bold('--- verbose: discovery failure ---'));
              r.dim(`message: ${msg}`);
              r.dim(`discoveryPlanDir: ${discDir}`);
              r.dim(theme.bold('--- end verbose ---'));
            }
            return { ok: false, errors: msg };
          }
          r.blank();
        }
      }
    }

    // ── Step 3.5: Artifact quality validation (structural heuristics) ────────
    let artifactQualityReports: ArtifactQualityReport[] = await validateArtifacts(repoRoot, project, {
      requireVision: true,
      requireArchitecture: true,
      requirePrd: false,
    });

    if (artifactQualityReports.some((r) => r.issues.length > 0)) {
      r.artifactQualityReport(artifactQualityReports);
    }

    let insufficient = artifactQualityReports.filter((r) => r.score === 'insufficient');
    if (insufficient.length > 0) {
      const canRediscover = !opts.skipDiscovery;
      const decision = await getArtifactQualityDecision({ canRediscover });

      if (decision === 'abort') {
        return {
          ok: false,
          errors: `Input artifacts are insufficient. Fix ${insufficient.map((x) => x.file).join(', ')} and re-run \`nibbler init\`.`,
        };
      }

      if (decision === 'rediscover') {
        const discSpinner = r.spinner('Re-running discovery to improve artifacts...');
        const discDir = join(repoRoot, '.nibbler-staging', 'discovery');
        await resetDir(discDir);
        const start = Date.now();
        try {
          await runDiscovery({
            workspace: repoRoot,
            providedFiles: (opts.files ?? []).map((p) => resolve(p)),
            planDir: discDir,
            runner,
            projectState: project,
            classification: null,
            force: true,
          });
          discSpinner.succeed(`Discovery complete ${theme.dim(`(${formatMs(Date.now() - start)})`)}`);
          project = await scanProjectState(repoRoot);
        } catch (err: any) {
          discSpinner.fail(`Discovery failed ${theme.dim(`(${formatMs(Date.now() - start)})`)}`);
          const msg = String(err?.message ?? err);
          return { ok: false, errors: msg };
        }

        artifactQualityReports = await validateArtifacts(repoRoot, project, {
          requireVision: true,
          requireArchitecture: true,
          requirePrd: false,
        });
        if (artifactQualityReports.some((r) => r.issues.length > 0)) {
          r.artifactQualityReport(artifactQualityReports);
        }
        insufficient = artifactQualityReports.filter((r) => r.score === 'insufficient');
        if (insufficient.length > 0) {
          // Discovery only rewrites vision + architecture. If other artifacts (e.g. PRD.md) remain insufficient,
          // generate *proposed* improvements into staging and ask the user to approve applying them.
          const improveSpinner = r.spinner('Proposing improvements for insufficient artifacts...');
          const improveDir = join(repoRoot, '.nibbler-staging', 'artifact-improvements');
          await resetDir(improveDir);
          try {
            const sessionLogPath = join(repoRoot, '.nibbler-staging', 'discovery', 'sessions', 'artifact-improve.log');
            const { proposed } = await runArtifactImprovement({
              workspace: repoRoot,
              runner,
              project,
              reports: insufficient,
              outputDirAbs: improveDir,
              sessionLogPath,
              timeoutMs: 600_000,
            });
            improveSpinner.succeed('Improvement proposals ready');

            if (proposed.length > 0) {
              await maybeApplyArtifactProposals({ repoRoot, proposals: proposed, renderer: r });
              project = await scanProjectState(repoRoot);
              artifactQualityReports = await validateArtifacts(repoRoot, project, {
                requireVision: true,
                requireArchitecture: true,
                requirePrd: false,
              });
              if (artifactQualityReports.some((x) => x.issues.length > 0)) {
                r.artifactQualityReport(artifactQualityReports);
              }
              insufficient = artifactQualityReports.filter((x) => x.score === 'insufficient');
            } else {
              r.warn('No improvement proposals were produced.');
            }
          } catch (err: any) {
            improveSpinner.fail('Failed to generate improvement proposals');
            const msg = String(err?.message ?? err);
            r.warn(msg);
          }

          if (insufficient.length > 0) {
            const followup = await getArtifactQualityDecision({ canRediscover: false });
            if (followup === 'abort') {
              return {
                ok: false,
                errors: `Input artifacts are still insufficient. Fix ${insufficient.map((x) => x.file).join(', ')} and re-run \`nibbler init\`.`,
              };
            }
          }
        }
      }
    }

    // ── Step 4: Generate Contract via Architect ──────────────────────────────
    const stagingDir = join(repoRoot, '.nibbler-staging', 'contract');
    await resetDir(stagingDir);

    const existingContractYaml =
      opts.review && (await fileExists(join(repoRoot, '.nibbler', 'contract')))
        ? await readContractYamlForPrompt(join(repoRoot, '.nibbler', 'contract'))
        : undefined;

    const feedbackBlocks: string[] = [];
    let attempt = 0;
    while (true) {
      if (cancellation.signal.aborted) return { ok: false, errors: { reason: 'cancelled' } };

      attempt += 1;
      if (attempt > 10) {
        r.error(
          'Too many contract revision attempts',
          'The Architect was unable to produce a valid contract after 10 attempts.',
          'Check .nibbler-staging/init-feedback.txt for details, or try a different project structure.',
        );
        return { ok: false, errors: 'init: too many contract revision attempts' };
      }

      const sessionSpinner = r.spinner(
        attempt === 1 ? 'Generating contract...' : `Revising contract (attempt ${attempt})...`,
      );
      const sessionStart = Date.now();

      // Build prompt and start architect session
      const prompt = renderInitBootstrapPrompt({
        project,
        existingContractYaml,
        exampleContracts: Array.from(exampleContracts),
        contractStagingDir: stagingDir.replaceAll('\\', '/'),
        artifactQualitySummary: formatArtifactQualitySummary(artifactQualityReports),
      }).concat(renderFeedback(feedbackBlocks));

      if (isVerbose()) {
        // Keep a durable copy of the exact prompt used for debugging.
        await writeText(join(repoRoot, '.nibbler-staging', `init-prompt-attempt-${attempt}.md`), prompt);
      }

      await writeRoleOverlay(repoRoot, 'architect', prompt);
      const handle = await spawnInitSession(runner, repoRoot, join(repoRoot, '.nibbler', 'config', 'cursor-profiles', 'init'));
      activeHandle = handle;
      await runner.send(handle, prompt);
      await waitForInitCompletion(runner, handle);

      await runner.stop(handle);
      activeHandle = null;

      const sessionDuration = Date.now() - sessionStart;

      // ── Read and validate staged contract ──────────────────────────────────
      let proposed: Contract;
      try {
        proposed = await readContract(stagingDir);
      } catch (err) {
        const msg = `Contract read failed: ${String((err as any)?.message ?? err)}`;
        feedbackBlocks.push(msg);
        await appendInitFeedback(repoRoot, msg);
        sessionSpinner.fail(`Contract generation failed ${theme.dim(`(${formatMs(sessionDuration)})`)}`);
        r.warn('Architect did not produce valid contract files. Retrying with feedback...');
        if (isVerbose()) {
          await renderVerboseInitFailure(r, {
            stagingDir,
            attempt,
            reason: msg,
            error: err,
            validationErrors: null,
          });
        }
        r.blank();
        continue;
      }

      const errors = validateContract(proposed);
      if (errors.length) {
        const msg = `Contract validation errors:\n${JSON.stringify(errors, null, 2)}`;
        feedbackBlocks.push(msg);
        await appendInitFeedback(repoRoot, msg);
        sessionSpinner.fail(`Contract validation failed ${theme.dim(`(${formatMs(sessionDuration)})`)}`);
        r.warn(`${errors.length} validation error${errors.length > 1 ? 's' : ''}. Retrying with feedback...`);
        if (isVerbose()) {
          await renderVerboseInitFailure(r, {
            stagingDir,
            attempt,
            reason: 'Contract validation failed',
            error: null,
            validationErrors: errors,
          });
        }
        r.blank();
        continue;
      }

      sessionSpinner.succeed(`Contract proposed ${theme.dim(`(${formatMs(sessionDuration)})`)}`);
      r.blank();

    // ── Step 4: Contract Summary + PO Approval ─────────────────────────────
    r.contractSummary(proposed, ['.nibbler/contract/team.yaml', '.nibbler/contract/phases.yaml']);

      const decision = await getInitDecision();

    if (decision === 'reject') {
      const notes =
        process.env.NIBBLER_TEST_AUTO_APPROVE === '1'
          ? 'rejected (test)'
          : await promptInput({ message: 'Rejection notes (will be provided to Architect)', default: '' });
      const msg = `PO rejection notes: ${notes.trim() || '(none)'}`;
      feedbackBlocks.push(msg);
      await appendInitFeedback(repoRoot, msg);
      r.warn('Contract rejected. Sending feedback to Architect...');
      r.blank();
      continue;
    }

    // ── Step 4.5: Generate workflow rules (AI) ─────────────────────────────
    const workflow = await generateWorkflowRulesBestEffort({
      repoRoot,
      runner,
      contract: proposed,
      projectSummary: {
        kind: project.kind,
        projectType: project.projectType ?? null,
        traits: project.traits ?? [],
        topLevelEntries: project.topLevelEntries ?? [],
        packageJsonPreview: project.packageJsonPreview ?? null,
      },
    });
    if (workflow?.content) {
      if (!opts.dryRun) {
        // Commit a durable workflow rule file so every subsequent agent session shares consistent guidance.
        await writeWorkflowRules(repoRoot, workflow.content);
      } else {
        r.dim('Dry run: workflow rules generated in staging only (not written to .cursor/rules).');
      }
    } else {
      r.warn('Workflow rules were not generated. Continuing without them.');
    }

    // ── Step 5: Commit ─────────────────────────────────────────────────────
    if (!opts.dryRun) {
      const commitSpinner = r.spinner('Writing contract and generating profiles...');
      await writeContract(join(repoRoot, '.nibbler', 'contract'), proposed);
      await writeProjectProfile(repoRoot, project);
      await generateAllProfiles(repoRoot, proposed);
      await commit(git(repoRoot), '[nibbler] init: contract established', { includeEngineArtifacts: true });
      commitSpinner.succeed('Contract committed');
    } else {
      r.dim('Dry run: no contract written or committed.');
    }

    r.blank();
    r.success('Initialization complete. Run `nibbler build` to start a job.');
    r.blank();

    return { ok: true, contract: proposed };
    }
  } catch (err: any) {
    // Treat prompt abortion (Ctrl+C) as a clean cancellation.
    if (cancellation.signal.aborted) return { ok: false, errors: { reason: 'cancelled' } };
    throw err;
  } finally {
    // If cancellation happened mid-session, ensure we don't leave it running.
    if (activeHandle) {
      try {
        await runner.stop(activeHandle);
      } catch {
        // ignore
      }
      activeHandle = null;
    }
    cancellation.dispose();
  }
}

// ── Internal Helpers ────────────────────────────────────────────────────────

function isVerbose(): boolean {
  return process.env.NIBBLER_VERBOSE === '1';
}

async function renderVerboseInitFailure(
  r: ReturnType<typeof getRenderer>,
  args: {
    stagingDir: string;
    attempt: number;
    reason: string;
    error: unknown;
    validationErrors: ValidationError[] | null;
  }
): Promise<void> {
  r.dim(theme.bold('--- verbose: init failure details ---'));
  r.dim(`attempt: ${args.attempt}`);
  r.dim(`stagingDir: ${args.stagingDir}`);

  const expected = ['team.yaml', 'phases.yaml'];
  r.dim(`expectedContractFiles: ${expected.join(', ')}`);

  const staged = await listDirDetailed(args.stagingDir);
  if (staged.length === 0) {
    r.dim('stagingContents: (empty)');
  } else {
    r.dim('stagingContents:');
    for (const e of staged) {
      r.dim(`  - ${e.name}${e.isDir ? '/' : ''}${e.sizeBytes != null ? theme.dim(` (${e.sizeBytes} bytes)`) : ''}`);
    }
  }

  r.dim(`reason: ${args.reason}`);
  if (args.error) {
    r.dim('error:');
    for (const line of formatErrorVerbose(args.error).split('\n')) r.dim(`  ${line}`);
  }

  if (args.validationErrors && args.validationErrors.length > 0) {
    r.dim('validationErrors:');
    for (const e of args.validationErrors) {
      r.dim(`  - [${e.rule}] ${e.message}`);
      if (e.details != null) {
        const json = safeStringify(e.details);
        for (const line of json.split('\n')) r.dim(`      ${line}`);
      }
    }
  }

  // Show last feedback block if present.
  const feedbackPath = join(args.stagingDir, '..', 'init-feedback.txt');
  try {
    const raw = await readText(feedbackPath);
    const tail = tailLines(raw, 60);
    r.dim(`feedbackPath: ${feedbackPath}`);
    r.dim('feedbackTail:');
    for (const line of tail.split('\n')) r.dim(`  ${line}`);
  } catch {
    // ignore
  }

  const promptPath = join(args.stagingDir, '..', `init-prompt-attempt-${args.attempt}.md`);
  if (await fileExists(promptPath)) {
    r.dim(`promptPath: ${promptPath}`);
  }
  r.dim(theme.bold('--- end verbose ---'));
}

async function listDirDetailed(dir: string): Promise<Array<{ name: string; isDir: boolean; sizeBytes: number | null }>> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; isDir: boolean; sizeBytes: number | null }> = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    try {
      const s = await stat(join(dir, name));
      out.push({ name, isDir: s.isDirectory(), sizeBytes: s.isFile() ? s.size : null });
    } catch {
      out.push({ name, isDir: false, sizeBytes: null });
    }
  }
  return out;
}

function formatErrorVerbose(err: unknown): string {
  if (!err) return 'unknown error';
  const anyErr = err as any;
  const name = typeof anyErr?.name === 'string' ? anyErr.name : undefined;
  const msg = typeof anyErr?.message === 'string' ? anyErr.message : String(err);
  const stack = typeof anyErr?.stack === 'string' ? anyErr.stack : '';

  const zodIssues = Array.isArray(anyErr?.issues) ? anyErr.issues : null;
  const issuesText = zodIssues ? safeStringify(zodIssues) : '';

  const parts: string[] = [];
  parts.push(name ? `${name}: ${msg}` : msg);
  if (issuesText) parts.push(`issues=${issuesText}`);
  if (stack) parts.push(stack);
  return parts.join('\n');
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  const tail = lines.slice(Math.max(0, lines.length - n));
  return tail.join('\n').trimEnd();
}

async function resetDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

async function ensureGitignore(repoRoot: string): Promise<void> {
  const p = join(repoRoot, '.gitignore');
  const desired = ['.nibbler/jobs/', '.nibbler-staging/', '.cursor/rules/20-role-*.mdc'];
  const exists = await fileExists(p);
  if (!exists) {
    await writeText(p, `${desired.join('\n')}\n`);
    return;
  }
  const current = await readText(p);
  const lines = new Set(current.split('\n').map((l) => l.trim()).filter(Boolean));
  let changed = false;
  for (const d of desired) {
    if (!lines.has(d)) {
      lines.add(d);
      changed = true;
    }
  }
  if (changed) {
    await writeText(p, `${Array.from(lines).join('\n')}\n`);
  }
}

async function ensureGitInitialized(repoRoot: string): Promise<void> {
  if (await fileExists(join(repoRoot, '.git'))) return;
  await execa('git', ['init'], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
}

async function readContractYamlForPrompt(contractDir: string): Promise<string> {
  const candidates = ['team.yaml', 'phases.yaml', 'contract.yaml'];
  const parts: string[] = [];
  for (const f of candidates) {
    const abs = join(contractDir, f);
    if (await fileExists(abs)) parts.push(`# ${f}\n${await readText(abs)}\n`);
  }
  if (parts.length) return parts.join('\n');
  return '(contract exists, but no known yaml files found)';
}

function defaultProtocolRule(): string {
  return [
    '# Nibbler Protocol',
    '',
    'When your work is complete, signal the engine by outputting exactly ONE of these single-line events as **plain text in your response**:',
    '',
    '```text',
    'NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"<short summary>"}',
    'NIBBLER_EVENT {"type":"NEEDS_ESCALATION","reason":"<what blocked you>","context":"<optional>"}',
    'NIBBLER_EVENT {"type":"EXCEPTION","reason":"<product decision needed>","impact":"<impact>"}',
    '```',
    '',
    '**IMPORTANT**: The NIBBLER_EVENT line is a protocol signal parsed from your text output.',
    'NEVER write it inside any file (README.md, source code, config, etc.).',
    'It must only appear as text in your response after all file edits are done.',
    '',
  ].join('\n');
}

async function generateWorkflowRulesBestEffort(args: {
  repoRoot: string;
  runner: RunnerAdapter;
  contract: Contract;
  projectSummary: {
    kind: string;
    projectType: string | null;
    traits: string[];
    topLevelEntries: string[];
    packageJsonPreview: unknown;
  };
}): Promise<{ content: string; stagedRel: string } | null> {
  const r = getRenderer();
  const { repoRoot, runner, contract, projectSummary } = args;

  const stagedRel = '.nibbler-staging/rules/10-nibbler-workflow.mdc';
  const stagedAbs = join(repoRoot, stagedRel);
  await mkdir(dirname(stagedAbs), { recursive: true });

  // Use a dedicated Cursor CLI config directory whose basename is `rules` so tests can target it.
  const configDir = join(repoRoot, '.nibbler', 'config', 'cursor-profiles', 'rules');
  await mkdir(configDir, { recursive: true });
  await writeJson(join(configDir, 'cli-config.json'), rulesWriterCliConfig());

  const roleLines = contract.roles
    .map((role) => {
      const scope = role.scope.slice(0, 12).map((s) => `\`${s}\``).join(', ');
      const suffix = role.scope.length > 12 ? `, ... (+${role.scope.length - 12} more)` : '';
      return `- ${role.id}: scope=${scope}${suffix}`;
    })
    .join('\n');

  const sharedLines = (contract.sharedScopes ?? [])
    .map((s) => `- roles=[${s.roles.join(', ')}] patterns=${(s.patterns?.length ? s.patterns : ['**/*']).join(', ')}`)
    .join('\n');

  const prompt = [
    'You are an AI agent writing a durable workflow rules file for this repository.',
    '',
    '## Goal',
    'Write a concise, high-signal Cursor rules file that helps future agent sessions succeed in this repo.',
    'This file MUST reflect the dynamically assembled team and scopes from the Nibbler contract below.',
    '',
    '## Output (REQUIRED)',
    `Write the workflow rules file to exactly: ${stagedRel}`,
    '',
    '## Contract (source of truth for team + scopes)',
    'Summarize the team and encode guidance that matches these exact roles/scopes.',
    '',
    'Roles:',
    roleLines || '(none)',
    '',
    'Shared scopes:',
    sharedLines || '(none)',
    '',
    '## Stable project signals (for durable rules)',
    `- projectType: ${String(projectSummary.projectType ?? '(unknown)')}`,
    `- traits: ${(projectSummary.traits ?? []).join(', ') || '(none)'}`,
    '',
    '## Required sections (use markdown headings)',
    '- Commands (how to run tests/build/lint; do not invent commands; reference package.json scripts if present)',
    '- Workflow (how to work: edit first then run checks; avoid long-running commands first; keep changes scoped)',
    '- Team map (role -> owned areas; explain how to request help/escalate)',
    '- Handoffs (recommended; where to write them; include a short template)',
    '',
    '## Handoff convention (MUST include in the rules)',
    '- Write per-session handoff (recommended) to: `.nibbler-staging/<jobId>/handoffs/<roleId>-<phaseId>.md`',
    '- Read previous handoffs from: `.nibbler/jobs/<jobId>/plan/handoffs/`',
    '',
    '## Constraints',
    '- Keep it concise (target 80–200 lines).',
    '- Prefer repo-specific guidance over generic advice.',
    '- Do NOT mention transient bootstrap state (examples: `docs_only`, `early-stage`, `missing package.json`).',
    '- Avoid caveats tied to the current snapshot of files; rules must stay valid after scaffold/build.',
    '- Do NOT modify any repository files except the required output file above.',
    '',
    'After writing the rules file, signal completion by outputting this as plain text in your response (NOT inside any file):',
    '',
    '```',
    'NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"workflow rules written"}',
    '```',
  ].join('\n');

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const spinner = r.spinner(attempt === 1 ? 'Generating workflow rules...' : `Re-trying workflow rules (attempt ${attempt})...`);
    const start = Date.now();
    let handle: SessionHandle | null = null;
    try {
      handle = await runner.spawn(repoRoot, {}, configDir, { mode: 'plan', taskType: 'plan' });
      await runner.send(handle, prompt);
      await waitForInitCompletion(runner, handle);
      await runner.stop(handle);

      const exists = await fileExists(stagedAbs);
      if (!exists) {
        spinner.fail(`Workflow rules missing ${theme.dim(`(${formatMs(Date.now() - start)})`)}`);
        continue;
      }
      const content = await readText(stagedAbs);
      if (content.trim().length < 200) {
        spinner.fail(`Workflow rules too short ${theme.dim(`(${formatMs(Date.now() - start)})`)}`);
        continue;
      }
      spinner.succeed(`Workflow rules ready ${theme.dim(`(${formatMs(Date.now() - start)})`)}`);
      return { content, stagedRel };
    } catch (err: any) {
      spinner.fail(`Workflow rules failed ${theme.dim(`(${formatMs(Date.now() - start)})`)}`);
      if (isVerbose()) r.dim(`workflow rules error: ${String(err?.message ?? err)}`);
    } finally {
      if (handle) {
        try {
          await runner.stop(handle);
        } catch {
          // ignore
        }
      }
    }
  }

  return null;
}

function rulesWriterCliConfig(): any {
  // Plan-mode: read-only, except staging writes.
  return {
    version: 1,
    editor: { vimMode: false },
    permissions: {
      allow: ['Read(**/*)', 'Write(.nibbler-staging/**)'],
      deny: [
        'Write(.nibbler/**)',
        'Write(.cursor/**)',
        'Read(.env*)',
        'Read(**/.env*)',
        'Write(**/*.key)',
      ],
    },
  };
}

function formatArtifactQualitySummary(reports: ArtifactQualityReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    const issues = r.issues ?? [];
    lines.push(`${r.file}: ${r.score}${issues.length ? ` (${issues.length} issue${issues.length === 1 ? '' : 's'})` : ''}`);
    for (const i of issues) {
      lines.push(`- [${i.severity}] ${i.message}`);
    }
    lines.push('');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

async function getArtifactQualityDecision(args: { canRediscover: boolean }): Promise<'rediscover' | 'continue' | 'abort'> {
  const forced = process.env.NIBBLER_TEST_ARTIFACT_QUALITY_DECISION?.trim();
  if (forced === 'continue' || forced === 'abort') return forced;
  if (forced === 'rediscover' && args.canRediscover) return 'rediscover';

  // Non-interactive / tests: default to continue to preserve prior behavior.
  if (
    process.env.NIBBLER_TEST_AUTO_APPROVE === '1' ||
    process.env.NIBBLER_TEST_NO_PROMPTS === '1' ||
    process.env.NIBBLER_QUIET === '1' ||
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true
  ) {
    return 'continue';
  }

  const choices: Array<{ name: string; value: 'rediscover' | 'continue' | 'abort' }> = [];
  if (args.canRediscover) choices.push({ name: 'Re-run discovery to improve artifacts', value: 'rediscover' });
  choices.push({ name: 'Continue anyway (contract quality may suffer)', value: 'continue' });
  choices.push({ name: 'Abort and fix manually', value: 'abort' });

  return await promptSelect<'rediscover' | 'continue' | 'abort'>({
    message: 'Some input artifacts are insufficient. How would you like to proceed?',
    choices,
  });
}

function promptsEnabled(): boolean {
  if (process.env.NIBBLER_TEST_AUTO_APPROVE === '1') return false;
  if (process.env.NIBBLER_TEST_NO_PROMPTS === '1') return false;
  if (process.env.NIBBLER_QUIET === '1') return false;
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function maybeApplyArtifactProposals(args: {
  repoRoot: string;
  proposals: Array<{ targetRel: string; proposedAbs: string }>;
  renderer: ReturnType<typeof getRenderer>;
}): Promise<void> {
  const { repoRoot, proposals, renderer: r } = args;

  const autoApply = process.env.NIBBLER_TEST_ARTIFACT_APPLY === '1';
  for (const p of proposals) {
    const proposed = await readText(p.proposedAbs);
    const targetAbs = join(repoRoot, p.targetRel);
    const current = (await fileExists(targetAbs)) ? await readText(targetAbs) : '';

    if (proposed.trim() === current.trim()) {
      r.dim(`No changes proposed for ${theme.bold(p.targetRel)} (already up to date).`);
      continue;
    }

    // Small preview: first ~25 lines of the proposal.
    const previewLines = proposed.split('\n').slice(0, 25).join('\n').trimEnd();
    r.blank();
    r.info(`Proposed update for ${theme.bold(p.targetRel)} (preview):`);
    for (const line of previewLines.split('\n')) r.dim(`  ${line}`);
    if (proposed.split('\n').length > 25) r.dim('  ...');
    r.blank();

    let apply = autoApply;
    if (!apply) {
      if (!promptsEnabled()) {
        r.warn(`Non-interactive mode: skipping apply for ${p.targetRel}. Set NIBBLER_TEST_ARTIFACT_APPLY=1 to auto-apply in tests.`);
        continue;
      }
      const decision = await promptSelect<'apply' | 'skip'>({
        message: `Apply proposed update to ${p.targetRel}?`,
        choices: [
          { name: 'Apply', value: 'apply' },
          { name: 'Skip', value: 'skip' },
        ],
      });
      apply = decision === 'apply';
    }

    if (apply) {
      await writeText(targetAbs, proposed);
      r.success(`Updated ${p.targetRel}`);
    } else {
      r.warn(`Skipped updating ${p.targetRel}`);
    }
  }
}

async function getInitDecision(): Promise<'approve' | 'reject'> {
  const forced = process.env.NIBBLER_TEST_INIT_DECISION?.trim();
  if (forced === 'approve' || forced === 'reject') return forced;
  if (process.env.NIBBLER_TEST_AUTO_APPROVE === '1') return 'approve';
  return await promptSelect<'approve' | 'reject'>({
    message: 'Accept this contract?',
    choices: [
      { name: 'Approve', value: 'approve' },
      { name: 'Reject (request changes)', value: 'reject' },
    ],
  });
}

async function appendInitFeedback(repoRoot: string, text: string): Promise<void> {
  const path = join(repoRoot, '.nibbler-staging', 'init-feedback.txt');
  const prev = (await fileExists(path)) ? await readText(path) : '';
  const next = `${prev}${prev ? '\n' : ''}---\n${text}\n`;
  await writeText(path, next);
}

function renderFeedback(blocks: string[]): string {
  if (blocks.length === 0) return '';
  return [
    '',
    '## Feedback from engine / PO',
    'The previous attempt(s) failed validation or were rejected. Fix the contract accordingly.',
    '',
    '```text',
    blocks.join('\n\n---\n\n'),
    '```',
    '',
  ].join('\n');
}

async function generateAllProfiles(repoRoot: string, contract: Contract): Promise<void> {
  const { generatePermissionsConfig, writePermissionsProfile } = await import('../../core/context/permissions.js');
  for (const role of contract.roles) {
    const cfg = generatePermissionsConfig(role, contract);
    await writePermissionsProfile(repoRoot, role.id, cfg);
  }
}

async function writeProjectProfile(repoRoot: string, project: Awaited<ReturnType<typeof scanProjectState>>): Promise<void> {
  const path = join(repoRoot, '.nibbler', 'contract', 'project-profile.yaml');
  await writeYaml(path, {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    repoRoot,
    kind: project.kind,
    projectType: project.projectType ?? null,
    confidence: project.classificationConfidence ?? 'low',
    traits: project.traits ?? [],
    reasons: project.classificationReasons ?? [],
    signals: {
      hasPackageJson: project.hasPackageJson,
      hasSrcDir: project.hasSrcDir,
      hasArchitectureMd: project.hasArchitectureMd,
      hasVisionMd: project.hasVisionMd,
      hasPrdMd: project.hasPrdMd,
      topLevelEntries: project.topLevelEntries,
      packageJsonPreview: project.packageJsonPreview ?? null
    }
  });
}

async function spawnInitSession(runner: RunnerAdapter, repoRoot: string, configDir: string): Promise<SessionHandle> {
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, 'cli-config.json');
  await writeJson(configPath, initCliConfig());
  return await runner.spawn(repoRoot, {}, configDir, { taskType: 'plan' });
}

function initCliConfig(): any {
  return {
    version: 1,
    editor: { vimMode: false },
    permissions: {
      allow: ['Read(**/*)', 'Write(.nibbler-staging/**)'],
      deny: ['Write(.nibbler/**)', 'Write(.cursor/**)', 'Read(.env*)', 'Read(**/.env*)', 'Write(**/*.key)'],
    },
  };
}

async function waitForInitCompletion(runner: RunnerAdapter, handle: SessionHandle): Promise<void> {
  for await (const _ev of runner.readEvents(handle)) {
    return;
  }
}

function detectVersion(repoRoot: string): string {
  try {
    const pkgPath = resolve(repoRoot, 'package.json');
    if (existsSync(pkgPath)) {
      const content = readFileSync(pkgPath, 'utf8');
      const parsed = JSON.parse(content) as { version?: string };
      if (typeof parsed.version === 'string') return parsed.version;
    }
  } catch {
    // ignore
  }
  return '0.1.0';
}
