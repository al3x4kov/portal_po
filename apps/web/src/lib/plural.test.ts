import { describe, it, expect } from 'vitest';
import { plural, nestedLabel, matchesLabel, requirementsLabel } from './plural';

describe('plural (Russian one/few/many)', () => {
  it('picks the "one" form for numbers ending in 1 (but not 11)', () => {
    expect(plural(1, 'один', 'два', 'много')).toBe('один');
    expect(plural(21, 'один', 'два', 'много')).toBe('один');
    expect(plural(101, 'один', 'два', 'много')).toBe('один');
  });

  it('picks the "few" form for numbers ending in 2–4 (but not 12–14)', () => {
    expect(plural(2, 'один', 'два', 'много')).toBe('два');
    expect(plural(3, 'один', 'два', 'много')).toBe('два');
    expect(plural(4, 'один', 'два', 'много')).toBe('два');
    expect(plural(22, 'один', 'два', 'много')).toBe('два');
  });

  it('picks the "many" form for 0, 5–20 and the 11–14 exceptions', () => {
    expect(plural(0, 'один', 'два', 'много')).toBe('много');
    expect(plural(5, 'один', 'два', 'много')).toBe('много');
    expect(plural(11, 'один', 'два', 'много')).toBe('много');
    expect(plural(12, 'один', 'два', 'много')).toBe('много');
    expect(plural(13, 'один', 'два', 'много')).toBe('много');
    expect(plural(14, 'один', 'два', 'много')).toBe('много');
    expect(plural(20, 'один', 'два', 'много')).toBe('много');
    expect(plural(111, 'один', 'два', 'много')).toBe('много');
  });
});

describe('nestedLabel', () => {
  it('formats subitem counts with the right plural form', () => {
    expect(nestedLabel(1)).toBe('1 подпункт');
    expect(nestedLabel(2)).toBe('2 подпункта');
    expect(nestedLabel(5)).toBe('5 подпунктов');
  });
});

describe('matchesLabel', () => {
  it('formats match counts with the right plural form', () => {
    expect(matchesLabel(1)).toBe('1 совпадение');
    expect(matchesLabel(3)).toBe('3 совпадения');
    expect(matchesLabel(11)).toBe('11 совпадений');
  });
});

describe('requirementsLabel', () => {
  it('formats requirement counts with the right plural form', () => {
    expect(requirementsLabel(1)).toBe('1 требование');
    expect(requirementsLabel(2)).toBe('2 требования');
    expect(requirementsLabel(5)).toBe('5 требований');
  });
});
