/**
 * Human-readable, stable requirement identifiers (ADR-001).
 *
 * A slug is a kebab-case string over `[a-z0-9-]`, derived from a requirement's
 * name at creation time and never changed afterwards. It is used as the file
 * name on disk and as the target of links.
 */

/** Canonical slug shape: lowercase alphanumeric groups joined by single dashes. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Cyrillic → Latin transliteration table (lowercase). */
const CYRILLIC: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/** Fallback slug when a name transliterates to nothing (e.g. only punctuation). */
export const FALLBACK_SLUG = 'requirement';

/**
 * Derive a canonical slug from a requirement name (transliterate + kebab-case).
 * The result matches {@link SLUG_RE}; empty results fall back to {@link FALLBACK_SLUG}.
 */
export function toSlug(name: string): string {
  const lower = name.normalize('NFC').toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (Object.prototype.hasOwnProperty.call(CYRILLIC, ch)) {
      out += CYRILLIC[ch];
    } else if (/[a-z0-9]/.test(ch)) {
      out += ch;
    } else {
      out += '-';
    }
  }
  out = out.replace(/-+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  return out.length > 0 ? out : FALLBACK_SLUG;
}

/** True when `value` is a syntactically valid, canonical slug. */
export function isValidSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/**
 * Ensure `slug` is unique against `existing`, appending `-2`, `-3`, … on collision.
 * @returns the first free slug (the input itself when already unique).
 */
export function dedupe(slug: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(slug)) return slug;
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n += 1;
  return `${slug}-${n}`;
}
