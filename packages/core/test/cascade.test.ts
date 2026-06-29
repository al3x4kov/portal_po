import { describe, expect, it } from 'vitest';
import { HasChildrenError, cascadeUnlink, findChildren } from '../src/index.js';
import { link, makeReq } from './fixtures.js';

describe('T-206 cascadeUnlink', () => {
  it('removes the deleted requirement and strips all back-references', () => {
    const target = makeReq({ id: 'T', links: [] });
    const a = makeReq({ id: 'A', links: [link('RELATES_TO', 'T'), link('RELATES_TO', 'X')] });
    const b = makeReq({ id: 'B', links: [link('DEPENDS_ON', 'T')] });
    const result = cascadeUnlink([target, a, b], 'T');

    expect(result.map((r) => r.id)).toEqual(['A', 'B']);
    const dangling = result.flatMap((r) => r.links).filter((l) => l.targetId === 'T');
    expect(dangling).toHaveLength(0);
    // unrelated links are preserved
    expect(result.find((r) => r.id === 'A')?.links).toEqual([link('RELATES_TO', 'X')]);
  });

  it('deletes a leaf node with no references cleanly', () => {
    const leaf = makeReq({ id: 'L', links: [] });
    const other = makeReq({ id: 'O', links: [] });
    const result = cascadeUnlink([leaf, other], 'L');
    expect(result.map((r) => r.id)).toEqual(['O']);
  });

  it('rejects deleting a node that still has children (FR-9.3)', () => {
    const parent = makeReq({ id: 'P', links: [link('PARENT_OF', 'C')] });
    const child = makeReq({ id: 'C', links: [link('CHILD_OF', 'P')] });
    expect(() => cascadeUnlink([parent, child], 'P')).toThrow(HasChildrenError);
  });

  it('HasChildrenError lists the blocking children', () => {
    const parent = makeReq({ id: 'P', links: [link('PARENT_OF', 'C1')] });
    const c1 = makeReq({ id: 'C1', links: [link('CHILD_OF', 'P')] });
    try {
      cascadeUnlink([parent, c1], 'P');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HasChildrenError);
      expect((err as HasChildrenError).children).toContain('C1');
    }
  });

  it('does not mutate the input array', () => {
    const a = makeReq({ id: 'A', links: [link('RELATES_TO', 'T')] });
    const target = makeReq({ id: 'T', links: [] });
    const input = [a, target];
    const snapshot = JSON.parse(JSON.stringify(input));
    cascadeUnlink(input, 'T');
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it('findChildren returns direct children only', () => {
    const parent = makeReq({ id: 'P', links: [link('PARENT_OF', 'C')] });
    const child = makeReq({ id: 'C', links: [link('CHILD_OF', 'P')] });
    const unrelated = makeReq({ id: 'U', links: [link('RELATES_TO', 'P')] });
    expect(findChildren([parent, child, unrelated], 'P')).toEqual(['C']);
  });
});
