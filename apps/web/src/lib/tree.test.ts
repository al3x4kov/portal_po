import { describe, it, expect } from 'vitest';
import { buildForest, flattenVisible } from './tree';
import { makeReq } from '../test/fixtures';

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
