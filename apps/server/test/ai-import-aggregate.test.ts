import { describe, expect, it } from 'vitest';
import type { AiExtractedRequirement, Requirement } from '@po/core';
import {
  aggregateRequirements,
  renderAggregateEvent,
  summarizeTree,
  type AggregateEvent,
} from '../src/services/aiImport/aggregate.js';
import type { AggregatedRecord } from '../src/services/aiImport/types.js';

/** Minimal extracted record (source is mandatory in the pipeline). */
function ext(over: Partial<AiExtractedRequirement> = {}): AiExtractedRequirement {
  return {
    type: 'FUNCTION',
    name: 'A',
    description: 'd',
    source: 's.md',
    ...over,
  } as AiExtractedRequirement;
}

/** Minimal already-existing requirement (only type+name matter to aggregate). */
function existing(type: 'FUNCTION' | 'NFR', name: string): Requirement {
  return {
    slug: name.toLowerCase(),
    type,
    name,
    criticality: 'MEDIUM',
    implemented: true,
    links: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const NO_STRUCT = new Map<string, string | null>();

describe('aggregateRequirements (pure)', () => {
  it('keeps distinct records and reports the aggregated count', () => {
    const { aggregated, events } = aggregateRequirements({
      extracted: [ext({ name: 'Login' }), ext({ type: 'NFR', name: 'Fast' })],
      existing: [],
      structureParentByKey: NO_STRUCT,
    });
    expect(aggregated).toHaveLength(2);
    expect(events).toContainEqual({ kind: 'aggregatedCount', count: 2 });
    expect(aggregated.every((a) => a.parentKey === undefined)).toBe(true);
  });

  it('dedups by (type, name) case-insensitively and emits a duplicates event', () => {
    const { aggregated, events } = aggregateRequirements({
      extracted: [ext({ name: 'Login' }), ext({ name: 'login' })],
      existing: [],
      structureParentByKey: NO_STRUCT,
    });
    expect(aggregated).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'duplicates', names: ['login'] });
  });

  it('merges relatedFunctions of duplicate NFRs, first wording kept', () => {
    const { aggregated } = aggregateRequirements({
      extracted: [
        ext({ type: 'NFR', name: 'Perf', relatedFunctions: ['Login'] }),
        ext({ type: 'NFR', name: 'perf', relatedFunctions: ['login', 'Logout'] }),
      ],
      existing: [],
      structureParentByKey: NO_STRUCT,
    });
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]!.record.relatedFunctions).toEqual(['Login', 'Logout']);
  });

  it('resolves a same-type parent from the structure answer', () => {
    const parents = new Map<string, string | null>([['FUNCTION:child', 'Parent']]);
    const { aggregated } = aggregateRequirements({
      extracted: [ext({ name: 'Parent' }), ext({ name: 'Child' })],
      existing: [],
      structureParentByKey: parents,
    });
    const child = aggregated.find((a) => a.record.name === 'Child')!;
    expect(child.parentKey).toBe('FUNCTION:parent');
    expect(child.parentName).toBe('Parent');
  });

  it('resolves a parent that already exists in the project', () => {
    const parents = new Map<string, string | null>([['FUNCTION:child', 'Root']]);
    const { aggregated } = aggregateRequirements({
      extracted: [ext({ name: 'Child' })],
      existing: [existing('FUNCTION', 'Root')],
      structureParentByKey: parents,
    });
    expect(aggregated[0]!.parentKey).toBe('FUNCTION:root');
  });

  it('drops a cross-type parent and emits parentOtherType', () => {
    const parents = new Map<string, string | null>([['FUNCTION:child', 'Perf']]);
    const { aggregated, events } = aggregateRequirements({
      extracted: [ext({ name: 'Child' }), ext({ type: 'NFR', name: 'Perf' })],
      existing: [],
      structureParentByKey: parents,
    });
    expect(aggregated.find((a) => a.record.name === 'Child')!.parentKey).toBeUndefined();
    expect(events).toContainEqual({
      kind: 'parentOtherType',
      childName: 'Child',
      parentName: 'Perf',
    });
  });

  it('emits parentNotFound for an unknown parent', () => {
    const parents = new Map<string, string | null>([['FUNCTION:child', 'Ghost']]);
    const { events } = aggregateRequirements({
      extracted: [ext({ name: 'Child' })],
      existing: [],
      structureParentByKey: parents,
    });
    expect(events).toContainEqual({
      kind: 'parentNotFound',
      childName: 'Child',
      parentName: 'Ghost',
    });
  });

  it('breaks a parent cycle deterministically and emits cycleBroken', () => {
    const parents = new Map<string, string | null>([
      ['FUNCTION:a', 'B'],
      ['FUNCTION:b', 'A'],
    ]);
    const { aggregated, events } = aggregateRequirements({
      extracted: [ext({ name: 'A' }), ext({ name: 'B' })],
      existing: [],
      structureParentByKey: parents,
    });
    const broken = events.filter(
      (e): e is Extract<AggregateEvent, { kind: 'cycleBroken' }> => e.kind === 'cycleBroken',
    );
    expect(broken).toHaveLength(1);
    // The node whose edge closes the cycle becomes a root again.
    const rootAgain = aggregated.find((a) => a.record.name === broken[0]!.childName)!;
    expect(rootAgain.parentKey).toBeUndefined();
  });

  it('ignores a self-parent', () => {
    const parents = new Map<string, string | null>([['FUNCTION:a', 'A']]);
    const { aggregated, events } = aggregateRequirements({
      extracted: [ext({ name: 'A' })],
      existing: [],
      structureParentByKey: parents,
    });
    expect(aggregated[0]!.parentKey).toBeUndefined();
    expect(events.some((e) => e.kind === 'cycleBroken')).toBe(false);
  });
});

describe('summarizeTree (pure)', () => {
  const rec = (type: 'FUNCTION' | 'NFR', name: string, parentKey?: string): AggregatedRecord => ({
    record: ext({ type, name }),
    parentKey,
  });

  it('counts roots/children per type and the max depth', () => {
    const summary = summarizeTree([
      rec('FUNCTION', 'Root'),
      rec('FUNCTION', 'Child', 'FUNCTION:root'),
      rec('FUNCTION', 'Grand', 'FUNCTION:child'),
      rec('NFR', 'N1'),
    ]);
    expect(summary).toEqual({
      fnRoots: 1,
      fnChildren: 2,
      nfrRoots: 1,
      nfrChildren: 0,
      maxDepth: 3,
    });
  });
});

describe('renderAggregateEvent', () => {
  it('renders each event kind to a RU log line', () => {
    expect(renderAggregateEvent({ kind: 'duplicates', names: ['X'] })).toEqual({
      level: 'warn',
      message: 'Дубликатов в извлечении пропущено: 1 (повторы по (тип, имя): «X»).',
    });
    expect(renderAggregateEvent({ kind: 'cycleBroken', childName: 'X' })).toEqual({
      level: 'warn',
      message: 'Цикл разорван: «X» становится корневым.',
    });
    expect(renderAggregateEvent({ kind: 'aggregatedCount', count: 3 }).message).toBe(
      'К наполнению после агрегации: 3 требований.',
    );
    expect(
      renderAggregateEvent({
        kind: 'treeSummary',
        summary: { fnRoots: 1, fnChildren: 0, nfrRoots: 0, nfrChildren: 0, maxDepth: 1 },
      }).level,
    ).toBe('info');
  });
});
