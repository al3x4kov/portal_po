import { describe, expect, it } from 'vitest';
import {
  PRIORITY_COLORS,
  RICE_CONFIDENCE,
  RICE_EFFORT,
  RICE_IMPACT,
  RICE_REACH,
  SOURCE_TYPES,
  findDuplicateName,
  projectDictionariesSchema,
  sourceEntrySchema,
  sourcePrioritySchema,
  sourceRefSchema,
  type ProjectDictionaries,
  type SourceEntry,
} from '../src/index.js';

describe('T-101 domain scales & palette', () => {
  it('exposes the RICE scales exactly as decided by PO', () => {
    expect([...RICE_REACH]).toEqual([1, 2, 3, 4, 5]);
    expect([...RICE_IMPACT]).toEqual([0.25, 0.5, 1, 2, 3]);
    expect([...RICE_CONFIDENCE]).toEqual([0.5, 0.8, 1]);
    expect([...RICE_EFFORT]).toEqual([0.5, 1, 2, 3, 5, 8]);
  });

  it('exposes an 8-color priority palette', () => {
    expect(PRIORITY_COLORS).toHaveLength(8);
    expect([...PRIORITY_COLORS]).toEqual([
      'red',
      'amber',
      'blue',
      'green',
      'purple',
      'sky',
      'gray',
      'pink',
    ]);
  });

  it('exposes the source types (todo_22 appends BACKLOG; the historical four stay)', () => {
    expect([...SOURCE_TYPES]).toEqual(['CLIENT', 'STAKEHOLDER', 'STANDARD', 'TEXT', 'BACKLOG']);
  });
});

describe('T-102 sourceEntrySchema', () => {
  const base: SourceEntry = { type: 'CLIENT', name: 'Acme', priorityId: 'p1' };

  it('accepts a minimal entry (type,name,priorityId)', () => {
    expect(sourceEntrySchema.parse(base)).toEqual(base);
  });

  it('trims the name and rejects empty / >100', () => {
    expect(sourceEntrySchema.parse({ ...base, name: '  Acme  ' }).name).toBe('Acme');
    expect(() => sourceEntrySchema.parse({ ...base, name: '   ' })).toThrow();
    expect(() => sourceEntrySchema.parse({ ...base, name: 'x'.repeat(101) })).toThrow();
  });

  it('rejects an empty priorityId', () => {
    expect(() => sourceEntrySchema.parse({ ...base, priorityId: '' })).toThrow();
  });

  it('accepts a full RICE from the allowed scales', () => {
    const full: SourceEntry = {
      ...base,
      rice: { reach: 4, impact: 3, confidence: 0.8, effort: 3 },
      targetQuarter: 'Q2',
      targetYear: 2026,
      targetDate: '2026-05-01',
    };
    expect(sourceEntrySchema.parse(full)).toEqual(full);
  });

  it('rejects a RICE value outside the scale', () => {
    expect(() =>
      sourceEntrySchema.parse({
        ...base,
        rice: { reach: 7, impact: 3, confidence: 0.8, effort: 3 },
      }),
    ).toThrow();
  });

  it('rejects targetYear out of 2020..2100', () => {
    expect(() => sourceEntrySchema.parse({ ...base, targetYear: 2019 })).toThrow();
    expect(() => sourceEntrySchema.parse({ ...base, targetYear: 2101 })).toThrow();
  });

  it('rejects a malformed targetDate', () => {
    expect(() => sourceEntrySchema.parse({ ...base, targetDate: '2026-13-40' })).toThrow();
    expect(() => sourceEntrySchema.parse({ ...base, targetDate: 'not-a-date' })).toThrow();
  });
});

describe('T-102 dictionary schemas', () => {
  it('validates a SourcePriority', () => {
    const p = { id: 'p1', name: 'Квартальная цель', color: 'amber', order: 0 };
    expect(sourcePrioritySchema.parse(p)).toEqual(p);
    expect(() => sourcePrioritySchema.parse({ ...p, color: 'chartreuse' })).toThrow();
    expect(() => sourcePrioritySchema.parse({ ...p, name: '' })).toThrow();
  });

  it('validates a SourceRef', () => {
    const s = { id: 's1', name: 'Acme', type: 'CLIENT' };
    expect(sourceRefSchema.parse(s)).toEqual(s);
    expect(() => sourceRefSchema.parse({ ...s, type: 'BOGUS' })).toThrow();
  });

  it('validates ProjectDictionaries', () => {
    const d: ProjectDictionaries = {
      priorities: [{ id: 'p1', name: 'A', color: 'red', order: 0 }],
      sources: [{ id: 's1', name: 'Acme', type: 'TEXT' }],
    };
    expect(projectDictionariesSchema.parse(d)).toEqual(d);
  });
});

describe('T-102 findDuplicateName (case-insensitive + trim)', () => {
  it('returns undefined when all names are distinct', () => {
    expect(findDuplicateName(['Alpha', 'Beta'])).toBeUndefined();
  });

  it('detects a case-insensitive / trimmed duplicate', () => {
    expect(findDuplicateName(['Alpha', '  alpha '])).toBe('alpha');
  });
});
