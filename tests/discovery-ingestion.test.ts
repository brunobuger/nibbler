import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ingestMaterials } from '../src/discovery/ingestion.js';

describe('discovery ingestion', () => {
  it('classifies empty workspace as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nibbler-disc-'));
    const ctx = await ingestMaterials([], dir);
    expect(ctx.repoState).toBe('empty');
  });

  it('classifies docs_only when README exists but no code signals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nibbler-disc-'));
    await writeFile(join(dir, 'README.md'), '# hi\n', 'utf8');
    const ctx = await ingestMaterials([], dir);
    expect(ctx.repoState).toBe('docs_only');
  });

  it('classifies has_code when package.json exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nibbler-disc-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
    const ctx = await ingestMaterials([], dir);
    expect(ctx.repoState).toBe('has_code');
  });

  it('reads provided files when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nibbler-disc-'));
    await mkdir(join(dir, 'docs'), { recursive: true });
    const p = join(dir, 'docs', 'prd.md');
    await writeFile(p, 'hello prd', 'utf8');
    const ctx = await ingestMaterials([p], dir);
    expect(ctx.provided.length).toBe(1);
    expect(ctx.provided[0].content).toContain('hello prd');
  });

  it('detects ARCHITECTURE.md (uppercase) case-insensitively', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nibbler-disc-'));
    await writeFile(join(dir, 'ARCHITECTURE.md'), '# Architecture\nNext.js frontend', 'utf8');
    const ctx = await ingestMaterials([], dir);
    expect(ctx.existingArchitecture).toBeDefined();
    expect(ctx.existingArchitecture!.content).toContain('Next.js frontend');
    expect(ctx.repoState).toBe('docs_only');
  });

  it('auto-ingests PRD.md into provided files for classification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nibbler-disc-'));
    await writeFile(join(dir, 'PRD.md'), '# PRD\nReact web application with Supabase auth', 'utf8');
    const ctx = await ingestMaterials([], dir);
    expect(ctx.provided.length).toBe(1);
    expect(ctx.provided[0].content).toContain('React web application');
  });

  it('classifies web-app from doc keywords in PRD.md + ARCHITECTURE.md', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nibbler-disc-'));
    // Realistic docs (modelled on the FocusFlow todo-sample)
    await writeFile(join(dir, 'PRD.md'), [
      '# PRD: FocusFlow',
      'A minimalist task management web application.',
      'Frontend: React or Next.js with Tailwind CSS.',
      'Database/Auth: Supabase or Firebase for real-time syncing and authentication.',
      'OAuth login via Google and GitHub.',
    ].join('\n'), 'utf8');
    await writeFile(join(dir, 'ARCHITECTURE.md'), [
      '# Architecture',
      'Frontend: Next.js, Zustand, Tailwind.',
      'Backend: Supabase with PostgreSQL database.',
      'Real-time subscriptions for live updates.',
      'Authentication via OAuth providers.',
    ].join('\n'), 'utf8');

    const ctx = await ingestMaterials([], dir);
    const { classifyProjectTypeDetailed } = await import('../src/discovery/classification.js');
    const { detectTraits } = await import('../src/discovery/traits.js');

    const type = classifyProjectTypeDetailed(ctx);
    expect(type.projectType).toBe('web-app');
    expect(type.confidence).not.toBe('low'); // Should be at least medium

    const traits = detectTraits(ctx);
    expect(traits).toContain('auth');
    expect(traits).toContain('database');
    expect(traits).toContain('realtime');
  });
});

