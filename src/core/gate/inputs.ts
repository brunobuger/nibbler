import { join } from 'node:path';

import type { GateDefinition } from '../contract/types.js';
import { fileExists, readText } from '../../utils/fs.js';
import picomatch from 'picomatch';
import { readdir } from 'node:fs/promises';

export type GateInputs = Record<string, unknown>;

export async function collectGateInputs(
  gateDef: GateDefinition,
  repoRoot: string,
  opts: { maxChars?: number; tokens?: Record<string, string> } = {}
): Promise<GateInputs> {
  const out: GateInputs = {};
  const maxChars = opts.maxChars ?? 20_000;
  const tokens = opts.tokens ?? {};
  const jobId = tokens.id;

  const searchRoots = (() => {
    const roots = [repoRoot];
    if (jobId) {
      // Planning artifacts are written to staging and materialized into `.nibbler/jobs/<id>/plan/`.
      // Gate inputs should treat those as valid sources for path-based inputs, especially when inputs use globs.
      roots.push(join(repoRoot, '.nibbler', 'jobs', jobId, 'plan'));
      roots.push(join(repoRoot, '.nibbler-staging', 'plan', jobId));
    }
    return Array.from(new Set(roots));
  })();

  for (const spec of gateDef.requiredInputs ?? []) {
    if (spec.kind === 'text') {
      out[spec.name] = { kind: 'text', text: spec.value };
      continue;
    }

    // kind === 'path'
    const rel = substituteTokens(spec.value, tokens);
    const isGlob = looksLikeGlob(rel);

    if (isGlob) {
      let found: { root: string; matches: string[] } | null = null;
      for (const root of searchRoots) {
        const matches = await globExists(root, rel);
        if (matches && matches.length) {
          found = { root, matches };
          break;
        }
      }
      if (!found) {
        out[spec.name] = { kind: 'path', path: rel, exists: false };
        continue;
      }

      const first = found.matches[0]!;
      const abs = join(found.root, first);
      const content = await readText(abs).catch(() => '');
      const preview = content.length > maxChars ? `${content.slice(0, maxChars)}\n... (truncated)\n` : content;
      out[spec.name] = {
        kind: 'path',
        path: rel,
        exists: true,
        preview,
        resolved: { root: found.root, example: first, matchesCount: found.matches.length }
      };
      continue;
    }

    // Non-glob path: check across roots.
    let absFound: string | null = null;
    for (const root of searchRoots) {
      const abs = join(root, rel);
      if (await fileExists(abs)) {
        absFound = abs;
        break;
      }
    }
    if (!absFound) {
      out[spec.name] = { kind: 'path', path: rel, exists: false };
      continue;
    }

    const content = await readText(absFound);
    const preview = content.length > maxChars ? `${content.slice(0, maxChars)}\n... (truncated)\n` : content;
    out[spec.name] = { kind: 'path', path: rel, exists: true, preview };
  }

  return out;
}

function substituteTokens(value: string, tokens: Record<string, string>): string {
  return value.replaceAll(/<([a-zA-Z0-9_-]+)>/g, (_m, key: string) => tokens[key] ?? `<${key}>`);
}

function looksLikeGlob(p: string): boolean {
  // Minimal glob detection: treat any wildcard-ish characters as a glob.
  return p.includes('*') || p.includes('?') || p.includes('[') || p.includes(']') || p.includes('{') || p.includes('}');
}

async function globExists(root: string, pattern: string): Promise<string[] | null> {
  try {
    const files = await listFilesRec(root, ['.git', 'node_modules']);
    const isMatch = picomatch(pattern, { dot: true });
    const matches = files.filter((p) => isMatch(p));
    return matches.length ? matches : null;
  } catch {
    return null;
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

