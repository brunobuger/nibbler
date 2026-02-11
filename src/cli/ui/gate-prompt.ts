/**
 * Model for presenting a gate prompt to the PO.
 * Used by the Renderer implementations.
 */
export interface GatePromptArtifact {
  name: string;
  /** Repo-relative path or spec value (for kind=path inputs). */
  path?: string;
  exists?: boolean;
  /** Preview text for path inputs (already truncated by collector). */
  preview?: string;
  /** If the path is a glob, provide a count and one example match. */
  matchesCount?: number;
  exampleMatch?: string;
}

export interface GatePromptModel {
  title: string;
  subtitle?: string;
  /** Requirement / what is being built. */
  description?: string;

  /** Team context (roles + scope) */
  team?: Array<{ roleId: string; scope: string[] }>;

  /** Gate context */
  transition?: string;
  currentPhase?: string;
  approveNext?: string;
  rejectNext?: string;
  approvalScope?: 'phase_output' | 'build_requirements' | 'both';

  /** Product/build approval payload (business/functional level). */
  approvalExpectations?: string[];
  businessOutcomes?: string[];
  functionalScope?: string[];
  outOfScope?: string[];

  /** Acceptance criteria and expectations for the phase being gated. */
  completionCriteria?: string[];
  outputExpectations?: Array<{ roleId: string; expectations: string[] }>;

  /** Role progress context. */
  rolesCompleted?: string[];
  rolesRemaining?: string[];

  artifacts: GatePromptArtifact[];
}
