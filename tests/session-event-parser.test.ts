import { describe, expect, it } from 'vitest';

import { parseEventLine } from '../src/core/session/event-parser.js';

describe('session event parser', () => {
  it('parses PHASE_COMPLETE', () => {
    expect(parseEventLine('NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"done"}')).toEqual({
      type: 'PHASE_COMPLETE',
      summary: 'done'
    });
  });

  it('parses NEEDS_ESCALATION', () => {
    expect(parseEventLine('NIBBLER_EVENT {"type":"NEEDS_ESCALATION","reason":"blocked","context":{"x":1}}')).toEqual(
      {
        type: 'NEEDS_ESCALATION',
        reason: 'blocked',
        context: { x: 1 }
      }
    );
  });

  it('rejects lines where event prefix is not at start', () => {
    expect(parseEventLine('final status -> NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"ok"}')).toBe(null);
    expect(parseEventLine('NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"ok"} ```')).toEqual({
      type: 'PHASE_COMPLETE',
      summary: 'ok'
    });
  });

  it('rejects stream-json envelope lines that contain prompt examples', () => {
    const raw = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Example: NIBBLER_EVENT {"type":"PHASE_COMPLETE","summary":"ok"}' }]
      },
      session_id: 'abc'
    });
    expect(parseEventLine(raw)).toBe(null);
  });

  it('returns null for non-events and malformed JSON', () => {
    expect(parseEventLine('hello')).toBe(null);
    expect(parseEventLine('NIBBLER_EVENT not-json')).toBe(null);
    expect(parseEventLine('NIBBLER_EVENT {"type":"UNKNOWN"}')).toBe(null);
  });
});

