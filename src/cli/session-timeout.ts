const DEFAULT_SESSION_INACTIVITY_TIMEOUT_MS = 600_000;
const MIN_SESSION_INACTIVITY_TIMEOUT_MS = 30_000;

export function resolveSessionInactivityTimeoutMs(): number {
  const raw = process.env.NIBBLER_SESSION_INACTIVITY_TIMEOUT_MS;
  if (!raw || !raw.trim()) return DEFAULT_SESSION_INACTIVITY_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_INACTIVITY_TIMEOUT_MS;

  const ms = Math.floor(parsed);
  if (ms < MIN_SESSION_INACTIVITY_TIMEOUT_MS) return MIN_SESSION_INACTIVITY_TIMEOUT_MS;
  return ms;
}

