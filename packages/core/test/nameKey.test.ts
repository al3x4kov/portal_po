import { describe, expect, it } from 'vitest';
import { nameKey, unionRelatedFunctions } from '../src/index.js';

describe('nameKey', () => {
  it('lowercases and trims the name and keeps the type prefix verbatim', () => {
    expect(nameKey('FUNCTION', '  Login  ')).toBe('FUNCTION:login');
    expect(nameKey('NFR', 'Performance')).toBe('NFR:performance');
  });

  it('is case-insensitive on the name so different casings collide', () => {
    expect(nameKey('FUNCTION', 'Login')).toBe(nameKey('FUNCTION', 'LOGIN'));
    expect(nameKey('FUNCTION', 'Login')).toBe(nameKey('FUNCTION', ' login '));
  });

  it('keeps the type verbatim (distinct types never collide)', () => {
    expect(nameKey('FUNCTION', 'x')).not.toBe(nameKey('NFR', 'x'));
  });
});

describe('unionRelatedFunctions', () => {
  it('returns undefined when both inputs are absent or empty', () => {
    expect(unionRelatedFunctions(undefined, undefined)).toBeUndefined();
    expect(unionRelatedFunctions([], [])).toBeUndefined();
    expect(unionRelatedFunctions([], undefined)).toBeUndefined();
  });

  it('returns the single non-empty list when the other is absent', () => {
    expect(unionRelatedFunctions(['A', 'B'], undefined)).toEqual(['A', 'B']);
    expect(unionRelatedFunctions(undefined, ['A'])).toEqual(['A']);
  });

  it('merges deduplicating by case-insensitive name key, first wording wins', () => {
    expect(unionRelatedFunctions(['Login'], ['login', 'Logout'])).toEqual(['Login', 'Logout']);
  });

  it('keeps the first formulation across whitespace/case differences', () => {
    // "Sign In" seen first survives; "  sign in " is a duplicate.
    expect(unionRelatedFunctions(['Sign In'], ['  sign in ', 'Reset'])).toEqual([
      'Sign In',
      'Reset',
    ]);
  });

  it('deduplicates within a single input list too', () => {
    expect(unionRelatedFunctions(['A', 'a', 'B'], undefined)).toEqual(['A', 'B']);
  });

  it('does not mutate its inputs', () => {
    const a = ['A'];
    const b = ['a', 'B'];
    unionRelatedFunctions(a, b);
    expect(a).toEqual(['A']);
    expect(b).toEqual(['a', 'B']);
  });
});
