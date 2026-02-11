import { afterEach, describe, expect, it } from 'vitest';
import { resolveSessionInactivityTimeoutMs } from '../src/cli/session-timeout.js';

const ENV_KEY = 'NIBBLER_SESSION_INACTIVITY_TIMEOUT_MS';
const originalValue = process.env[ENV_KEY];

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = originalValue;
  }
});

describe('resolveSessionInactivityTimeoutMs', () => {
  it('defaults to 10 minutes when unset', () => {
    delete process.env[ENV_KEY];
    expect(resolveSessionInactivityTimeoutMs()).toBe(600_000);
  });

  it('falls back to default for non-numeric values', () => {
    process.env[ENV_KEY] = 'not-a-number';
    expect(resolveSessionInactivityTimeoutMs()).toBe(600_000);
  });

  it('clamps values below minimum to 30 seconds', () => {
    process.env[ENV_KEY] = '1000';
    expect(resolveSessionInactivityTimeoutMs()).toBe(30_000);
  });

  it('accepts valid values and floors decimals', () => {
    process.env[ENV_KEY] = '45000.9';
    expect(resolveSessionInactivityTimeoutMs()).toBe(45_000);
  });
});
