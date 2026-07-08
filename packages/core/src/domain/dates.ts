/**
 * Strict ISO calendar-date helpers (`yyyy-mm-dd`, no time component). Shared by
 * validation (Zod refinements), the implemented ⟺ target/releaseDate rule, and
 * the scoring `isDateInQuarter` warning (todo_19).
 */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parsed calendar date (1-based month) or `null` for a malformed / impossible date. */
export function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Reject impossible calendar dates (e.g. 2026-13-40, 2026-02-30).
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/** True when `value` is a valid ISO calendar date `yyyy-mm-dd`. */
export function isValidIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}
