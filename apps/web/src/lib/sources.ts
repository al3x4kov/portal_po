import type { Requirement } from '@po/core';

/**
 * The source names attached to a requirement, trimmed and in order.
 *
 * todo_19 migrated the scalar `source: string` to `sources: SourceEntry[]`.
 * New requirements carry their sources in `sources[]`; legacy requirements only
 * have the scalar `source`. We read `sources[]` first and fall back to the
 * legacy scalar so both shapes keep working. The @po/core `Requirement` type
 * stays the single source of truth for the data shape.
 */
export function sourceNamesOf(req: Requirement): string[] {
  const fromList = (req.sources ?? []).map((s) => s.name.trim()).filter((n) => n.length > 0);
  if (fromList.length > 0) return fromList;
  const legacy = req.source?.trim();
  return legacy ? [legacy] : [];
}

/** True when a requirement carries no source at all (drives the «Не задан» filter option). */
export function hasNoSource(req: Requirement): boolean {
  return sourceNamesOf(req).length === 0;
}

/**
 * Value of the exported «Источник» column for a requirement: all source names
 * joined with «; », or an empty string when the requirement has no source.
 */
export function formatSourceCell(req: Requirement): string {
  return sourceNamesOf(req).join('; ');
}
