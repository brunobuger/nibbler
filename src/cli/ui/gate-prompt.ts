/**
 * Model for presenting a gate prompt to the PO.
 * Used by the Renderer implementations.
 */
export interface GatePromptModel {
  title: string;
  subtitle?: string;
  artifacts: Array<{ name: string; path?: string; exists?: boolean }>;
}
