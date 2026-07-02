import { describe, expect, it } from 'vitest';
import { HasChildrenError, cascadeUnlink, findChildren } from '../src/index.js';
import { link, makeReq } from './fixtures.js';

describe('T-206 cascadeUnlink', () => {
  it('removes the deleted requirement and strips all back-references', () => {
    const target = makeReq({ slug: 'T', links: [] });
    const a = makeReq({ slug: 'A', links: [link('RELATES_TO', 'T'), link('RELATES_TO', 'X')] });
    const b = makeReq({ slug: 'B', links: [link('DEPENDS_ON', 'T')] });
    const result = cascadeUnlink([target, a, b], 'T');

    expect(result.map((r) => r.slug)).toEqual(['A', 'B']);
    const dangling = result.flatMap((r) => r.links).filter((l) => l.targetSlug === 'T');
    expect(dangling).toHaveLength(0);
    // unrelated links are preserved
    expect(result.find((r) => r.slug === 'A')?.links).toEqual([link('RELATES_TO', 'X')]);
  });

  it('deletes a leaf node with no references cleanly', () => {
    const leaf = makeReq({ slug: 'L', links: [] });
    const other = makeReq({ slug: 'O', links: [] });
    const result = cascadeUnlink([leaf, other], 'L');
    expect(result.map((r) => r.slug)).toEqual(['O']);
  });

  it('rejects deleting a node that still has children (FR-9.3)', () => {
    const parent = makeReq({ slug: 'P', links: [link('PARENT_OF', 'C')] });
    const child = makeReq({ slug: 'C', links: [link('CHILD_OF', 'P')] });
    expect(() => cascadeUnlink([parent, child], 'P')).toThrow(HasChildrenError);
  });

  it('HasChildrenError lists the blocking children', () => {
    const parent = makeReq({ slug: 'P', links: [link('PARENT_OF', 'C1')] });
    const c1 = makeReq({ slug: 'C1', links: [link('CHILD_OF', 'P')] });
    try {
      cascadeUnlink([parent, c1], 'P');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HasChildrenError);
      expect((err as HasChildrenError).children).toContain('C1');
    }
  });

  it('does not mutate the input array', () => {
    const a = makeReq({ slug: 'A', links: [link('RELATES_TO', 'T')] });
    const target = makeReq({ slug: 'T', links: [] });
    const input = [a, target];
    const snapshot = JSON.parse(JSON.stringify(input));
    cascadeUnlink(input, 'T');
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it('findChildren returns direct children only', () => {
    const parent = makeReq({ slug: 'P', links: [link('PARENT_OF', 'C')] });
    const child = makeReq({ slug: 'C', links: [link('CHILD_OF', 'P')] });
    const unrelated = makeReq({ slug: 'U', links: [link('RELATES_TO', 'P')] });
    expect(findChildren([parent, child, unrelated], 'P')).toEqual(['C']);
  });
});
