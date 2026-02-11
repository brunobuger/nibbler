import type { NibblerEvent } from './types.js';

const PREFIX = 'NIBBLER_EVENT ';

export function parseEventLine(line: string): NibblerEvent | null {
  const trimmed = line.trim();
  // Only parse protocol lines that start with the event prefix.
  // This prevents false positives when the prompt itself contains example
  // `NIBBLER_EVENT {...}` snippets inside JSON-encoded user messages.
  if (!trimmed.startsWith(PREFIX)) return null;

  const payload = trimmed.slice(PREFIX.length).trim();
  const candidates = [extractFirstJsonObject(payload), extractFirstBraceObject(payload)]
    .filter((v): v is string => Boolean(v))
    .filter((v, i, arr) => arr.indexOf(v) === i);
  if (candidates.length === 0) return null;

  let parsed: { type?: unknown; [k: string]: unknown } | null = null;
  for (const candidate of candidates) {
    parsed = parseProtocolEventObject(candidate);
    if (parsed) break;
  }
  if (!parsed) return null;
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
  if (type === 'QUESTIONS') {
    const qs = parsed.questions;
    if (!Array.isArray(qs)) return null;
    const questions = qs.filter((q) => typeof q === 'string').map((q) => q.trim()).filter(Boolean);
    if (questions.length === 0) return null;
    return { type, questions };
  }
  if (type === 'QUESTION') {
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    if (!text) return null;
    return { type, text };
  }
  return null;
}

function extractFirstJsonObject(input: string): string | null {
  const start = input.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}

function extractFirstBraceObject(input: string): string | null {
  const start = input.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i]!;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}

function parseProtocolEventObject(input: string): { type?: unknown; [k: string]: unknown } | null {
  try {
    return JSON.parse(input) as { type?: unknown; [k: string]: unknown };
  } catch {
    // Fallback: sometimes the payload appears escaped inside a stream-json line:
    // NIBBLER_EVENT {\"type\":\"PHASE_COMPLETE\",...}
    if (!input.includes('\\"')) return null;
    const unescaped = input
      .replace(/\\\\/g, '\\')
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
    try {
      return JSON.parse(unescaped) as { type?: unknown; [k: string]: unknown };
    } catch {
      return null;
    }
  }
}

