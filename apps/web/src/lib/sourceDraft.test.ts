import { describe, it, expect } from 'vitest';
import { riceScore, type SourceEntry, type SourcePriority } from '@po/core';
import {
  defaultPriorityId,
  emptyDraft,
  toDraft,
  draftRice,
  draftScore,
  draftsToSources,
  draftsForAggregate,
  type SourceDraft,
} from './sourceDraft';

const PRIORITIES: SourcePriority[] = [
  { id: 'p-crit', name: 'Критично', color: 'red', order: 2 },
  { id: 'default', name: 'Квартальная цель', color: 'amber', order: 0 },
  { id: 'p-mid', name: 'Средний', color: 'blue', order: 1 },
];

function draft(partial: Partial<SourceDraft> = {}): SourceDraft {
  return { _key: 'k', type: 'CLIENT', name: 'Альфа', priorityId: 'default', ...partial };
}

describe('defaultPriorityId', () => {
  it('returns the most senior (min order) priority id', () => {
    expect(defaultPriorityId(PRIORITIES)).toBe('default');
  });

  it('falls back to «default» when the list is empty', () => {
    expect(defaultPriorityId([])).toBe('default');
  });
});

describe('emptyDraft', () => {
  it('seeds a blank CLIENT draft with the senior priority and a stable key', () => {
    const d = emptyDraft(PRIORITIES);
    expect(d.type).toBe('CLIENT');
    expect(d.name).toBe('');
    expect(d.priorityId).toBe('default');
    expect(d._key).toMatch(/^src-/);
    expect(emptyDraft(PRIORITIES)._key).not.toBe(d._key);
  });
});

describe('toDraft', () => {
  it('maps a persisted entry (with rice + term) into an editable draft', () => {
    const entry: SourceEntry = {
      type: 'STAKEHOLDER',
      name: 'Иванов',
      priorityId: 'p-mid',
      rice: { reach: 4, impact: 2, confidence: 0.8, effort: 3 },
      targetQuarter: 'Q3',
      targetYear: 2026,
      targetDate: '2026-08-01',
    };
    const d = toDraft(entry);
    expect(d).toMatchObject({
      type: 'STAKEHOLDER',
      name: 'Иванов',
      priorityId: 'p-mid',
      reach: 4,
      impact: 2,
      confidence: 0.8,
      effort: 3,
      targetQuarter: 'Q3',
      targetYear: 2026,
      targetDate: '2026-08-01',
    });
    expect(d._key).toMatch(/^src-/);
  });

  it('leaves rice fields undefined when the entry carries no rice', () => {
    const d = toDraft({ type: 'CLIENT', name: 'Альфа', priorityId: 'default' });
    expect(d.reach).toBeUndefined();
    expect(d.effort).toBeUndefined();
  });
});

describe('draftRice / draftScore', () => {
  it('is undefined until all four RICE fields are present', () => {
    expect(draftRice(draft({ reach: 4, impact: 2, confidence: 0.8 }))).toBeUndefined();
    expect(draftScore(draft({ reach: 4, impact: 2, confidence: 0.8 }))).toBeUndefined();
  });

  it('computes the score once the estimate is complete', () => {
    const d = draft({ reach: 4, impact: 2, confidence: 0.8, effort: 3 });
    expect(draftRice(d)).toEqual({ reach: 4, impact: 2, confidence: 0.8, effort: 3 });
    expect(draftScore(d)).toBe(riceScore({ reach: 4, impact: 2, confidence: 0.8, effort: 3 }));
  });
});

describe('draftsToSources', () => {
  it('drops unnamed drafts and trims names', () => {
    const out = draftsToSources([
      draft({ name: '   ' }),
      draft({ name: '  Бета  ', priorityId: 'p-mid' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: 'CLIENT', name: 'Бета', priorityId: 'p-mid' });
  });

  it('serialises rice and term fields, omitting empty optionals', () => {
    const out = draftsToSources([
      draft({
        name: 'Альфа',
        reach: 5,
        impact: 3,
        confidence: 1,
        effort: 2,
        targetQuarter: 'Q2',
        targetYear: 2027,
        targetDate: '2027-05-01',
      }),
    ]);
    expect(out[0]).toEqual({
      type: 'CLIENT',
      name: 'Альфа',
      priorityId: 'default',
      rice: { reach: 5, impact: 3, confidence: 1, effort: 2 },
      targetQuarter: 'Q2',
      targetYear: 2027,
      targetDate: '2027-05-01',
    });
  });

  it('omits rice when incomplete and skips an empty targetDate', () => {
    const out = draftsToSources([
      draft({ name: 'Альфа', reach: 5, impact: 3, targetYear: 2027, targetDate: '' }),
    ]);
    expect(out[0].rice).toBeUndefined();
    expect(out[0].targetDate).toBeUndefined();
    expect(out[0].targetYear).toBe(2027);
  });

  it('draftsForAggregate mirrors draftsToSources', () => {
    const drafts = [draft({ name: 'Альфа', reach: 5, impact: 3, confidence: 1, effort: 2 })];
    expect(draftsForAggregate(drafts)).toEqual(draftsToSources(drafts));
  });
});
