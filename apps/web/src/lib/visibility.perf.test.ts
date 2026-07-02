import { describe, it, expect } from 'vitest';
import type { Criticality, Requirement } from '@po/core';
import { buildForest } from './tree';
import { computeVisibleRows } from './visibility';

/**
 * QA-2 · performance budget for the single visibility layer. `computeVisibleRows`
 * runs on every keystroke of the search box and on every filter toggle, so it
 * must stay well under one animation frame (~16ms) even for a large project.
 * Budget: a full pass over ≥1000 requirements (build + expand + filter) under
 * 50ms — comfortably interactive, with headroom for slower CI machines.
 *
 * This is a guard against accidental O(n²) regressions in the visibility passes,
 * not a micro-benchmark; the threshold is deliberately loose.
 */

const CRITS: Criticality[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'BLOCKER'];
const BUDGET_MS = 50;
const N = 1200; // ≥1000 nodes (SA scale target)

/** Build N requirements as a wide, 3-level forest (roots → children → leaves). */
function largeForest() {
  const reqs: Requirement[] = [];
  const roots = Math.ceil(N / 30); // ~40 roots, each with children and grandchildren
  let made = 0;
  for (let r = 0; r < roots && made < N; r += 1) {
    const rootSlug = `r-${r}`;
    const childSlugs: string[] = [];
    for (let c = 0; c < 5 && made < N; c += 1) {
      const childSlug = `r-${r}-c-${c}`;
      const grandSlugs: string[] = [];
      for (let g = 0; g < 4 && made < N; g += 1) {
        const gSlug = `r-${r}-c-${c}-g-${g}`;
        grandSlugs.push(gSlug);
        reqs.push(mk(gSlug, `Требование ${gSlug}`, childSlug, [], made));
        made += 1;
      }
      childSlugs.push(childSlug);
      reqs.push(mk(childSlug, `Требование ${childSlug}`, rootSlug, grandSlugs, made));
      made += 1;
    }
    reqs.push(mk(rootSlug, `Требование ${rootSlug}`, undefined, childSlugs, made));
    made += 1;
  }
  return buildForest(reqs);
}

function mk(
  slug: string,
  name: string,
  parent: string | undefined,
  children: string[],
  i: number,
): Requirement {
  return {
    slug,
    type: 'FUNCTION',
    name,
    criticality: CRITS[i % CRITS.length]!,
    implemented: i % 2 === 0,
    description: '',
    links: [
      ...(parent ? [{ type: 'CHILD_OF' as const, targetSlug: parent }] : []),
      ...children.map((c) => ({ type: 'PARENT_OF' as const, targetSlug: c })),
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('QA-2 · computeVisibleRows performance (≥1000 nodes)', () => {
  const forest = largeForest();
  const noCrit = new Set<Criticality>();
  const noExpand = new Set<string>();

  it('builds a forest of at least 1000 requirements', () => {
    const total = computeVisibleRows({
      forest,
      search: '',
      collapsed: false,
      expanded: noExpand,
      criticalityFilter: noCrit,
    }).total;
    expect(total).toBeGreaterThanOrEqual(1000);
  });

  it('expand-all pass stays within the interactive budget', () => {
    const start = performance.now();
    const res = computeVisibleRows({
      forest,
      search: '',
      collapsed: false,
      expanded: noExpand,
      criticalityFilter: noCrit,
    });
    const elapsed = performance.now() - start;
    expect(res.rows.length).toBe(res.total);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('search + criticality filter pass stays within the interactive budget', () => {
    const start = performance.now();
    const res = computeVisibleRows({
      forest,
      search: 'требование',
      collapsed: false,
      expanded: noExpand,
      criticalityFilter: new Set<Criticality>(['HIGH', 'CRITICAL']),
    });
    const elapsed = performance.now() - start;
    expect(res.rows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
