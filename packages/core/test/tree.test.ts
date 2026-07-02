import { describe, expect, it } from 'vitest';
import {
  ancestorNamesOf,
  buildForest,
  childCountOf,
  orderTree,
  parentSlugOf,
} from '../src/index.js';
import { link, makeReq } from './fixtures.js';

describe('BE-4 shared tree traversal', () => {
  it('derives parent slug and child count from links', () => {
    const child = makeReq({ slug: 'c', links: [link('CHILD_OF', 'p')] });
    const parent = makeReq({ slug: 'p', links: [link('PARENT_OF', 'c')] });
    expect(parentSlugOf(child)).toBe('p');
    expect(parentSlugOf(parent)).toBeUndefined();
    expect(childCountOf(parent)).toBe(1);
    expect(childCountOf(child)).toBe(0);
  });

  it('builds a forest sorted by name (ru) with depth', () => {
    const root = makeReq({ slug: 'root', name: 'Альфа', links: [link('PARENT_OF', 'b')] });
    const b = makeReq({ slug: 'b', name: 'Бета', links: [link('CHILD_OF', 'root')] });
    const solo = makeReq({ slug: 'solo', name: 'Гамма', links: [] });
    const forest = buildForest([b, solo, root]);
    expect(forest.map((n) => n.requirement.slug)).toEqual(['root', 'solo']);
    expect(forest[0]!.depth).toBe(0);
    expect(forest[0]!.children[0]!.requirement.slug).toBe('b');
    expect(forest[0]!.children[0]!.depth).toBe(1);
  });

  it('orderTree yields the same order as a fully-expanded forest walk', () => {
    const root = makeReq({ slug: 'root', name: 'Альфа', links: [link('PARENT_OF', 'b')] });
    const b = makeReq({ slug: 'b', name: 'Бета', links: [link('CHILD_OF', 'root')] });
    const solo = makeReq({ slug: 'solo', name: 'Гамма', links: [] });
    const reqs = [b, solo, root];

    const flat: { slug: string; depth: number }[] = [];
    const walk = (nodes: ReturnType<typeof buildForest>): void => {
      for (const n of nodes) {
        flat.push({ slug: n.requirement.slug, depth: n.depth });
        walk(n.children);
      }
    };
    walk(buildForest(reqs));

    const ordered = orderTree(reqs).map((o) => ({ slug: o.requirement.slug, depth: o.depth }));
    expect(ordered).toEqual(flat);
  });

  it('orderTree emits every requirement even inside a cycle', () => {
    const a = makeReq({ slug: 'a', links: [link('CHILD_OF', 'b'), link('PARENT_OF', 'b')] });
    const b = makeReq({ slug: 'b', links: [link('CHILD_OF', 'a'), link('PARENT_OF', 'a')] });
    expect(
      orderTree([a, b])
        .map((o) => o.requirement.slug)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('lists ancestor names root → parent', () => {
    const root = makeReq({ slug: 'root', name: 'Root', links: [link('PARENT_OF', 'mid')] });
    const mid = makeReq({
      slug: 'mid',
      name: 'Mid',
      links: [link('CHILD_OF', 'root'), link('PARENT_OF', 'leaf')],
    });
    const leaf = makeReq({ slug: 'leaf', name: 'Leaf', links: [link('CHILD_OF', 'mid')] });
    expect(ancestorNamesOf(leaf, [root, mid, leaf])).toEqual(['Root', 'Mid']);
  });
});
