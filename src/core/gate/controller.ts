import type { GateDefinition } from '../contract/types.js';
import type { JobState } from '../job/types.js';
import type { EvidenceCollector } from '../evidence/collector.js';
import type { LedgerWriter } from '../ledger/writer.js';

import { collectGateInputs } from './inputs.js';
import type { GateResolution } from './types.js';
import { getRenderer } from '../../cli/ui/renderer.js';

export class GateController {
  constructor(
    private ledger: LedgerWriter,
    private evidence: EvidenceCollector,
  ) {}

  async presentGate(gateDef: GateDefinition, job: JobState): Promise<GateResolution> {
    const inputs = await collectGateInputs(gateDef, job.repoRoot, { tokens: { id: job.jobId } });

    await this.evidence.recordGateInputs(gateDef.id, inputs);
    await this.ledger.append({
      type: 'gate_presented',
      data: { gateId: gateDef.id, audience: gateDef.audience, inputs: gateDef.requiredInputs },
    });

    const model = {
      title: job.description ?? `Job ${job.jobId}`,
      subtitle: `Gate audience: ${gateDef.audience}`,
      artifacts: (gateDef.requiredInputs ?? []).map((i) => ({
        name: i.name,
        path: i.kind === 'path' ? i.value : undefined,
        exists: i.kind === 'path' ? (inputs[i.name] as any)?.exists : undefined,
      })),
    };

    const r = getRenderer();
    const resolution = await r.presentGatePrompt(gateDef, model, inputs);

    await this.evidence.recordGateResolution(gateDef.id, {
      ...resolution,
      audience: gateDef.audience,
      timestamp: new Date().toISOString(),
    });
    await this.ledger.append({
      type: 'gate_resolved',
      data: { gateId: gateDef.id, audience: String(gateDef.audience), decision: resolution.decision, notes: resolution.notes },
    });

    return resolution;
  }
}
