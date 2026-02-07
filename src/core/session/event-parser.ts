import type { NibblerEvent } from './types.js';

const PREFIX = 'NIBBLER_EVENT ';

export function parseEventLine(line: string): NibblerEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(PREFIX)) return null;

  const jsonPart = trimmed.slice(PREFIX.length).trim();
  if (!jsonPart.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(jsonPart) as { type?: unknown; [k: string]: unknown };
    const type = parsed.type;
    if (type === 'PHASE_COMPLETE') {
      return { type, summary: typeof parsed.summary === 'string' ? parsed.summary : undefined };
    }
    if (type === 'NEEDS_ESCALATION') {
      return {
        type,
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
        context: parsed.context
      };
    }
    if (type === 'EXCEPTION') {
      return {
        type,
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
        impact: typeof parsed.impact === 'string' ? parsed.impact : undefined
      };
    }
    return null;
  } catch {
    return null;
  }
}

