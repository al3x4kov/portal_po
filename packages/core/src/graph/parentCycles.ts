/**
 * Deterministically break parent cycles in a child→parent map (keys are opaque
 * node identities, e.g. {@link nameKey} results). Chains are walked in map
 * insertion order; when a walk revisits a node already on its own path, the
 * parent edge of the LAST node on the path (the edge closing the cycle) is
 * dropped, making that node a root.
 *
 * Pure: the input map is never mutated; the returned list holds the child keys
 * whose parent edge must be removed, in detection order.
 */
export function breakParentCycles(parentByChild: ReadonlyMap<string, string>): string[] {
  const parents = new Map(parentByChild);
  const removed: string[] = [];
  const safe = new Set<string>(); // nodes proven to terminate
  for (const start of parents.keys()) {
    if (safe.has(start)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur = start;
    for (;;) {
      if (onPath.has(cur)) {
        const closing = path[path.length - 1]!;
        parents.delete(closing);
        removed.push(closing);
        break;
      }
      onPath.add(cur);
      path.push(cur);
      const next = parents.get(cur);
      if (next === undefined || safe.has(next)) break;
      cur = next;
    }
    for (const key of path) safe.add(key);
  }
  return removed;
}
