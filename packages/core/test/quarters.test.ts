import { describe, expect, it } from 'vitest';
import { nextQuarterOf } from '../src/index.js';

describe('nextQuarterOf', () => {
  it('returns the quarter after the one containing the given date (same year)', () => {
    expect(nextQuarterOf('2026-01-15T00:00:00.000Z')).toEqual({
      targetQuarter: 'Q2',
      targetYear: 2026,
    });
    expect(nextQuarterOf('2026-04-01T00:00:00.000Z')).toEqual({
      targetQuarter: 'Q3',
      targetYear: 2026,
    });
    expect(nextQuarterOf('2026-08-31T23:59:59.000Z')).toEqual({
      targetQuarter: 'Q4',
      targetYear: 2026,
    });
  });

  it('rolls Q4 over to Q1 of the following year', () => {
    expect(nextQuarterOf('2026-10-01T00:00:00.000Z')).toEqual({
      targetQuarter: 'Q1',
      targetYear: 2027,
    });
    expect(nextQuarterOf('2026-12-31T23:59:59.000Z')).toEqual({
      targetQuarter: 'Q1',
      targetYear: 2027,
    });
  });

  it('computes in UTC on quarter boundaries', () => {
    // March (month 2) is Q1 → next is Q2.
    expect(nextQuarterOf('2026-03-31T12:00:00.000Z')).toEqual({
      targetQuarter: 'Q2',
      targetYear: 2026,
    });
  });
});
