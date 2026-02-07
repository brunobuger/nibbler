import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { readYaml, writeYaml } from '../../utils/fs.js';
import { Contract as ContractSchema, type Contract } from './types.js';

const YAML_EXTS = new Set(['.yaml', '.yml']);

export async function readContract(contractDir: string): Promise<Contract> {
  const entries = await safeReaddir(contractDir);
  const yamlFiles = entries
    .filter((e) => YAML_EXTS.has(extname(e)))
    .sort((a, b) => a.localeCompare(b));

  if (yamlFiles.length === 0) {
    throw new Error(`No contract YAML files found in ${contractDir}`);
  }

  const fragments = await Promise.all(yamlFiles.map((f) => readYaml<Record<string, unknown>>(join(contractDir, f))));
  const merged = mergeFragments(fragments);
  return ContractSchema.parse(merged);
}

export async function writeContract(contractDir: string, contract: Contract): Promise<void> {
  // Deterministic v1 layout: split into `team.yaml` and `phases.yaml`.
  await writeYaml(join(contractDir, 'team.yaml'), {
    roles: contract.roles,
    sharedScopes: contract.sharedScopes,
    escalationChain: contract.escalationChain
  });

  await writeYaml(join(contractDir, 'phases.yaml'), {
    phases: contract.phases,
    gates: contract.gates,
    globalLifetime: contract.globalLifetime
  });
}

function mergeFragments(fragments: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const f of fragments) {
    for (const [k, v] of Object.entries(f)) {
      if (Array.isArray(v)) {
        out[k] = [...(Array.isArray(out[k]) ? (out[k] as unknown[]) : []), ...v];
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = { ...(isPlainObject(out[k]) ? (out[k] as object) : {}), ...(v as object) };
      } else {
        out[k] = v;
      }
    }
  }

  return out;
}

function isPlainObject(v: unknown): v is object {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function extname(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i);
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err: any) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return [];
    throw err;
  }
}

