import { describe, it, expect } from 'vitest';
import { buildForest, descendantCountOf, flattenVisible } from './tree';
import { makeReq } from '../test/fixtures';

/**
 * Flat requirement list matching the forest documented above:
 *   pay → card → token, pay → refund, payout (standalone).
 */
function sampleRequirements() {
  return [
    makeReq({
      slug: 'pay',
      name: 'Платежи',
      links: [
        { type: 'PARENT_OF', targetSlug: 'card' },
        { type: 'PARENT_OF', targetSlug: 'refund' },
      ],
    }),
    makeReq({
      slug: 'card',
      name: 'Оплата картой',
      links: [
        { type: 'CHILD_OF', targetSlug: 'pay' },
        { type: 'PARENT_OF', targetSlug: 'token' },
      ],
    }),
    makeReq({
      slug: 'token',
      name: 'Токенизация',
      links: [{ type: 'CHILD_OF', targetSlug: 'card' }],
    }),
    makeReq({
      slug: 'refund',
      name: 'Возвраты',
      links: [{ type: 'CHILD_OF', targetSlug: 'pay' }],
    }),
    makeReq({ slug: 'payout', name: 'Выплаты', links: [] }),
  ];
}

/**
 * Forest:
 *   pay
 *     card
 *       token
 *     refund
 *   payout
 */
function sampleForest() {
  const requirements = [
    makeReq({
      slug: 'pay',
      name: 'Платежи',
      links: [
        { type: 'PARENT_OF', targetSlug: 'card' },
        { type: 'PARENT_OF', targetSlug: 'refund' },
      ],
    }),
    makeReq({
      slug: 'card',
      name: 'Оплата картой',
      links: [
        { type: 'CHILD_OF', targetSlug: 'pay' },
        { type: 'PARENT_OF', targetSlug: 'token' },
      ],
    }),
    makeReq({
      slug: 'token',
      name: 'Токенизация',
      links: [{ type: 'CHILD_OF', targetSlug: 'card' }],
    }),
    makeReq({
      slug: 'refund',
      name: 'Возвраты',
      links: [{ type: 'CHILD_OF', targetSlug: 'pay' }],
    }),
    makeReq({ slug: 'payout', name: 'Выплаты', links: [] }),
  ];
  return buildForest(requirements);
}

describe('flattenVisible', () => {
  it('returns only root nodes when nothing is expanded', () => {
    const rows = flattenVisible(sampleForest(), new Set());
    expect(rows.map((r) => r.requirement.slug)).toEqual(['payout', 'pay']);
  });

  it('reveals direct children of an expanded node but keeps deeper subtrees collapsed', () => {
    const rows = flattenVisible(sampleForest(), new Set(['pay']));
    // pay expanded → its children appear (Возвраты < Оплата картой by RU name),
    // but card's subtree (token) stays hidden because card is not expanded.
    expect(rows.map((r) => r.requirement.slug)).toEqual(['payout', 'pay', 'refund', 'card']);
  });

  it('expanding a nested branch reveals its descendants too', () => {
    const rows = flattenVisible(sampleForest(), new Set(['pay', 'card']));
    expect(rows.map((r) => r.requirement.slug)).toEqual([
      'payout',
      'pay',
      'refund',
      'card',
      'token',
    ]);
  });

  it('a leaf node in the expanded set adds no extra rows (no children branch)', () => {
    // payout has no children — even if listed as expanded it does not recurse.
    const rows = flattenVisible(sampleForest(), new Set(['payout']));
    expect(rows.map((r) => r.requirement.slug)).toEqual(['payout', 'pay']);
  });

  it('returns an empty array for an empty forest', () => {
    expect(flattenVisible([], new Set())).toEqual([]);
  });
});

describe('descendantCountOf (UX-2 cascade sizing)', () => {
  it('counts all transitive descendants, not just direct children', () => {
    const reqs = sampleRequirements();
    const pay = reqs.find((r) => r.slug === 'pay')!;
    // pay → card → token, pay → refund ⇒ 3 descendants.
    expect(descendantCountOf(pay, reqs)).toBe(3);
  });

  it('counts a single level for a node whose children are leaves', () => {
    const reqs = sampleRequirements();
    const card = reqs.find((r) => r.slug === 'card')!;
    expect(descendantCountOf(card, reqs)).toBe(1);
  });

  it('returns 0 for a leaf requirement', () => {
    const reqs = sampleRequirements();
    const payout = reqs.find((r) => r.slug === 'payout')!;
    expect(descendantCountOf(payout, reqs)).toBe(0);
  });

  it('is cycle-safe: a self/loop reference does not recurse forever', () => {
    const a = makeReq({
      slug: 'a',
      name: 'A',
      links: [{ type: 'PARENT_OF', targetSlug: 'b' }],
    });
    const b = makeReq({
      slug: 'b',
      name: 'B',
      links: [
        { type: 'CHILD_OF', targetSlug: 'a' },
        { type: 'PARENT_OF', targetSlug: 'a' },
      ],
    });
    expect(descendantCountOf(a, [a, b])).toBe(1);
  });
});
