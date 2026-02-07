import { describe, expect, it } from 'vitest';

import { answerQuestion, generateSchema, getNextBatch, isDiscoveryComplete } from '../src/discovery/schema.js';

describe('discovery schema', () => {
  it('generates tiered schema with type-specific section', () => {
    const s = generateSchema('cli-tool');
    expect(s.tiers.tier1.length).toBeGreaterThan(0);
    const typeSection = s.tiers.tier1.find((sec) => sec.id === 'type_specific');
    expect(typeSection).toBeTruthy();
    expect(typeSection!.questions.length).toBeGreaterThan(0);
  });

  it('getNextBatch returns 2-3 questions prioritizing tier1 gaps', () => {
    const s = generateSchema('web-app');
    const batch = getNextBatch(s);
    expect(batch.length).toBeGreaterThanOrEqual(1);
    expect(batch.length).toBeLessThanOrEqual(3);
    // First batch should be Tier 1 questions (all gaps at start).
    expect(batch.every((q) => q.id.startsWith('t1_') || q.id.startsWith('web_') || q.id === 't1_one_sentence' || q.id === 't1_core_loop')).toBe(
      true
    );
  });

  it('isDiscoveryComplete requires tier1 answered and allows small tier2 gap remainder', () => {
    const s = generateSchema('api-service');

    // Answer all Tier 1 questions.
    const tier1 = s.tiers.tier1.flatMap((sec) => sec.questions);
    for (const q of tier1) answerQuestion(s, q.id, 'x');

    expect(isDiscoveryComplete(s)).toBe(false);

    // Answer enough Tier 2 to leave only 2 gaps.
    const tier2 = s.tiers.tier2.flatMap((sec) => sec.questions);
    // leave 2 unanswered
    for (const q of tier2.slice(0, Math.max(0, tier2.length - 2))) answerQuestion(s, q.id, 'y');

    expect(isDiscoveryComplete(s)).toBe(true);
  });
});

