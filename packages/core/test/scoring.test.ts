import { describe, expect, it } from 'vitest';
import {
  aggregatePriorityId,
  aggregateRiceScore,
  isDateInQuarter,
  riceScore,
  type SourceEntry,
  type SourcePriority,
} from '../src/index.js';

const src = (over: Partial<SourceEntry> = {}): SourceEntry => ({
  type: 'CLIENT',
  name: 'S',
  priorityId: 'p1',
  ...over,
});

describe('T-103 riceScore', () => {
  it('computes reach*impact*confidence/effort rounded to 0.1', () => {
    expect(riceScore({ reach: 4, impact: 3, confidence: 0.8, effort: 3 })).toBe(3.2);
  });

  it('rounds to a single decimal', () => {
    // 5*2*1/3 = 3.333… → 3.3
    expect(riceScore({ reach: 5, impact: 2, confidence: 1, effort: 3 })).toBe(3.3);
  });

  it('handles fractional impact/effort without float drift', () => {
    // 3*2*0.8/2 = 2.4
    expect(riceScore({ reach: 3, impact: 2, confidence: 0.8, effort: 2 })).toBe(2.4);
  });

  it('guards against a zero effort (never divides by zero)', () => {
    expect(riceScore({ reach: 3, impact: 2, confidence: 1, effort: 0 })).toBe(0);
  });
});

describe('T-103 aggregateRiceScore', () => {
  it('returns the max score across sources with rice', () => {
    const sources = [
      src({ rice: { reach: 4, impact: 3, confidence: 0.8, effort: 3 } }), // 3.2
      src({ rice: { reach: 3, impact: 2, confidence: 0.8, effort: 2 } }), // 2.4
      src({}), // no rice
    ];
    expect(aggregateRiceScore(sources)).toBe(3.2);
  });

  it('returns undefined when no source has rice', () => {
    expect(aggregateRiceScore([src(), src()])).toBeUndefined();
    expect(aggregateRiceScore([])).toBeUndefined();
  });
});

describe('T-103 aggregatePriorityId', () => {
  const priorities: SourcePriority[] = [
    { id: 'p1', name: 'Senior', color: 'red', order: 0 },
    { id: 'p2', name: 'Mid', color: 'amber', order: 1 },
    { id: 'p3', name: 'Junior', color: 'gray', order: 2 },
  ];

  it('returns the priorityId of the source with the smallest order', () => {
    const sources = [src({ priorityId: 'p3' }), src({ priorityId: 'p2' })];
    expect(aggregatePriorityId(sources, priorities)).toBe('p2');
  });

  it('returns the senior-most when several sources present', () => {
    const sources = [
      src({ priorityId: 'p3' }),
      src({ priorityId: 'p1' }),
      src({ priorityId: 'p2' }),
    ];
    expect(aggregatePriorityId(sources, priorities)).toBe('p1');
  });

  it('returns undefined for no sources', () => {
    expect(aggregatePriorityId([], priorities)).toBeUndefined();
  });

  it('ignores sources whose priorityId is unknown', () => {
    const sources = [src({ priorityId: 'ghost' }), src({ priorityId: 'p2' })];
    expect(aggregatePriorityId(sources, priorities)).toBe('p2');
  });
});

describe('T-103 isDateInQuarter (non-throwing)', () => {
  it('true when the date falls inside the quarter', () => {
    expect(isDateInQuarter('2026-09-15', 'Q3', 2026)).toBe(true);
    expect(isDateInQuarter('2026-07-01', 'Q3', 2026)).toBe(true);
    expect(isDateInQuarter('2026-09-30', 'Q3', 2026)).toBe(true);
  });

  it('false when the date is outside the quarter', () => {
    expect(isDateInQuarter('2026-11-05', 'Q3', 2026)).toBe(false);
    expect(isDateInQuarter('2026-06-30', 'Q3', 2026)).toBe(false);
  });

  it('false for a different year', () => {
    expect(isDateInQuarter('2025-09-15', 'Q3', 2026)).toBe(false);
  });

  it('false (never throws) for a malformed date', () => {
    expect(isDateInQuarter('not-a-date', 'Q3', 2026)).toBe(false);
    expect(isDateInQuarter('', 'Q1', 2026)).toBe(false);
  });
});
