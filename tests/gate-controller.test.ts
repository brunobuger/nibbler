import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GateController } from '../src/core/gate/controller.js';
import { EvidenceCollector } from '../src/core/evidence/collector.js';
import { LedgerWriter } from '../src/core/ledger/writer.js';
import { initJob, initWorkspace } from '../src/workspace/layout.js';
import type { GateDefinition } from '../src/core/contract/types.js';

describe('gate controller', () => {
  it('records gate inputs + resolution in evidence and ledger', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-gate-'));
    await initWorkspace(repoRoot);
    const jobPaths = await initJob(repoRoot, 'j-test');

    // Create a fake plan artifact for requiredInputs.
    const artifactRel = '.nibbler/jobs/j-test/plan/acceptance.md';
    const artifactAbs = join(repoRoot, artifactRel);
    await writeFile(artifactAbs, '# acceptance\n', 'utf8');

    const evidence = new EvidenceCollector({
      evidenceDir: jobPaths.evidenceDir,
      diffsDir: jobPaths.evidenceDiffsDir,
      checksDir: jobPaths.evidenceChecksDir,
      commandsDir: jobPaths.evidenceCommandsDir,
      gatesDir: jobPaths.evidenceGatesDir
    });
    const ledger = await LedgerWriter.open(jobPaths.ledgerPath);

    const gateDef: GateDefinition = {
      id: 'plan',
      trigger: 'x->y',
      audience: 'PO',
      requiredInputs: [{ name: 'acceptance', kind: 'path', value: artifactRel }],
      outcomes: { approve: 'y', reject: 'x' }
    };

    const gc = new GateController(ledger, evidence);
    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      const job = {
        repoRoot,
        jobId: 'j-test',
        currentPhaseId: 'p1',
        startedAtIso: new Date().toISOString()
      };

      const res = await gc.presentGate(gateDef, job);
      expect(res.decision).toBe('approve');

      const ledgerContent = await readFile(jobPaths.ledgerPath, 'utf8');
      expect(ledgerContent).toContain('"type":"gate_presented"');
      expect(ledgerContent).toContain('"type":"gate_resolved"');

      const inputsPath = join(jobPaths.evidenceGatesDir, 'plan-inputs.json');
      const resolutionPath = join(jobPaths.evidenceGatesDir, 'plan-resolution.json');
      expect(await readFile(inputsPath, 'utf8')).toContain('acceptance');
      expect(await readFile(resolutionPath, 'utf8')).toContain('approve');
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }
  });
});

