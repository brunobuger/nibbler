export type GateDecision = 'approve' | 'reject' | 'exception';

export interface GateResolution {
  decision: GateDecision;
  notes?: string;
}

