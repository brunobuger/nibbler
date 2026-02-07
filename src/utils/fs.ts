import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

