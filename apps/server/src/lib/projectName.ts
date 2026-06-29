import { ValidationError } from '@po/core';

/** Reserved characters that are illegal in directory names across macOS/Windows/Linux. */
const ILLEGAL = /[<>:"/\\|?*]/g;
/** ASCII control characters (built via RegExp to avoid embedding raw control bytes in source). */
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f]', 'g');
const MAX_LEN = 200;

/**
 * Sanitize a user-supplied project name into a safe directory name (NFR-5, 2.4.8):
 * strips path separators / reserved / control characters, trims surrounding dots
 * and spaces, and enforces a length bound. The result is used both as the
 * on-disk directory name and as the project id.
 *
 * @throws {ValidationError} when nothing safe remains.
 */
export function sanitizeProjectName(raw: string): string {
  const cleaned = raw
    .normalize('NFC')
    .replace(CONTROL, '')
    .replace(ILLEGAL, '')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, MAX_LEN)
    .trim();

  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    throw new ValidationError(`Invalid project name: "${raw}".`);
  }
  return cleaned;
}
