import { describe, it, expect } from 'vitest';
import { contentDisposition } from './contentDisposition.js';

describe('contentDisposition', () => {
  it('passes ASCII filenames through unchanged in the fallback token', () => {
    const v = contentDisposition('my-project.zip');
    expect(v).toBe(`attachment; filename="my-project.zip"; filename*=UTF-8''my-project.zip`);
  });

  it('produces an ASCII-only header value for Cyrillic names (no ERR_INVALID_CHAR)', () => {
    const v = contentDisposition('Интернет-магазин.zip');
    // The whole header value must be representable as latin1/ASCII bytes.
    expect(/^[\x20-\x7e]*$/.test(v)).toBe(true);
    // Legacy token: non-ASCII chars replaced with underscores, ASCII kept (- and .zip).
    expect(v).toContain('filename="________-_______.zip"');
    // RFC 5987 token: percent-encoded UTF-8, recoverable to the original.
    const star = v.match(/filename\*=UTF-8''(.+)$/)?.[1];
    expect(star).toBeTruthy();
    expect(decodeURIComponent(star as string)).toBe('Интернет-магазин.zip');
  });

  it('escapes quotes and backslashes in the ASCII fallback', () => {
    const v = contentDisposition('a"b\\c.zip');
    expect(v).toContain('filename="a_b_c.zip"');
  });

  it('percent-encodes RFC 5987 special chars left literal by encodeURIComponent', () => {
    const star = contentDisposition("a'(b)*.zip").match(/filename\*=UTF-8''(.+)$/)?.[1];
    expect(star).toBe('a%27%28b%29%2A.zip');
  });
});
