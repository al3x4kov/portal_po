import { describe, expect, it } from 'vitest';
import { UniquenessError, assertUniqueName } from '../src/index.js';
import { makeReq } from './fixtures.js';

describe('T-204 assertUniqueName', () => {
  const fn = makeReq({ type: 'FUNCTION', name: 'Login' });
  const nfr = makeReq({ type: 'NFR', name: 'Latency' });
  const reqs = [fn, nfr];

  it('accepts a genuinely new name', () => {
    expect(() => assertUniqueName(reqs, { type: 'FUNCTION', name: 'Logout' })).not.toThrow();
  });

  it('rejects an exact duplicate within the same type', () => {
    expect(() => assertUniqueName(reqs, { type: 'FUNCTION', name: 'Login' })).toThrow(
      UniquenessError,
    );
  });

  it('rejects a case-insensitive duplicate', () => {
    expect(() => assertUniqueName(reqs, { type: 'FUNCTION', name: 'LOGIN' })).toThrow(
      UniquenessError,
    );
  });

  it('rejects a duplicate that differs only by surrounding whitespace', () => {
    expect(() => assertUniqueName(reqs, { type: 'FUNCTION', name: '  login  ' })).toThrow(
      UniquenessError,
    );
  });

  it('allows the same name under a different type', () => {
    expect(() => assertUniqueName(reqs, { type: 'NFR', name: 'Login' })).not.toThrow();
  });

  it('allows self-rename to the same name (own id excluded)', () => {
    expect(() =>
      assertUniqueName(reqs, { slug: fn.slug, type: 'FUNCTION', name: 'login' }),
    ).not.toThrow();
  });

  it('still rejects renaming onto a different requirement of same type', () => {
    const other = makeReq({ type: 'FUNCTION', name: 'Register' });
    const all = [...reqs, other];
    expect(() =>
      assertUniqueName(all, { slug: other.slug, type: 'FUNCTION', name: 'Login' }),
    ).toThrow(UniquenessError);
  });
});
