import { describe, expect, it } from 'vitest';
import {
  HasChildrenError,
  cascadeUnlink,
  cascadeUnlinkSubtree,
  collectDescendants,
  findChildren,
} from '../src/index.js';
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

describe('UX-2 cascade subtree delete', () => {
  //     R
  //    / \
  //   C1  C2
  //   |
  //   G1        (EXT relates to G1 and to KEEP; KEEP stays)
  const build = () => [
    makeReq({ slug: 'R', links: [link('PARENT_OF', 'C1'), link('PARENT_OF', 'C2')] }),
    makeReq({ slug: 'C1', links: [link('CHILD_OF', 'R'), link('PARENT_OF', 'G1')] }),
    makeReq({ slug: 'G1', links: [link('CHILD_OF', 'C1')] }),
    makeReq({ slug: 'C2', links: [link('CHILD_OF', 'R')] }),
    makeReq({ slug: 'EXT', links: [link('RELATES_TO', 'G1'), link('RELATES_TO', 'KEEP')] }),
    makeReq({ slug: 'KEEP', links: [] }),
  ];

  it('collectDescendants returns all transitive descendants (not the root)', () => {
    expect(collectDescendants(build(), 'R').sort()).toEqual(['C1', 'C2', 'G1']);
  });

  it('collectDescendants of a leaf is empty', () => {
    expect(collectDescendants(build(), 'G1')).toEqual([]);
  });

  it('cascadeUnlinkSubtree removes root + all descendants and strips their back-refs', () => {
    const { remaining, removed } = cascadeUnlinkSubtree(build(), 'R');
    expect([...removed].sort()).toEqual(['C1', 'C2', 'G1', 'R']);
    expect(remaining.map((r) => r.slug).sort()).toEqual(['EXT', 'KEEP']);
    // EXT lost its RELATES_TO -> G1 (a removed node) but kept RELATES_TO -> KEEP.
    expect(remaining.find((r) => r.slug === 'EXT')!.links).toEqual([link('RELATES_TO', 'KEEP')]);
    // No remaining requirement points at any removed slug.
    const removedSet = new Set(removed);
    const dangling = remaining.flatMap((r) => r.links).filter((l) => removedSet.has(l.targetSlug));
    expect(dangling).toEqual([]);
  });

  it('cascadeUnlinkSubtree on a mid-tree node removes only that node and its subtree', () => {
    const { remaining, removed } = cascadeUnlinkSubtree(build(), 'C1');
    expect([...removed].sort()).toEqual(['C1', 'G1']);
    expect(remaining.map((r) => r.slug).sort()).toEqual(['C2', 'EXT', 'KEEP', 'R']);
    // R keeps its PARENT_OF -> C2 but loses PARENT_OF -> C1.
    expect(remaining.find((r) => r.slug === 'R')!.links).toEqual([link('PARENT_OF', 'C2')]);
  });

  it('cascadeUnlinkSubtree does not mutate the input array', () => {
    const input = build();
    const snapshot = JSON.parse(JSON.stringify(input));
    cascadeUnlinkSubtree(input, 'R');
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it('cascadeUnlinkSubtree is cycle-safe (never loops on a malformed graph)', () => {
    const a = makeReq({ slug: 'A', links: [link('PARENT_OF', 'B')] });
    const b = makeReq({ slug: 'B', links: [link('CHILD_OF', 'A'), link('PARENT_OF', 'A')] });
    const { removed } = cascadeUnlinkSubtree([a, b], 'A');
    expect([...removed].sort()).toEqual(['A', 'B']);
  });
});
