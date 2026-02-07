import { join } from 'node:path';

import type { Contract, RoleDefinition } from '../contract/types.js';
import { writeJson } from '../../utils/fs.js';

export interface CursorCliConfig {
  version: 1;
  editor: {
    vimMode: boolean;
  };
  permissions: {
    allow: string[];
    deny: string[];
  };
}

function shellToken(cmdBase: string): string {
  return `Shell(${cmdBase})`;
}

function readToken(pathOrGlob: string): string {
  return `Read(${pathOrGlob})`;
}

function writeToken(pathOrGlob: string): string {
  return `Write(${pathOrGlob})`;
}

export function generatePermissionsConfig(roleDef: RoleDefinition, _contract: Contract): CursorCliConfig {
  const allow: string[] = [];

  // Allow reading the workspace by default; enforce safety via write deny + git diff scope checks.
  allow.push(readToken('**/*'));

  for (const c of roleDef.authority.allowedCommands ?? []) allow.push(shellToken(c));
  // Allow engine-approved extra write paths (e.g. staging directories).
  for (const p of roleDef.authority.allowedPaths ?? []) allow.push(writeToken(p));
  for (const p of roleDef.scope) allow.push(writeToken(p));
  // Shared scopes (contract-declared or job-local overrides materialized into the effective contract).
  for (const s of _contract.sharedScopes ?? []) {
    if (!s.roles.includes(roleDef.id)) continue;
    const pats = (s.patterns?.length ? s.patterns : ['**/*']);
    for (const p of pats) allow.push(writeToken(p));
  }
  // Engine staging area: roles may write draft artifacts here; engine can materialize into protected paths.
  allow.push(writeToken('.nibbler-staging/**'));

  const deny: string[] = [
    writeToken('.nibbler/**'),
    writeToken('.cursor/rules/**'),
    readToken('.env*'),
    readToken('**/.env*'),
    writeToken('**/*.key')
  ];

  return {
    version: 1,
    editor: { vimMode: false },
    permissions: {
      allow: uniq(allow),
      deny: uniq(deny)
    }
  };
}

/**
 * Plan-mode sessions must be read-only (except for engine staging).
 * This is a hard guardrail layered on top of Cursor's native plan mode.
 */
export function generatePlanPermissionsConfig(): CursorCliConfig {
  return {
    version: 1,
    editor: { vimMode: false },
    permissions: {
      allow: [readToken('**/*'), writeToken('.nibbler-staging/**')],
      deny: [
        writeToken('.nibbler/**'),
        writeToken('.cursor/rules/**'),
        writeToken('**/*'), // deny writes anywhere else
        readToken('.env*'),
        readToken('**/.env*'),
        writeToken('**/*.key')
      ]
    }
  };
}

export async function writePermissionsProfile(
  repoRoot: string,
  roleId: string,
  config: CursorCliConfig
): Promise<{ profileDir: string; configPath: string }> {
  const safe = roleId.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  const profileDir = join(repoRoot, '.nibbler', 'config', 'cursor-profiles', safe);
  const configPath = join(profileDir, 'cli-config.json');
  await writeJson(configPath, config);
  return { profileDir, configPath };
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

