import { describe, expect, it } from 'vitest';
import { collectImportIntegrityViolations } from '../src/index.js';
import { link, makeReq } from './fixtures.js';

/**
 * SA-3: importing an archive whose per-file `.md` all parse but whose LINK GRAPH
 * violates the 2.4 invariants must be rejected with a LIST of concrete
 * violations. `collectImportIntegrityViolations` is the pure-core collector the
 * import path reuses so it shares the exact interactive-editing rules (BE-2).
 */
describe('SA-3 collectImportIntegrityViolations', () => {
  it('returns [] for a well-formed reciprocal graph', () => {
    const parent = makeReq({ slug: 'parent', links: [link('PARENT_OF', 'child')] });
    const child = makeReq({ slug: 'child', links: [link('CHILD_OF', 'parent')] });
    expect(collectImportIntegrityViolations([parent, child])).toEqual([]);
  });

  it('reports a PARENT_OF/CHILD_OF cycle with its path', () => {
    const a = makeReq({
      slug: 'a',
      links: [link('CHILD_OF', 'b'), link('PARENT_OF', 'b')],
    });
    const b = makeReq({
      slug: 'b',
      links: [link('CHILD_OF', 'a'), link('PARENT_OF', 'a')],
    });
    const violations = collectImportIntegrityViolations([a, b]);
    const cycle = violations.find((v) => v.kind === 'CYCLE');
    expect(cycle).toBeDefined();
    expect(cycle?.path?.length).toBeGreaterThan(0);
  });

  it('reports a dangling targetSlug (link into nowhere)', () => {
    const a = makeReq({ slug: 'a', links: [link('RELATES_TO', 'ghost')] });
    const violations = collectImportIntegrityViolations([a]);
    const dangling = violations.find((v) => v.kind === 'DANGLING_TARGET');
    expect(dangling).toBeDefined();
    expect(dangling?.slug).toBe('a');
    expect(dangling?.targetSlug).toBe('ghost');
  });

  it('reports a requirement with a second parent', () => {
    const p1 = makeReq({ slug: 'p1', links: [link('PARENT_OF', 'c')] });
    const p2 = makeReq({ slug: 'p2', links: [link('PARENT_OF', 'c')] });
    const c = makeReq({
      slug: 'c',
      links: [link('CHILD_OF', 'p1'), link('CHILD_OF', 'p2')],
    });
    const violations = collectImportIntegrityViolations([p1, p2, c]);
    expect(violations.some((v) => v.kind === 'MULTIPLE_PARENT' && v.slug === 'c')).toBe(true);
  });

  it('reports a self-link', () => {
    const a = makeReq({ slug: 'a', links: [link('RELATES_TO', 'a')] });
    const violations = collectImportIntegrityViolations([a]);
    expect(violations.some((v) => v.kind === 'SELF_LINK' && v.slug === 'a')).toBe(true);
  });

  it('reports a missing inverse (one-sided link)', () => {
    const a = makeReq({ slug: 'a', links: [link('RELATES_TO', 'b')] });
    const b = makeReq({ slug: 'b', links: [] });
    const violations = collectImportIntegrityViolations([a, b]);
    expect(violations.some((v) => v.kind === 'MISSING_INVERSE' && v.slug === 'a')).toBe(true);
  });

  it('collects MULTIPLE violations at once (does not fail fast)', () => {
    const a = makeReq({ slug: 'a', links: [link('RELATES_TO', 'ghost'), link('RELATES_TO', 'a')] });
    const violations = collectImportIntegrityViolations([a]);
    const kinds = new Set(violations.map((v) => v.kind));
    expect(kinds.has('DANGLING_TARGET')).toBe(true);
    expect(kinds.has('SELF_LINK')).toBe(true);
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  it('every violation carries a human-readable message', () => {
    const a = makeReq({ slug: 'a', links: [link('RELATES_TO', 'ghost')] });
    for (const v of collectImportIntegrityViolations([a])) {
      expect(typeof v.message).toBe('string');
      expect(v.message.length).toBeGreaterThan(0);
    }
  });
});
