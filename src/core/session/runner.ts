import type { NibblerEvent, RunnerCapabilities, SessionHandle } from './types.js';

export type RunnerSpawnMode = 'normal' | 'plan';

export interface RunnerAdapter {
  spawn(
    workspacePath: string,
    envVars: Record<string, string>,
    configDir: string,
    options?: { mode?: RunnerSpawnMode }
  ): Promise<SessionHandle>;
  send(handle: SessionHandle, message: string): Promise<void>;
  readEvents(handle: SessionHandle): AsyncIterable<NibblerEvent>;
  isAlive(handle: SessionHandle): boolean;
  stop(handle: SessionHandle): Promise<void>;
  capabilities(): RunnerCapabilities;
}

