import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GateController } from '../src/core/gate/controller.js';
import { EvidenceCollector } from '../src/core/evidence/collector.js';
import { LedgerWriter } from '../src/core/ledger/writer.js';
import { initJob, initWorkspace } from '../src/workspace/layout.js';
import type { Contract, GateDefinition } from '../src/core/contract/types.js';
import { getRenderer, setRenderer } from '../src/cli/ui/renderer.js';

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
      approvalScope: 'build_requirements',
      approvalExpectations: ['Approve requirements and execution plan'],
      businessOutcomes: ['PO approves value delivery scope'],
      functionalScope: ['Core workflow is approved for implementation'],
      outOfScope: ['Unplanned features remain out of scope'],
      requiredInputs: [{ name: 'acceptance', kind: 'path', value: artifactRel }],
      outcomes: { approve: 'y', reject: 'x' }
    };

    const contract: Contract = {
      roles: [
        {
          id: 'architect',
          scope: ['**/*'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
        },
      ],
      phases: [
        {
          id: 'x',
          actors: ['architect'],
          inputBoundaries: ['**/*'],
          outputBoundaries: ['**/*'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [{ on: 'done', next: 'y' }],
        },
        {
          id: 'y',
          actors: ['architect'],
          inputBoundaries: ['**/*'],
          outputBoundaries: ['**/*'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [],
          isTerminal: true,
        },
      ],
      gates: [gateDef],
      globalLifetime: { maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
      sharedScopes: [],
      escalationChain: [],
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

      const res = await gc.presentGate(gateDef, job as any, contract);
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

  it('build vs phase approval sections are selected by approvalScope', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-gate-scope-'));
    await initWorkspace(repoRoot);
    const jobPaths = await initJob(repoRoot, 'j-test');

    const evidence = new EvidenceCollector({
      evidenceDir: jobPaths.evidenceDir,
      diffsDir: jobPaths.evidenceDiffsDir,
      checksDir: jobPaths.evidenceChecksDir,
      commandsDir: jobPaths.evidenceCommandsDir,
      gatesDir: jobPaths.evidenceGatesDir
    });
    const ledger = await LedgerWriter.open(jobPaths.ledgerPath);

    const contract: Contract = {
      roles: [
        {
          id: 'architect',
          scope: ['**/*'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: ['role-phase-output'],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
        },
      ],
      phases: [
        {
          id: 'planning',
          actors: ['architect'],
          inputBoundaries: ['**/*'],
          outputBoundaries: ['**/*'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [{ on: 'done', next: 'execution' }],
        },
        {
          id: 'execution',
          actors: ['architect'],
          inputBoundaries: ['**/*'],
          outputBoundaries: ['**/*'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [],
          isTerminal: true,
        },
      ],
      gates: [],
      globalLifetime: { maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
      sharedScopes: [],
      escalationChain: [],
    };

    const captured: any[] = [];
    const previousRenderer = getRenderer();
    setRenderer({
      presentGatePrompt: async (_gateDef: GateDefinition, model: any) => {
        captured.push(model);
        return { decision: 'approve' };
      },
    } as any);

    try {
      const gc = new GateController(ledger, evidence);
      const job = {
        repoRoot,
        jobId: 'j-test',
        currentPhaseId: 'planning',
        startedAtIso: new Date().toISOString()
      };

      const buildGate: GateDefinition = {
        id: 'plan_build',
        trigger: 'planning->execution',
        audience: 'PO',
        approvalScope: 'build_requirements',
        approvalExpectations: ['Approve requirements'],
        businessOutcomes: ['Business value approved'],
        functionalScope: ['Functional scope approved'],
        outOfScope: ['Out of scope locked'],
        requiredInputs: [],
        outcomes: { approve: 'execution', reject: 'planning' }
      };
      await gc.presentGate(buildGate, job as any, contract);

      const phaseGate: GateDefinition = {
        id: 'plan_phase',
        trigger: 'planning->execution',
        audience: 'PO',
        approvalScope: 'phase_output',
        approvalExpectations: ['Approve phase output'],
        businessOutcomes: ['Not used in phase_output display'],
        functionalScope: ['Not used in phase_output display'],
        outOfScope: ['Not used in phase_output display'],
        requiredInputs: [],
        outcomes: { approve: 'execution', reject: 'planning' }
      };
      await gc.presentGate(phaseGate, job as any, contract);
    } finally {
      setRenderer(previousRenderer);
    }

    expect(captured).toHaveLength(2);
    expect(captured[0]?.approvalExpectations).toEqual(['Approve requirements']);
    expect(captured[0]?.businessOutcomes).toEqual(['Business value approved']);
    expect(captured[0]?.outputExpectations).toBeUndefined();

    expect(captured[1]?.approvalExpectations).toBeUndefined();
    expect(captured[1]?.businessOutcomes).toBeUndefined();
    expect(captured[1]?.outputExpectations?.[0]?.expectations).toContain('role-phase-output');
  });

  it('resolves required input path case-insensitively for non-glob files', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-gate-case-'));
    await initWorkspace(repoRoot);
    const jobPaths = await initJob(repoRoot, 'j-test');

    // Actual artifact on disk uses uppercase filename.
    await writeFile(join(repoRoot, 'ARCHITECTURE.md'), '# architecture\n', 'utf8');

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
      approvalScope: 'build_requirements',
      approvalExpectations: ['Approve requirements'],
      businessOutcomes: ['Business value'],
      functionalScope: ['Functional scope'],
      outOfScope: ['Out of scope'],
      requiredInputs: [{ name: 'architecture', kind: 'path', value: 'architecture.md' }],
      outcomes: { approve: 'y', reject: 'x' }
    };

    const contract: Contract = {
      roles: [
        {
          id: 'architect',
          scope: ['**/*'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
        },
      ],
      phases: [
        {
          id: 'x',
          actors: ['architect'],
          inputBoundaries: ['**/*'],
          outputBoundaries: ['**/*'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [{ on: 'done', next: 'y' }],
        },
        {
          id: 'y',
          actors: ['architect'],
          inputBoundaries: ['**/*'],
          outputBoundaries: ['**/*'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [],
          isTerminal: true,
        },
      ],
      gates: [gateDef],
      globalLifetime: { maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
      sharedScopes: [],
      escalationChain: [],
    };

    const gc = new GateController(ledger, evidence);
    process.env.NIBBLER_TEST_AUTO_APPROVE = '1';
    try {
      await gc.presentGate(gateDef, { repoRoot, jobId: 'j-test', startedAtIso: new Date().toISOString() } as any, contract);
    } finally {
      delete process.env.NIBBLER_TEST_AUTO_APPROVE;
    }

    const inputsPath = join(jobPaths.evidenceGatesDir, 'plan-inputs.json');
    const raw = await readFile(inputsPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.architecture).toBeTruthy();
    expect(parsed.architecture.exists).toBe(true);
    expect(parsed.architecture.path).toBe('architecture.md');
  });

  it('renders PO-friendly planning verification text for build gates', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'nibbler-gate-friendly-'));
    await initWorkspace(repoRoot);
    const jobPaths = await initJob(repoRoot, 'j-test');

    const evidence = new EvidenceCollector({
      evidenceDir: jobPaths.evidenceDir,
      diffsDir: jobPaths.evidenceDiffsDir,
      checksDir: jobPaths.evidenceChecksDir,
      commandsDir: jobPaths.evidenceCommandsDir,
      gatesDir: jobPaths.evidenceGatesDir
    });
    const ledger = await LedgerWriter.open(jobPaths.ledgerPath);

    const contract: Contract = {
      roles: [
        {
          id: 'architect',
          scope: ['**/*'],
          authority: { allowedCommands: [], allowedPaths: [] },
          outputExpectations: [],
          verificationMethod: { kind: 'none' },
          budget: { maxIterations: 1, maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
        },
      ],
      phases: [
        {
          id: 'planning',
          actors: ['architect'],
          inputBoundaries: ['**/*'],
          outputBoundaries: ['**/*'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'artifact_exists', pattern: '.nibbler/jobs/<id>/plan/**' }],
          successors: [{ on: 'done', next: 'execution' }],
        },
        {
          id: 'execution',
          actors: ['architect'],
          inputBoundaries: ['**/*'],
          outputBoundaries: ['**/*'],
          preconditions: [{ type: 'always' }],
          completionCriteria: [{ type: 'diff_non_empty' }],
          successors: [],
          isTerminal: true,
        },
      ],
      gates: [],
      globalLifetime: { maxTimeMs: 60_000, exhaustionEscalation: 'terminate' },
      sharedScopes: [],
      escalationChain: [],
    };

    const captured: any[] = [];
    const previousRenderer = getRenderer();
    setRenderer({
      presentGatePrompt: async (_gateDef: GateDefinition, model: any) => {
        captured.push(model);
        return { decision: 'approve' };
      },
    } as any);

    try {
      const gc = new GateController(ledger, evidence);
      const gateDef: GateDefinition = {
        id: 'plan',
        trigger: 'planning->execution',
        audience: 'PO',
        approvalScope: 'build_requirements',
        approvalExpectations: ['Approve requirements'],
        businessOutcomes: ['Value approved'],
        functionalScope: ['Scope approved'],
        outOfScope: ['Out of scope approved'],
        requiredInputs: [],
        outcomes: { approve: 'execution', reject: 'planning' }
      };
      await gc.presentGate(gateDef, { repoRoot, jobId: 'j-test', startedAtIso: new Date().toISOString() } as any, contract);
    } finally {
      setRenderer(previousRenderer);
    }

    expect(captured).toHaveLength(1);
    expect(captured[0]?.completionCriteria?.[0]).toBe('Planning artifacts are generated and ready for PO review');
  });
});

