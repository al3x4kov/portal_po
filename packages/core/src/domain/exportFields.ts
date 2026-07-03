import { z } from 'zod';

/**
 * Optional requirement fields the user may include or exclude from an export
 * (xlsx / zip / tar.gz). Mandatory data — name, type, criticality, implemented
 * (+target) and the technical createdAt/updatedAt — is always exported and is
 * therefore intentionally absent from this list. Order is significant: it drives
 * the fixed left-to-right column order in the Excel export (Task 2, spec §2).
 */
export const EXPORT_OPTIONAL_FIELDS = ['source', 'description', 'info', 'links'] as const;

/** One selectable optional export field. */
export type ExportOptionalField = (typeof EXPORT_OPTIONAL_FIELDS)[number];

/**
 * Zod schema for the selection carried in a request *body* (e.g.
 * `POST /export/selected`). Strict: an unknown value fails validation (→ 400),
 * unlike the tolerant query parser {@link parseExportFields}.
 */
export const exportFieldsSchema = z.array(z.enum(EXPORT_OPTIONAL_FIELDS));

const KNOWN = new Set<string>(EXPORT_OPTIONAL_FIELDS);

/**
 * Parse the `fields` query parameter into a normalized selection.
 *
 * Contract (Task 2 API):
 * - `undefined` (parameter absent) → **all** optional fields (backwards
 *   compatible / lossless);
 * - `''` (or whitespace only) → `[]` (minimum: no optional fields);
 * - `'links,source'` → `['links', 'source']` (input order preserved);
 * - unknown tokens are silently dropped; duplicates are de-duplicated.
 */
export function parseExportFields(raw?: string): ExportOptionalField[] {
  if (raw === undefined) return [...EXPORT_OPTIONAL_FIELDS];
  const seen = new Set<ExportOptionalField>();
  const out: ExportOptionalField[] = [];
  for (const token of raw.split(',')) {
    const t = token.trim();
    if (KNOWN.has(t) && !seen.has(t as ExportOptionalField)) {
      seen.add(t as ExportOptionalField);
      out.push(t as ExportOptionalField);
    }
  }
  return out;
}
