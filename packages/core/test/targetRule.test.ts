import { describe, expect, it } from 'vitest';
import { checkTargetRule } from '../src/index.js';

describe('BE-2 implemented ⟺ target rule', () => {
  it('passes an implemented requirement with no target', () => {
    expect(checkTargetRule({ implemented: true })).toBeNull();
  });

  it('flags an implemented requirement that still carries a target', () => {
    expect(checkTargetRule({ implemented: true, targetQuarter: 'Q1', targetYear: 2030 })).toEqual({
      kind: 'unexpected-target',
    });
    expect(checkTargetRule({ implemented: true, targetYear: 2030 })).toEqual({
      kind: 'unexpected-target',
    });
  });

  it('passes a not-implemented requirement with both target fields', () => {
    expect(
      checkTargetRule({ implemented: false, targetQuarter: 'Q2', targetYear: 2030 }),
    ).toBeNull();
  });

  it('reports missing target fields for a not-implemented requirement', () => {
    expect(checkTargetRule({ implemented: false })).toEqual({
      kind: 'missing-target',
      fields: ['targetQuarter', 'targetYear'],
    });
    expect(checkTargetRule({ implemented: false, targetQuarter: 'Q3' })).toEqual({
      kind: 'missing-target',
      fields: ['targetYear'],
    });
    expect(checkTargetRule({ implemented: false, targetYear: 2030 })).toEqual({
      kind: 'missing-target',
      fields: ['targetQuarter'],
    });
  });
});
