import { join } from 'node:path';

import type { GateDefinition } from '../contract/types.js';
import { fileExists, readText } from '../../utils/fs.js';

export type GateInputs = Record<string, unknown>;

export async function collectGateInputs(
  gateDef: GateDefinition,
  repoRoot: string,
  opts: { maxChars?: number; tokens?: Record<string, string> } = {}
): Promise<GateInputs> {
  const out: GateInputs = {};
  const maxChars = opts.maxChars ?? 20_000;
  const tokens = opts.tokens ?? {};

  for (const spec of gateDef.requiredInputs ?? []) {
    if (spec.kind === 'text') {
      out[spec.name] = { kind: 'text', text: spec.value };
      continue;
    }

    // kind === 'path'
    const rel = substituteTokens(spec.value, tokens);
    const abs = join(repoRoot, rel);
    const exists = await fileExists(abs);
    if (!exists) {
      out[spec.name] = { kind: 'path', path: rel, exists: false };
      continue;
    }

    const content = await readText(abs);
    const preview = content.length > maxChars ? `${content.slice(0, maxChars)}\n... (truncated)\n` : content;
    out[spec.name] = { kind: 'path', path: rel, exists: true, preview };
  }

  return out;
}

function substituteTokens(value: string, tokens: Record<string, string>): string {
  return value.replaceAll(/<([a-zA-Z0-9_-]+)>/g, (_m, key: string) => tokens[key] ?? `<${key}>`);
}

