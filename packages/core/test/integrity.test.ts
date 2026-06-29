import { describe, expect, it } from 'vitest';
import {
  CycleError,
  MultipleParentError,
  SelfLinkError,
  TypeMismatchError,
  assertNoCycle,
  assertNoSelfLink,
  assertSameType,
  assertSingleParent,
  createLinkPair,
  inverseLinkType,
} from '../src/index.js';
import { link, makeReq } from './fixtures.js';

describe('T-205 createLinkPair / inverseLinkType', () => {
  it('maps PARENT_OF to a reciprocal CHILD_OF pair', () => {
    const pair = createLinkPair('A', 'PARENT_OF', 'B');
    expect(pair.source).toEqual({ type: 'PARENT_OF', targetId: 'B' });
    expect(pair.target).toEqual({ type: 'CHILD_OF', targetId: 'A' });
  });

  it('maps DEPENDS_ON to BLOCKED_BY and back', () => {
    expect(inverseLinkType('DEPENDS_ON')).toBe('BLOCKED_BY');
    expect(inverseLinkType('BLOCKED_BY')).toBe('DEPENDS_ON');
    expect(inverseLinkType('PARENT_OF')).toBe('CHILD_OF');
    expect(inverseLinkType('CHILD_OF')).toBe('PARENT_OF');
    expect(inverseLinkType('RELATES_TO')).toBe('RELATES_TO');
  });
});

describe('T-205 assertNoSelfLink', () => {
  it('rejects a self link', () => {
    expect(() => assertNoSelfLink('A', 'A')).toThrow(SelfLinkError);
  });
  it('allows linking two distinct requirements', () => {
    expect(() => assertNoSelfLink('A', 'B')).not.toThrow();
  });
});

describe('T-205 assertSameType', () => {
  it('allows FUNCTION ↔ FUNCTION', () => {
    expect(() =>
      assertSameType(makeReq({ type: 'FUNCTION' }), makeReq({ type: 'FUNCTION' })),
    ).not.toThrow();
  });
  it('allows NFR ↔ NFR', () => {
    expect(() => assertSameType(makeReq({ type: 'NFR' }), makeReq({ type: 'NFR' }))).not.toThrow();
  });
  it('rejects FUNCTION ↔ NFR', () => {
    expect(() => assertSameType(makeReq({ type: 'FUNCTION' }), makeReq({ type: 'NFR' }))).toThrow(
      TypeMismatchError,
    );
  });
});

describe('T-205 assertSingleParent', () => {
  it('allows adding a first parent', () => {
    const child = makeReq({ id: 'C', links: [] });
    expect(() => assertSingleParent([child], 'C', 'P1')).not.toThrow();
  });

  it('rejects adding a second, different parent', () => {
    const child = makeReq({ id: 'C', links: [link('CHILD_OF', 'P1')] });
    expect(() => assertSingleParent([child], 'C', 'P2')).toThrow(MultipleParentError);
  });

  it('allows re-adding the same parent (idempotent)', () => {
    const child = makeReq({ id: 'C', links: [link('CHILD_OF', 'P1')] });
    expect(() => assertSingleParent([child], 'C', 'P1')).not.toThrow();
  });

  it('rejects a requirement that already has two parents', () => {
    const child = makeReq({ id: 'C', links: [link('CHILD_OF', 'P1'), link('CHILD_OF', 'P2')] });
    expect(() => assertSingleParent([child], 'C')).toThrow(MultipleParentError);
  });
});

describe('T-205 assertNoCycle', () => {
  it('rejects a hierarchy cycle and reports the path', () => {
    const a = makeReq({ id: 'A', links: [link('PARENT_OF', 'B')] });
    const b = makeReq({ id: 'B', links: [link('PARENT_OF', 'C')] });
    const c = makeReq({ id: 'C', links: [] });
    let captured: CycleError | undefined;
    try {
      assertNoCycle([a, b, c], { sourceId: 'C', type: 'PARENT_OF', targetId: 'A' });
    } catch (err) {
      captured = err as CycleError;
    }
    expect(captured).toBeInstanceOf(CycleError);
    expect(captured?.path).toContain('A');
    expect(captured?.path).toContain('B');
    expect(captured?.path).toContain('C');
    // path is a closed loop: first === last
    expect(captured?.path.at(0)).toBe(captured?.path.at(-1));
  });

  it('detects a cycle expressed via CHILD_OF too', () => {
    const a = makeReq({ id: 'A', links: [link('PARENT_OF', 'B')] });
    const b = makeReq({ id: 'B', links: [] });
    // Adding A CHILD_OF B closes A->B->A.
    expect(() => assertNoCycle([a, b], { sourceId: 'A', type: 'CHILD_OF', targetId: 'B' })).toThrow(
      CycleError,
    );
  });

  it('allows an acyclic hierarchy addition', () => {
    const a = makeReq({ id: 'A', links: [link('PARENT_OF', 'B')] });
    const b = makeReq({ id: 'B', links: [] });
    const c = makeReq({ id: 'C', links: [] });
    expect(() =>
      assertNoCycle([a, b, c], { sourceId: 'B', type: 'PARENT_OF', targetId: 'C' }),
    ).not.toThrow();
  });

  it('rejects a DEPENDS_ON cycle', () => {
    const a = makeReq({ id: 'A', links: [link('DEPENDS_ON', 'B')] });
    const b = makeReq({ id: 'B', links: [] });
    expect(() =>
      assertNoCycle([a, b], { sourceId: 'B', type: 'DEPENDS_ON', targetId: 'A' }),
    ).toThrow(CycleError);
  });

  it('ignores RELATES_TO (symmetric, no cycle constraint)', () => {
    const a = makeReq({ id: 'A', links: [link('RELATES_TO', 'B')] });
    const b = makeReq({ id: 'B', links: [link('RELATES_TO', 'A')] });
    expect(() =>
      assertNoCycle([a, b], { sourceId: 'B', type: 'RELATES_TO', targetId: 'A' }),
    ).not.toThrow();
  });
});
