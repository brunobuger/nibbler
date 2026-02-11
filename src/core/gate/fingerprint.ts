import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Contract, GateDefinition } from '../contract/types.js';
import type { JobState } from '../job/types.js';
import { collectGateInputs, type GateInputs } from './inputs.js';

/**
 * Compute a deterministic fingerprint for a gate decision.
 *
 * Used to avoid re-prompting the PO for the same gate when nothing relevant changed
 * (e.g. autonomous recovery re-enters `planning->...` after a failure).
 *
 * Fingerprint inputs:
 * - gate id + trigger
 * - requiredInputs (exists + sha256 for path inputs; full text for text inputs)
 * - if the gate is triggered from the planning phase, include a hash of the planning artifacts
 *   under `.nibbler/jobs/<id>/plan/` so plan edits force a re-approval.
 */
export async function computeGateFingerprint(args: {
  gateDef: GateDefinition;
  job: JobState;
  contract: Contract;
  inputs?: GateInputs;
}): Promise<{ fingerprint: string; planningArtifactsSha256?: string }> {
  const { gateDef, job, contract } = args;

  const inputs =
    args.inputs ??
    (await collectGateInputs(gateDef, job.repoRoot, {
      tokens: { id: job.jobId },
      extraRoots: job.worktreePath ? [job.worktreePath] : [],
    }));

  const currentPhase = String(gateDef.trigger ?? '').split('->')[0]?.trim() || undefined;
  const planningArtifactsSha256 =
    currentPhase === 'planning' ? await hashPlanningArtifacts(job.repoRoot, job.jobId) : undefined;

  const required = (gateDef.requiredInputs ?? []).map((spec) => {
    const raw = inputs[spec.name] as any;
    if (spec.kind === 'text') {
      return { name: spec.name, kind: 'text', text: String(raw?.text ?? spec.value ?? '') };
    }
    // kind === 'path'
    return {
      name: spec.name,
      kind: 'path',
      path: String(raw?.path ?? spec.value ?? ''),
      exists: raw?.exists === true,
      sha256: raw?.sha256 ? String(raw.sha256) : undefined,
      resolved: raw?.resolved
        ? {
            root: typeof raw.resolved.root === 'string' ? raw.resolved.root : undefined,
            example: typeof raw.resolved.example === 'string' ? raw.resolved.example : undefined,
            matchesCount: typeof raw.resolved.matchesCount === 'number' ? raw.resolved.matchesCount : undefined,
          }
        : undefined,
    };
  });

  const canonical = {
    gate: {
      id: gateDef.id,
      trigger: gateDef.trigger,
      audience: String(gateDef.audience ?? ''),
      approvalScope: gateDef.approvalScope,
      approvalExpectations: gateDef.approvalExpectations,
      businessOutcomes: gateDef.businessOutcomes,
      functionalScope: gateDef.functionalScope,
      outOfScope: gateDef.outOfScope,
    },
    // Capture current team/contract version indirectly via phase graph shape for safety.
    // This is cheap and helps avoid false positives if contracts differ between runs.
    contractShape: {
      phases: contract.phases.map((p) => p.id),
      gates: contract.gates.map((g) => g.id),
    },
    planningArtifactsSha256,
    requiredInputs: required,
  };

  const fingerprint = sha256(stableStringify(canonical));
  return { fingerprint, planningArtifactsSha256 };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableClone(value));
}

function stableClone(value: any): any {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(stableClone);
  if (typeof value !== 'object') return value;
  const out: Record<string, any> = {};
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  for (const k of keys) out[k] = stableClone(value[k]);
  return out;
}

async function hashPlanningArtifacts(repoRoot: string, jobId: string): Promise<string | undefined> {
  if (!jobId) return undefined;
  const planDir = join(repoRoot, '.nibbler', 'jobs', jobId, 'plan');
  try {
    const files = await listFilesRec(planDir, ['.git', 'node_modules']);
    if (files.length === 0) return sha256('empty');

    const h = createHash('sha256');
    // Include file paths and content to detect any changes deterministically.
    for (const rel of files.sort((a, b) => a.localeCompare(b))) {
      h.update(rel, 'utf8');
      h.update('\n', 'utf8');
      const abs = join(planDir, rel);
      const buf = await readFile(abs).catch(() => null);
      if (buf) h.update(buf);
      h.update('\n', 'utf8');
    }
    return h.digest('hex');
  } catch {
    return undefined;
  }
}

async function listFilesRec(root: string, ignoreDirs: string[]): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string) {
    const abs = join(root, rel);
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if (ignoreDirs.includes(e.name)) continue;
        await walk(join(rel, e.name));
      } else if (e.isFile()) {
        out.push(join(rel, e.name).replaceAll('\\', '/'));
      }
    }
  }
  await walk('');
  return out.filter((p) => p.length > 0);
}

