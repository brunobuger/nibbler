import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a document filename variant that exists on disk.
 *
 * This is intentionally simple (no directory scanning): it tries `variants` in order
 * and returns the first match. If none exist, returns `defaultName`.
 */
export async function resolveDocVariant(dir: string, variants: string[], defaultName: string): Promise<string> {
  for (const v of variants) {
    if (await fileExists(join(dir, v))) return v;
  }
  return defaultName;
}

export async function readText(path: string): Promise<string> {
  return await readFile(path, 'utf8');
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  const raw = await readText(path);
  return JSON.parse(raw) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readYaml<T = unknown>(path: string): Promise<T> {
  const raw = await readText(path);
  return YAML.parse(raw) as T;
}

export async function writeYaml(path: string, value: unknown): Promise<void> {
  const raw = YAML.stringify(value);
  await writeText(path, raw);
}

