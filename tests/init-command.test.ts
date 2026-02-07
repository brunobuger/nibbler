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
    requiredInputs: []
    outcomes: { approve: "p1", reject: "p1" }
globalLifetime:
  maxTimeMs: 60000
`,
          'utf8'
        );
      }
    };

    // MockRunnerAdapter derives roleId from configDir basename. Init uses basename 'init'.
    const runner = new MockRunnerAdapter(actions);

    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      const out = await runInitCommand({ repoRoot, runner, dryRun: true });
      expect(out.ok).toBe(true);
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
  });
});

