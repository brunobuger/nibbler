import { describe, expect, it } from 'vitest';

import { JobIdGenerator, parseJobId } from '../src/utils/id.js';

describe('job id', () => {
  it('generates sortable ids with YYYYMMDD-NNN', () => {
    const gen = new JobIdGenerator();
    const id1 = gen.next(new Date('2026-02-07T00:00:00Z'));
    const id2 = gen.next(new Date('2026-02-07T00:00:01Z'));

    expect(parseJobId(id1)).toEqual({ yyyyMMdd: '20260207', nnn: '001' });
    expect(parseJobId(id2)).toEqual({ yyyyMMdd: '20260207', nnn: '002' });
  });
});

