import type { Requirement } from '../domain/types.js';

/**
 * Presentation helpers for a requirement's source(s), shared between the server
 * Excel export and (conceptually) the web UI so the two "mirror" renderings stay
 * in sync (BE-3).
 *
 * todo_19 migrated the scalar `source: string` to `sources: SourceEntry[]`.
 * New requirements carry their sources in `sources[]`; legacy requirements only
 * have the scalar `source`. We read `sources[]` first and fall back to the
 * legacy scalar so both shapes keep working.
 */

/** The source names attached to a requirement, trimmed, non-empty, in order. */
export function sourceNamesOf(req: Requirement): string[] {
  const fromList = (req.sources ?? []).map((s) => s.name.trim()).filter((n) => n.length > 0);
  if (fromList.length > 0) return fromList;
  const legacy = req.source?.trim();
  return legacy ? [legacy] : [];
}

/**
 * Value of the exported «Источник» column: all source names joined with «; »,
 * or an empty string when the requirement has no source at all.
 */
export function formatSourceCell(req: Requirement): string {
  return sourceNamesOf(req).join('; ');
}
