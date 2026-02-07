import { describe, expect, it } from 'vitest';

import { isProtectedPath } from '../src/workspace/protected-paths.js';

describe('protected paths', () => {
  it('flags .nibbler and base protocol rule', () => {
    expect(isProtectedPath('.nibbler/contract/team.yaml')).toBe(true);
    expect(isProtectedPath('.nibbler/jobs/j-1/ledger.jsonl')).toBe(true);
    expect(isProtectedPath('.cursor/rules/00-nibbler-protocol.mdc')).toBe(true);
  });

  it('does not flag normal source files', () => {
    expect(isProtectedPath('src/core/policy-engine.ts')).toBe(false);
  });
});

