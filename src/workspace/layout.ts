import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface WorkspacePaths {
  repoRoot: string;
  cursorRulesDir: string;
  nibblerDir: string;
  contractDir: string;
  cursorProfilesDir: string;
}

export interface JobPaths {
  repoRoot: string;
  jobId: string;
  jobDir: string;
  planDir: string;
  evidenceDir: string;
  evidenceDiffsDir: string;
  evidenceChecksDir: string;
  evidenceCommandsDir: string;
  evidenceGatesDir: string;
  ledgerPath: string;
  statusPath: string;
}

export async function initWorkspace(repoRoot: string): Promise<WorkspacePaths> {
  const cursorRulesDir = join(repoRoot, '.cursor', 'rules');
  const nibblerDir = join(repoRoot, '.nibbler');
  const contractDir = join(nibblerDir, 'contract');
  const cursorProfilesDir = join(nibblerDir, 'config', 'cursor-profiles');

  await mkdir(cursorRulesDir, { recursive: true });
  await mkdir(contractDir, { recursive: true });
  await mkdir(cursorProfilesDir, { recursive: true });

  return { repoRoot, cursorRulesDir, nibblerDir, contractDir, cursorProfilesDir };
}

export async function initJob(repoRoot: string, jobId: string): Promise<JobPaths> {
  const jobDir = join(repoRoot, '.nibbler', 'jobs', jobId);
  const planDir = join(jobDir, 'plan');
  const evidenceDir = join(jobDir, 'evidence');

  const evidenceDiffsDir = join(evidenceDir, 'diffs');
  const evidenceChecksDir = join(evidenceDir, 'checks');
  const evidenceCommandsDir = join(evidenceDir, 'commands');
  const evidenceGatesDir = join(evidenceDir, 'gates');

  await mkdir(planDir, { recursive: true });
  await mkdir(evidenceDiffsDir, { recursive: true });
  await mkdir(evidenceChecksDir, { recursive: true });
  await mkdir(evidenceCommandsDir, { recursive: true });
  await mkdir(evidenceGatesDir, { recursive: true });

  const ledgerPath = join(jobDir, 'ledger.jsonl');
  const statusPath = join(jobDir, 'status.json');

  return {
    repoRoot,
    jobId,
    jobDir,
    planDir,
    evidenceDir,
    evidenceDiffsDir,
    evidenceChecksDir,
    evidenceCommandsDir,
    evidenceGatesDir,
    ledgerPath,
    statusPath
  };
}

export async function isNibblerRepo(repoRoot: string): Promise<boolean> {
  try {
    await readdir(join(repoRoot, '.nibbler', 'contract'));
    return true;
  } catch {
    return false;
  }
}

export function getJobDir(repoRoot: string, jobId: string): string {
  return join(repoRoot, '.nibbler', 'jobs', jobId);
}

export async function writeProtocolRule(repoRoot: string, content: string): Promise<void> {
  const target = join(repoRoot, '.cursor', 'rules', '00-nibbler-protocol.mdc');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

export async function writeRoleOverlay(repoRoot: string, roleId: string, content: string): Promise<void> {
  const safe = roleId.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  const target = join(repoRoot, '.cursor', 'rules', `20-role-${safe}.mdc`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

export async function clearRoleOverlays(repoRoot: string): Promise<void> {
  const rulesDir = join(repoRoot, '.cursor', 'rules');
  let entries: string[] = [];
  try {
    entries = await readdir(rulesDir);
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((e) => e.startsWith('20-role-') && e.endsWith('.mdc'))
      .map((e) => rm(join(rulesDir, e), { force: true }))
  );
}

