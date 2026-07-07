/**
 * Case-insensitive, trimmed identity of a requirement name within its type.
 * Used across the AI-import pipeline to compare / deduplicate requirements by
 * `(type, name)` regardless of surrounding whitespace or letter case.
 */
export function nameKey(type: string, name: string): string {
  return `${type}:${name.trim().toLowerCase()}`;
}

/**
 * Union two `relatedFunctions` lists, deduplicated by the case-insensitive
 * FUNCTION name key. The FIRST encountered formulation of a name wins (per
 * spec: duplicates of one NFR merge their related functions while keeping the
 * first-seen wording). Returns `undefined` when both inputs are empty/absent so
 * the field stays optional.
 */
export function unionRelatedFunctions(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): string[] | undefined {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const name of [...(a ?? []), ...(b ?? [])]) {
    const key = nameKey('FUNCTION', name);
    if (seen.has(key)) continue;
    seen.add(key);
    union.push(name);
  }
  return union.length > 0 ? union : undefined;
}
