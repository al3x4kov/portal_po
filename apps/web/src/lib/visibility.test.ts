import { describe, it, expect } from 'vitest';
import type { Criticality, Requirement, SourceEntry } from '@po/core';
import { buildForest } from './tree';
import { computeVisibleRows } from './visibility';

/** Minimal requirement factory for unit tests (no React needed). */
function req(
  slug: string,
  name: string,
  criticality: Criticality,
  parent?: string,
  children: string[] = [],
  implemented = true,
): Requirement {
  const links = [
    ...(parent ? [{ type: 'CHILD_OF' as const, targetSlug: parent }] : []),
    ...children.map((c) => ({ type: 'PARENT_OF' as const, targetSlug: c })),
  ];
  return {
    slug,
    type: 'FUNCTION',
    name,
    criticality,
    implemented,
    description: '',
    links,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Forest:
 *   Платежи (CRITICAL)
 *     Оплата картой (HIGH)
 *       Сохранение карты токенизация (HIGH)
 *       3-D Secure (HIGH)
 *     Возвраты (MEDIUM)
 *   Выплаты (HIGH)
 */
function sampleForest() {
  const requirements = [
    req('pay', 'Платежи', 'CRITICAL', undefined, ['card', 'refund']),
    req('card', 'Оплата картой', 'HIGH', 'pay', ['token', 'tds']),
    req('token', 'Сохранение карты токенизация', 'HIGH', 'card'),
    req('tds', '3-D Secure', 'HIGH', 'card'),
    req('refund', 'Возвраты', 'MEDIUM', 'pay'),
    req('payout', 'Выплаты', 'HIGH'),
  ];
  return buildForest(requirements);
}

const NO_CRIT = new Set<Criticality>();
const NONE = new Set<string>();

describe('computeVisibleRows — unified visibility layer (A6#4)', () => {
  it('S24: "Скрыть зависимости" collapses hierarchy to root nodes only', () => {
    const res = computeVisibleRows({
      forest: sampleForest(),
      search: '',
      collapsed: true,
      expanded: NONE,
      criticalityFilter: NO_CRIT,
    });
    const slugs = res.rows.map((r) => r.requirement.slug);
    // Roots only, ordered by Russian name (Выплаты < Платежи).
    expect(slugs).toEqual(['payout', 'pay']);
    // Collapsed root with children advertises its hidden descendants for the chip.
    const pay = res.rows.find((r) => r.requirement.slug === 'pay');
    expect(pay?.hiddenCount).toBe(4);
    expect(pay?.hasChildren).toBe(true);
    const payout = res.rows.find((r) => r.requirement.slug === 'payout');
    expect(payout?.hiddenCount).toBe(0);
  });

  it('S24b: expanding one branch in collapse mode reveals only that branch', () => {
    const res = computeVisibleRows({
      forest: sampleForest(),
      search: '',
      collapsed: true,
      expanded: new Set(['pay']),
      criticalityFilter: NO_CRIT,
    });
    const slugs = res.rows.map((r) => r.requirement.slug);
    // pay expanded → its direct children appear (Возвраты < Оплата картой),
    // but their subtrees stay collapsed. Roots ordered Выплаты < Платежи.
    expect(slugs).toEqual(['payout', 'pay', 'refund', 'card']);
    const card = res.rows.find((r) => r.requirement.slug === 'card');
    expect(card?.hiddenCount).toBe(2);
  });

  it('S25: "Раскрыть все" (default) shows the full tree, all rows as matches', () => {
    const res = computeVisibleRows({
      forest: sampleForest(),
      search: '',
      collapsed: false,
      expanded: NONE,
      criticalityFilter: NO_CRIT,
    });
    expect(res.rows).toHaveLength(6);
    expect(res.rows.every((r) => r.kind === 'match')).toBe(true);
    expect(res.matchCount).toBe(6);
    expect(res.total).toBe(6);
  });

  it('S26: search reveals the match plus its ancestors marked as context', () => {
    const res = computeVisibleRows({
      forest: sampleForest(),
      search: 'токен',
      collapsed: true, // collapse is overridden by an active filter
      expanded: NONE,
      criticalityFilter: NO_CRIT,
    });
    const byKind = Object.fromEntries(res.rows.map((r) => [r.requirement.slug, r.kind]));
    expect(byKind).toEqual({ pay: 'context', card: 'context', token: 'match' });
    expect(res.matchCount).toBe(1);
    expect(res.contextCount).toBe(2);
  });

  it('S27: criticality filter keeps matches and their ancestors (context)', () => {
    const res = computeVisibleRows({
      forest: sampleForest(),
      search: '',
      collapsed: false,
      expanded: NONE,
      criticalityFilter: new Set<Criticality>(['MEDIUM']),
    });
    const byKind = Object.fromEntries(res.rows.map((r) => [r.requirement.slug, r.kind]));
    // Возвраты (MEDIUM) matches; Платежи kept as context; nothing else.
    expect(byKind).toEqual({ pay: 'context', refund: 'match' });
  });

  it('S28: search + criticality intersect (AND) and never leave orphans', () => {
    const res = computeVisibleRows({
      forest: sampleForest(),
      search: 'карт', // matches "Оплата картой" and "Сохранение карты"
      collapsed: false,
      expanded: NONE,
      criticalityFilter: new Set<Criticality>(['HIGH']),
    });
    const slugs = res.rows.map((r) => r.requirement.slug);
    // Every visible row's parent (if any) must also be visible — no orphans.
    const visible = new Set(slugs);
    for (const row of res.rows) {
      const parent = row.requirement.links.find((l) => l.type === 'CHILD_OF')?.targetSlug;
      if (parent) expect(visible.has(parent)).toBe(true);
    }
    // "Возвраты" (MEDIUM) is excluded by the AND; "Платежи" survives as context.
    expect(slugs).toContain('card');
    expect(slugs).toContain('token');
    expect(slugs).not.toContain('refund');
    const byKind = Object.fromEntries(res.rows.map((r) => [r.requirement.slug, r.kind]));
    expect(byKind.pay).toBe('context');
    expect(byKind.card).toBe('match');
  });

  it('S29: a search with no matches yields an empty result set', () => {
    const res = computeVisibleRows({
      forest: sampleForest(),
      search: 'блокчейн',
      collapsed: false,
      expanded: NONE,
      criticalityFilter: NO_CRIT,
    });
    expect(res.rows).toHaveLength(0);
    expect(res.matchCount).toBe(0);
    expect(res.total).toBe(6);
  });
});

/**
 * Implementation-status forest (T1):
 *   Платежи (DONE)
 *     Оплата картой (DONE)
 *       Токенизация (HIGH, PLANNED)
 *     Возвраты (MEDIUM, PLANNED)
 *   Выплаты (DONE)
 */
function implForest() {
  const requirements = [
    req('pay', 'Платежи', 'CRITICAL', undefined, ['card', 'refund'], true),
    req('card', 'Оплата картой', 'HIGH', 'pay', ['token'], true),
    req('token', 'Токенизация', 'HIGH', 'card', [], false),
    req('refund', 'Возвраты', 'MEDIUM', 'pay', [], false),
    req('payout', 'Выплаты', 'HIGH', undefined, [], true),
  ];
  return buildForest(requirements);
}

type Impl = 'DONE' | 'PLANNED';

describe('computeVisibleRows — implementation filter (T1, E15)', () => {
  it('PLANNED shows only planned rows plus their ancestor context (no orphans)', () => {
    const res = computeVisibleRows({
      forest: implForest(),
      search: '',
      collapsed: false,
      expanded: NONE,
      criticalityFilter: NO_CRIT,
      implementationFilter: new Set<Impl>(['PLANNED']),
    });
    const byKind = Object.fromEntries(res.rows.map((r) => [r.requirement.slug, r.kind]));
    // token & refund are the planned matches; pay/card kept only as ancestor context.
    expect(byKind).toEqual({ pay: 'context', card: 'context', token: 'match', refund: 'match' });
    expect(res.rows.map((r) => r.requirement.slug)).not.toContain('payout');
    // Every visible node keeps its parent visible — connected tree, no orphans.
    const visible = new Set(res.rows.map((r) => r.requirement.slug));
    for (const row of res.rows) {
      const parent = row.requirement.links.find((l) => l.type === 'CHILD_OF')?.targetSlug;
      if (parent) expect(visible.has(parent)).toBe(true);
    }
  });

  it('DONE shows only implemented rows', () => {
    const res = computeVisibleRows({
      forest: implForest(),
      search: '',
      collapsed: false,
      expanded: NONE,
      criticalityFilter: NO_CRIT,
      implementationFilter: new Set<Impl>(['DONE']),
    });
    const matches = res.rows
      .filter((r) => r.kind === 'match')
      .map((r) => r.requirement.slug)
      .sort();
    expect(matches).toEqual(['card', 'pay', 'payout']);
    expect(res.rows.map((r) => r.requirement.slug)).not.toContain('token');
    expect(res.rows.map((r) => r.requirement.slug)).not.toContain('refund');
  });

  it('intersects (AND) with the criticality filter without leaving orphans', () => {
    const res = computeVisibleRows({
      forest: implForest(),
      search: '',
      collapsed: false,
      expanded: NONE,
      criticalityFilter: new Set<Criticality>(['HIGH']),
      implementationFilter: new Set<Impl>(['PLANNED']),
    });
    const byKind = Object.fromEntries(res.rows.map((r) => [r.requirement.slug, r.kind]));
    // Only token is PLANNED *and* HIGH; refund (MEDIUM) drops out; ancestors stay as context.
    expect(byKind).toEqual({ pay: 'context', card: 'context', token: 'match' });
    expect(res.matchCount).toBe(1);
  });

  it('intersects (AND) with search, keeping ancestors as context', () => {
    const res = computeVisibleRows({
      forest: implForest(),
      search: 'возвраты',
      collapsed: false,
      expanded: NONE,
      criticalityFilter: NO_CRIT,
      implementationFilter: new Set<Impl>(['PLANNED']),
    });
    const byKind = Object.fromEntries(res.rows.map((r) => [r.requirement.slug, r.kind]));
    expect(byKind).toEqual({ pay: 'context', refund: 'match' });
  });

  it('an empty implementation filter behaves like no filter', () => {
    const res = computeVisibleRows({
      forest: implForest(),
      search: '',
      collapsed: false,
      expanded: NONE,
      criticalityFilter: NO_CRIT,
      implementationFilter: new Set<Impl>(),
    });
    expect(res.rows).toHaveLength(5);
    expect(res.rows.every((r) => r.kind === 'match')).toBe(true);
  });
});

function src(name: string): SourceEntry {
  return { type: 'TEXT', name, priorityId: 'p1' };
}

/**
 * Flat forest exercising the todo_19 source shapes:
 *   a — sources[] = [АС21]
 *   b — sources[] = [ПАО, АС21]  (multi-source, union)
 *   c — legacy scalar source = 'Регламент'
 *   d — no source at all («Не задан»)
 */
function sourceForest() {
  const a = req('a', 'A', 'HIGH');
  a.sources = [src('АС21')];
  const b = req('b', 'B', 'HIGH');
  b.sources = [src('ПАО'), src('АС21')];
  const c = req('c', 'C', 'HIGH');
  c.source = 'Регламент';
  const d = req('d', 'D', 'HIGH');
  return buildForest([a, b, c, d]);
}

describe('computeVisibleRows — source filter (FR-19, todo_19 sources[])', () => {
  const base = {
    search: '',
    collapsed: false,
    expanded: NONE,
    criticalityFilter: NO_CRIT,
  } as const;

  it('matches requirements whose sources[] contains the selected name', () => {
    const res = computeVisibleRows({
      ...base,
      forest: sourceForest(),
      sourceFilter: new Set(['АС21']),
    });
    // a (АС21) and b (contains АС21 among many) match; c/d drop out.
    expect(res.rows.map((r) => r.requirement.slug).sort()).toEqual(['a', 'b']);
  });

  it('unions across selected source names', () => {
    const res = computeVisibleRows({
      ...base,
      forest: sourceForest(),
      sourceFilter: new Set(['ПАО', 'Регламент']),
    });
    expect(res.rows.map((r) => r.requirement.slug).sort()).toEqual(['b', 'c']);
  });

  it('still matches the legacy scalar source', () => {
    const res = computeVisibleRows({
      ...base,
      forest: sourceForest(),
      sourceFilter: new Set(['Регламент']),
    });
    expect(res.rows.map((r) => r.requirement.slug)).toEqual(['c']);
  });

  it('«Не задан» (empty string) matches only requirements with no source', () => {
    const res = computeVisibleRows({
      ...base,
      forest: sourceForest(),
      sourceFilter: new Set(['']),
    });
    expect(res.rows.map((r) => r.requirement.slug)).toEqual(['d']);
  });

  it('an empty source filter behaves like no filter', () => {
    const res = computeVisibleRows({
      ...base,
      forest: sourceForest(),
      sourceFilter: new Set<string>(),
    });
    expect(res.rows).toHaveLength(4);
  });

  it('intersects (AND) with the criticality filter', () => {
    const a = req('a', 'A', 'HIGH');
    a.sources = [src('АС21')];
    const b = req('b', 'B', 'LOW');
    b.sources = [src('АС21')];
    const res = computeVisibleRows({
      ...base,
      forest: buildForest([a, b]),
      criticalityFilter: new Set<Criticality>(['HIGH']),
      sourceFilter: new Set(['АС21']),
    });
    // Both share the source, but only the HIGH one survives the AND.
    expect(res.rows.map((r) => r.requirement.slug)).toEqual(['a']);
  });
});
