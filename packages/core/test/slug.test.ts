import { describe, expect, it } from 'vitest';
import { FALLBACK_SLUG, dedupe, isValidSlug, toSlug } from '../src/index.js';

describe('T-801 toSlug (S7, S21)', () => {
  it('transliterates Cyrillic and kebab-cases (ADR example)', () => {
    expect(toSlug('Авторизация по SSO')).toBe('avtorizaciya-po-sso');
  });

  it('lowercases and joins Latin words with dashes', () => {
    expect(toSlug('User Registration')).toBe('user-registration');
  });

  it('produces only [a-z0-9-] and collapses separators', () => {
    const slug = toSlug('  Hello,   World!!!  #42  ');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug).toBe('hello-world-42');
  });

  it('is stable (idempotent) for an already-slug input', () => {
    expect(toSlug('user-registration')).toBe('user-registration');
  });

  it('strips path separators and traversal (S21 defence at the source)', () => {
    expect(toSlug('../etc/passwd')).not.toContain('/');
    expect(toSlug('../etc/passwd')).not.toContain('.');
    expect(isValidSlug(toSlug('../etc/passwd'))).toBe(true);
  });

  it('falls back for names that transliterate to nothing', () => {
    expect(toSlug('...')).toBe(FALLBACK_SLUG);
    expect(toSlug('   ')).toBe(FALLBACK_SLUG);
  });
});

describe('T-801 isValidSlug', () => {
  it('accepts canonical slugs', () => {
    expect(isValidSlug('login')).toBe(true);
    expect(isValidSlug('user-registration-2')).toBe(true);
  });

  it('rejects uppercase, spaces, separators and traversal', () => {
    expect(isValidSlug('Login')).toBe(false);
    expect(isValidSlug('a b')).toBe(false);
    expect(isValidSlug('../evil')).toBe(false);
    expect(isValidSlug('a/b')).toBe(false);
    expect(isValidSlug('-lead')).toBe(false);
    expect(isValidSlug('trail-')).toBe(false);
    expect(isValidSlug('')).toBe(false);
  });
});

describe('T-801 dedupe (S7)', () => {
  it('returns the slug unchanged when free', () => {
    expect(dedupe('login', [])).toBe('login');
    expect(dedupe('login', ['other'])).toBe('login');
  });

  it('appends -2 for the first collision', () => {
    expect(dedupe('login', ['login'])).toBe('login-2');
  });

  it('increments the suffix past existing dedup slugs', () => {
    expect(dedupe('login', ['login', 'login-2'])).toBe('login-3');
    expect(dedupe('login', ['login', 'login-2', 'login-3'])).toBe('login-4');
  });
});
