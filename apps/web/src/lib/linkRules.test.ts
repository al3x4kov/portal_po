import { describe, it, expect } from 'vitest';
import { linkCandidateStatus } from './linkRules';
import { makeReq } from '../test/fixtures';

describe('linkCandidateStatus (UX-4, reuses @po/core predicates)', () => {
  it('excludes the source itself', () => {
    const a = makeReq({ slug: 'a', name: 'A' });
    expect(linkCandidateStatus([a], a, 'CHILD_OF', a).ok).toBe(false);
  });

  it('CHILD_OF: a target of a different requirement type is unavailable', () => {
    const fn = makeReq({ slug: 'fn', name: 'Функция', type: 'FUNCTION' });
    const nfr = makeReq({ slug: 'nfr', name: 'НФТ', type: 'NFR' });
    const status = linkCandidateStatus([fn, nfr], fn, 'CHILD_OF', nfr);
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/тип/i);
  });

  it('CHILD_OF: a target that would create a cycle is unavailable', () => {
    // parent PARENT_OF child; child CHILD_OF parent. Making parent a child of
    // its own descendant closes a cycle.
    const parent = makeReq({
      slug: 'p',
      name: 'Родитель',
      links: [{ type: 'PARENT_OF', targetSlug: 'c' }],
    });
    const child = makeReq({
      slug: 'c',
      name: 'Дитя',
      links: [{ type: 'CHILD_OF', targetSlug: 'p' }],
    });
    const status = linkCandidateStatus([parent, child], parent, 'CHILD_OF', child);
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/цикл/i);
  });

  it('CHILD_OF: a second parent is unavailable when the source already has one', () => {
    const existingParent = makeReq({
      slug: 'p1',
      name: 'Первый родитель',
      links: [{ type: 'PARENT_OF', targetSlug: 'c' }],
    });
    const child = makeReq({
      slug: 'c',
      name: 'Дитя',
      links: [{ type: 'CHILD_OF', targetSlug: 'p1' }],
    });
    const other = makeReq({ slug: 'p2', name: 'Второй родитель' });
    const status = linkCandidateStatus([existingParent, child, other], child, 'CHILD_OF', other);
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/родител/i);
  });

  it('CHILD_OF: a valid same-type target with no parent is available', () => {
    const a = makeReq({ slug: 'a', name: 'A' });
    const b = makeReq({ slug: 'b', name: 'B' });
    expect(linkCandidateStatus([a, b], a, 'CHILD_OF', b).ok).toBe(true);
  });

  it('RELATES_TO: constraints are softer — a different-type target is available', () => {
    const fn = makeReq({ slug: 'fn', name: 'Функция', type: 'FUNCTION' });
    const nfr = makeReq({ slug: 'nfr', name: 'НФТ', type: 'NFR' });
    expect(linkCandidateStatus([fn, nfr], fn, 'RELATES_TO', nfr).ok).toBe(true);
  });

  it('DEPENDS_ON: a different-type target is allowed but a cycle is still blocked', () => {
    const fn = makeReq({ slug: 'fn', name: 'Функция', type: 'FUNCTION' });
    const nfr = makeReq({ slug: 'nfr', name: 'НФТ', type: 'NFR' });
    expect(linkCandidateStatus([fn, nfr], fn, 'DEPENDS_ON', nfr).ok).toBe(true);

    const a = makeReq({
      slug: 'a',
      name: 'A',
      links: [{ type: 'DEPENDS_ON', targetSlug: 'b' }],
    });
    const b = makeReq({
      slug: 'b',
      name: 'B',
      links: [{ type: 'BLOCKED_BY', targetSlug: 'a' }],
    });
    const status = linkCandidateStatus([a, b], b, 'DEPENDS_ON', a);
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/цикл/i);
  });
});
