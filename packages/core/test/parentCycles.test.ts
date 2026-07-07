import { describe, expect, it } from 'vitest';
import { breakParentCycles } from '../src/index.js';

describe('breakParentCycles', () => {
  it('returns an empty list for an acyclic forest', () => {
    const parents = new Map([
      ['FUNCTION:b', 'FUNCTION:a'],
      ['FUNCTION:c', 'FUNCTION:b'],
    ]);
    expect(breakParentCycles(parents)).toEqual([]);
  });

  it('breaks a two-node cycle by dropping the edge that closes it', () => {
    // a → b → a : walking from "a" closes on "b".
    const parents = new Map([
      ['FUNCTION:а', 'FUNCTION:б'],
      ['FUNCTION:б', 'FUNCTION:а'],
    ]);
    expect(breakParentCycles(parents)).toEqual(['FUNCTION:б']);
  });

  it('breaks a longer cycle at the closing edge', () => {
    const parents = new Map([
      ['FUNCTION:a', 'FUNCTION:b'],
      ['FUNCTION:b', 'FUNCTION:c'],
      ['FUNCTION:c', 'FUNCTION:a'],
    ]);
    expect(breakParentCycles(parents)).toEqual(['FUNCTION:c']);
  });

  it('breaks a self-parent edge', () => {
    expect(breakParentCycles(new Map([['NFR:x', 'NFR:x']]))).toEqual(['NFR:x']);
  });

  it('breaks multiple independent cycles in detection (insertion) order', () => {
    const parents = new Map([
      ['FUNCTION:а', 'FUNCTION:б'],
      ['FUNCTION:б', 'FUNCTION:а'],
      ['NFR:x', 'NFR:y'],
      ['NFR:y', 'NFR:x'],
    ]);
    expect(breakParentCycles(parents)).toEqual(['FUNCTION:б', 'NFR:y']);
  });

  it('does not mutate the input map', () => {
    const parents = new Map([
      ['FUNCTION:а', 'FUNCTION:б'],
      ['FUNCTION:б', 'FUNCTION:а'],
    ]);
    const snapshot = new Map(parents);
    breakParentCycles(parents);
    expect(parents).toEqual(snapshot);
  });

  it('leaves chains that merge into a shared safe subtree untouched', () => {
    const parents = new Map([
      ['FUNCTION:c', 'FUNCTION:a'],
      ['FUNCTION:d', 'FUNCTION:a'],
      ['FUNCTION:a', 'FUNCTION:root'],
    ]);
    expect(breakParentCycles(parents)).toEqual([]);
  });
});
