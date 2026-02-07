import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { execa } from 'execa';

import { readContract, writeContract } from '../../core/contract/reader.js';
import { validateContract } from '../../core/contract/validator.js';
import type { Contract } from '../../core/contract/types.js';
import { CursorRunnerAdapter } from '../../core/session/cursor-adapter.js';
import type { RunnerAdapter } from '../../core/session/runner.js';
import type { SessionHandle } from '../../core/session/types.js';
import { fileExists, readText, writeJson, writeText, writeYaml } from '../../utils/fs.js';
import { initWorkspace, writeProtocolRule, writeRoleOverlay } from '../../workspace/layout.js';
import { scanProjectState } from '../../workspace/scanner.js';
import { renderInitBootstrapPrompt } from '../../templates/bootstrap-prompt.js';
import { commit, git, isClean } from '../../git/operations.js';
import { exampleContracts } from '../../templates/contract-examples/index.js';
import { getRenderer } from '../ui/renderer.js';
import { theme } from '../ui/theme.js';
import { formatMs } from '../ui/format.js';
import { installCliCancellation } from '../cancel.js';
import { promptInput, promptSelect } from '../ui/prompts.js';

export interface InitCommandOptions {
  repoRoot?: string;
  review?: boolean;
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

    const project = await scanProjectState(repoRoot);

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
      hasCode: project.kind === 'existing',
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

    // ── Step 3: Generate Contract via Architect ──────────────────────────────
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
      attempt === 1
        ? 'Generating contract...'
        : `Revising contract (attempt ${attempt})...`,
    );
    const sessionStart = Date.now();

    // Build prompt and start architect session
    const prompt = renderInitBootstrapPrompt({
      project,
      existingContractYaml,
      exampleContracts: Array.from(exampleContracts),
      contractStagingDir: stagingDir.replaceAll('\\', '/'),
    }).concat(renderFeedback(feedbackBlocks));

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
      r.blank();
      continue;
    }

    sessionSpinner.succeed(`Contract proposed ${theme.dim(`(${formatMs(sessionDuration)})`)}`);
    r.blank();

    // ── Step 4: Contract Summary + PO Approval ─────────────────────────────
    r.contractSummary(
      {
        roles: proposed.roles.map((role) => ({ id: role.id, scope: role.scope })),
        phases: proposed.phases.map((p) => ({ id: p.id, isTerminal: p.isTerminal })),
        gates: proposed.gates.map((g) => ({ id: g.id, audience: String(g.audience), trigger: g.trigger })),
      },
      ['.nibbler/contract/team.yaml', '.nibbler/contract/phases.yaml'],
    );

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

    // ── Step 5: Commit ─────────────────────────────────────────────────────
    if (!opts.dryRun) {
      const commitSpinner = r.spinner('Writing contract and generating profiles...');
      await writeContract(join(repoRoot, '.nibbler', 'contract'), proposed);
      await writeProjectProfile(repoRoot, project);
      await generateAllProfiles(repoRoot, proposed);
      await commit(git(repoRoot), '[nibbler] init: contract established');
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
    'Emit exactly one of these single-line events when done:',
    '',
    '```text',
    'NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"<short summary>"}',
    'NIBBLER_EVENT {"type":"NEEDS_ESCALATION","reason":"<what blocked you>","context":"<optional>"}',
    'NIBBLER_EVENT {"type":"EXCEPTION","reason":"<product decision needed>","impact":"<impact>"}',
    '```',
    '',
  ].join('\n');
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
  return await runner.spawn(repoRoot, {}, configDir);
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
