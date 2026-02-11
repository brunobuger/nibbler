import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInitCommand } from '../src/cli/commands/init.js';
import type { RoleAction } from './mock-runner.js';
import { MockRunnerAdapter } from './mock-runner.js';

describe('nibbler init', () => {
  it('stages and validates contract (dry-run, non-interactive)', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-init-'));
    // initialize minimal git repo files; tests don't require actual git commits here.
    await mkdir(join(repoRoot, '.git'), { recursive: true });

    const actions: Record<string, RoleAction> = {
      discovery: async ({ workspacePath }) => {
        // Discovery produces the durable artifacts used for contract proposal.
        await writeFile(join(workspacePath, 'vision.md'), '# vision\n', 'utf8');
        await writeFile(join(workspacePath, 'architecture.md'), '# architecture\n', 'utf8');
      },
      init: async ({ workspacePath }) => {
        const staging = join(workspacePath, '.nibbler-staging', 'contract');
        await mkdir(staging, { recursive: true });
        // Minimal valid contract split across two files.
        await writeFile(
          join(staging, 'team.yaml'),
          `roles:
  - id: architect
    scope: ["src/**"]
    authority: { allowedCommands: [], allowedPaths: [] }
    outputExpectations: []
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 1, exhaustionEscalation: "terminate" }
sharedScopes: []
escalationChain: []
`,
          'utf8'
        );
        await writeFile(
          join(staging, 'phases.yaml'),
          `phases:
  - id: p1
    actors: ["architect"]
    inputBoundaries: ["src/**"]
    outputBoundaries: ["src/**"]
    preconditions: [{ type: "always" }]
    completionCriteria: [{ type: "diff_non_empty" }]
    successors: []
    isTerminal: true
gates:
  - id: plan
    trigger: "p1->p1"
    audience: "PO"
    approvalScope: "phase_output"
    approvalExpectations:
      - "Approve phase output."
    businessOutcomes:
      - "PO acknowledges phase completion."
    functionalScope:
      - "Phase can transition to the configured next step."
    outOfScope:
      - "No additional product scope."
    requiredInputs: []
    outcomes: { approve: "p1", reject: "p1" }
globalLifetime:
  maxTimeMs: 60000
`,
          'utf8'
        );
      },
      rules: async ({ workspacePath }) => {
        const outDir = join(workspacePath, '.nibbler-staging', 'rules');
        await mkdir(outDir, { recursive: true });
        const filler = Array.from({ length: 40 }, () => '- do not invent commands\n').join('');
        await writeFile(join(outDir, '10-nibbler-workflow.mdc'), `# Workflow\n\n## Commands\n- npm test\n\n## Guardrails\n${filler}`, 'utf8');
      }
    };

    // MockRunnerAdapter derives roleId from configDir basename. Init uses basename 'init'.
    const runner = new MockRunnerAdapter(actions);

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      const out = await runInitCommand({ repoRoot, runner, dryRun: true });
      expect(out.ok).toBe(true);
      expect(runner.startedRoles).toContain('rules');
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }

    // dryRun should not write real contract into .nibbler/contract
    const contractDir = join(repoRoot, '.nibbler', 'contract');
    let exists = false;
    try {
      await readFile(join(contractDir, 'team.yaml'), 'utf8');
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    // dryRun should not write durable workflow rules into .cursor/rules
    await expect(readFile(join(repoRoot, '.cursor', 'rules', '10-nibbler-workflow.mdc'), 'utf8')).rejects.toThrow();
  });

  it('respects existing ARCHITECTURE.md casing (does not create architecture.md)', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-init-'));
    await mkdir(join(repoRoot, '.git'), { recursive: true });

    // Pre-existing repo artifacts
    await writeFile(join(repoRoot, 'ARCHITECTURE.md'), '# Existing Architecture\n\nSome details.\n', 'utf8');
    await writeFile(join(repoRoot, 'PRD.md'), '# PRD\n\nProblem, scope, requirements.\n', 'utf8');
    // No vision.md -> discovery should run, and must update ARCHITECTURE.md (not create lowercase).

    const actions: Record<string, RoleAction> = {
      discovery: async ({ workspacePath }) => {
        await writeFile(join(workspacePath, 'vision.md'), '# vision\n', 'utf8');
        // Write to the existing architecture filename (preserve casing).
        try {
          await readFile(join(workspacePath, 'ARCHITECTURE.md'), 'utf8');
          await writeFile(join(workspacePath, 'ARCHITECTURE.md'), '# architecture\n', 'utf8');
        } catch {
          await writeFile(join(workspacePath, 'architecture.md'), '# architecture\n', 'utf8');
        }
      },
      init: async ({ workspacePath }) => {
        const staging = join(workspacePath, '.nibbler-staging', 'contract');
        await mkdir(staging, { recursive: true });
        await writeFile(
          join(staging, 'team.yaml'),
          `roles:
  - id: architect
    scope: ["src/**"]
    authority: { allowedCommands: [], allowedPaths: [] }
    outputExpectations: []
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 1, exhaustionEscalation: "terminate" }
sharedScopes: []
escalationChain: []
`,
          'utf8'
        );
        await writeFile(
          join(staging, 'phases.yaml'),
          `phases:
  - id: p1
    actors: ["architect"]
    inputBoundaries: ["src/**"]
    outputBoundaries: ["src/**"]
    preconditions: [{ type: "always" }]
    completionCriteria: [{ type: "diff_non_empty" }]
    successors: []
    isTerminal: true
gates:
  - id: plan
    trigger: "p1->p1"
    audience: "PO"
    approvalScope: "phase_output"
    approvalExpectations:
      - "Approve phase output."
    businessOutcomes:
      - "PO acknowledges phase completion."
    functionalScope:
      - "Phase can transition to the configured next step."
    outOfScope:
      - "No additional product scope."
    requiredInputs: []
    outcomes: { approve: "p1", reject: "p1" }
globalLifetime:
  maxTimeMs: 60000
`,
          'utf8'
        );
      },
      rules: async ({ workspacePath }) => {
        const outDir = join(workspacePath, '.nibbler-staging', 'rules');
        await mkdir(outDir, { recursive: true });
        const filler = Array.from({ length: 40 }, () => '- keep changes small\n').join('');
        await writeFile(join(outDir, '10-nibbler-workflow.mdc'), `# Workflow\n\n## Commands\n- npm test\n\n## Guardrails\n${filler}`, 'utf8');
      }
    };

    const runner = new MockRunnerAdapter(actions);

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      const out = await runInitCommand({ repoRoot, runner, dryRun: true });
      expect(out.ok).toBe(true);
      expect(runner.startedRoles).toContain('rules');
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }

    // Must still have uppercase architecture doc and must NOT create lowercase variant.
    await expect(readFile(join(repoRoot, 'ARCHITECTURE.md'), 'utf8')).resolves.toContain('#');
    await expect(readFile(join(repoRoot, 'vision.md'), 'utf8')).resolves.toContain('#');
    await expect(readFile(join(repoRoot, 'architecture.md'), 'utf8')).rejects.toThrow();
  });

  it('proposes PRD improvements and applies on approval', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-init-'));
    await mkdir(join(repoRoot, '.git'), { recursive: true });

    // Existing good artifacts
    await writeFile(join(repoRoot, 'vision.md'), '# Vision\n\nTarget users and goal.\n\nMore context here.\n', 'utf8');
    await writeFile(join(repoRoot, 'ARCHITECTURE.md'), '# Architecture\n\n## Tech Stack\n- Node\n\n## Components\n- app\n', 'utf8');

    // Existing insufficient PRD
    await writeFile(join(repoRoot, 'PRD.md'), '# PRD\n\nTODO\n', 'utf8');

    const actions: Record<string, RoleAction> = {
      discovery: async () => {
        // no-op; we keep existing vision/arch
      },
      'artifact-improve': async ({ workspacePath }) => {
        const improved = `# PRD

## Problem
Describe the user problem and why it matters. This project needs a clear statement of intent.

## Scope
### In scope
- Core workflow(s)
- MVP features

### Out of scope
- Nice-to-haves not required for MVP

## Requirements
- User can perform the primary workflow end-to-end
- System provides clear errors and basic observability

## Workflows
1. User signs in
2. User completes the primary task
3. User reviews results
`;
        await mkdir(join(workspacePath, '.nibbler-staging', 'artifact-improvements'), { recursive: true });
        await writeFile(join(workspacePath, '.nibbler-staging', 'artifact-improvements', 'PRD.md'), improved, 'utf8');
      },
      init: async ({ workspacePath }) => {
        const staging = join(workspacePath, '.nibbler-staging', 'contract');
        await mkdir(staging, { recursive: true });
        await writeFile(
          join(staging, 'team.yaml'),
          `roles:
  - id: architect
    scope: ["src/**"]
    authority: { allowedCommands: [], allowedPaths: [] }
    outputExpectations: []
    verificationMethod: { kind: "none" }
    budget: { maxIterations: 1, exhaustionEscalation: "terminate" }
sharedScopes: []
escalationChain: []
`,
          'utf8'
        );
        await writeFile(
          join(staging, 'phases.yaml'),
          `phases:
  - id: p1
    actors: ["architect"]
    inputBoundaries: ["src/**"]
    outputBoundaries: ["src/**"]
    preconditions: [{ type: "always" }]
    completionCriteria: [{ type: "diff_non_empty" }]
    successors: []
    isTerminal: true
gates:
  - id: plan
    trigger: "p1->p1"
    audience: "PO"
    approvalScope: "phase_output"
    approvalExpectations:
      - "Approve phase output."
    businessOutcomes:
      - "PO acknowledges phase completion."
    functionalScope:
      - "Phase can transition to the configured next step."
    outOfScope:
      - "No additional product scope."
    requiredInputs: []
    outcomes: { approve: "p1", reject: "p1" }
globalLifetime:
  maxTimeMs: 60000
`,
          'utf8'
        );
      },
      rules: async ({ workspacePath }) => {
        const outDir = join(workspacePath, '.nibbler-staging', 'rules');
        await mkdir(outDir, { recursive: true });
        const filler = Array.from({ length: 40 }, () => '- prefer deterministic checks\n').join('');
        await writeFile(join(outDir, '10-nibbler-workflow.mdc'), `# Workflow\n\n## Commands\n- npm test\n\n## Guardrails\n${filler}`, 'utf8');
      }
    };

    const runner = new MockRunnerAdapter(actions);

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    process.env.NIBBLER_TEST_ARTIFACT_QUALITY_DECISION = 'rediscover';
    process.env.NIBBLER_TEST_ARTIFACT_APPLY = '1';
    try {
      const out = await runInitCommand({ repoRoot, runner, dryRun: true });
      expect(out.ok).toBe(true);
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
      delete process.env.NIBBLER_TEST_ARTIFACT_QUALITY_DECISION;
      delete process.env.NIBBLER_TEST_ARTIFACT_APPLY;
    }

    const prd = await readFile(join(repoRoot, 'PRD.md'), 'utf8');
    expect(prd).toContain('## Problem');
    expect(prd).toContain('## Scope');
    expect(prd).toContain('## Requirements');
    expect(prd).toContain('## Workflows');
  });
});

