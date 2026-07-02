import { describe, expect, it } from 'vitest';
import { CycleError, assertAcyclic, sameLink } from '../src/index.js';
import { link, makeReq } from './fixtures.js';

describe('BE-2 assertAcyclic (whole-graph cycle check)', () => {
  it('accepts an acyclic hierarchy', () => {
    const a = makeReq({ slug: 'a', links: [link('PARENT_OF', 'b')] });
    const b = makeReq({ slug: 'b', links: [link('CHILD_OF', 'a')] });
    expect(() => assertAcyclic([a, b])).not.toThrow();
  });

  it('rejects a hierarchy cycle already present in the graph', () => {
    const a = makeReq({ slug: 'a', links: [link('CHILD_OF', 'b'), link('PARENT_OF', 'b')] });
    const b = makeReq({ slug: 'b', links: [link('CHILD_OF', 'a'), link('PARENT_OF', 'a')] });
    expect(() => assertAcyclic([a, b])).toThrow(CycleError);
  });

  it('rejects a dependency cycle', () => {
    const a = makeReq({ slug: 'a', links: [link('DEPENDS_ON', 'b')] });
    const b = makeReq({ slug: 'b', links: [link('DEPENDS_ON', 'a')] });
    expect(() => assertAcyclic([a, b])).toThrow(CycleError);
  });

  it('ignores RELATES_TO', () => {
    const a = makeReq({ slug: 'a', links: [link('RELATES_TO', 'b')] });
    const b = makeReq({ slug: 'b', links: [link('RELATES_TO', 'a')] });
    expect(() => assertAcyclic([a, b])).not.toThrow();
  });
});

describe('BE-9 sameLink', () => {
  it('is true only for identical type + target', () => {
    expect(sameLink(link('PARENT_OF', 'x'), link('PARENT_OF', 'x'))).toBe(true);
    expect(sameLink(link('PARENT_OF', 'x'), link('CHILD_OF', 'x'))).toBe(false);
    expect(sameLink(link('PARENT_OF', 'x'), link('PARENT_OF', 'y'))).toBe(false);
  });
});
