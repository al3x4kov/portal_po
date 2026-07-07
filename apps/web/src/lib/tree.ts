// Tree traversal/sorting lives in core (BE-4) so the UI table and the Excel
// export share one ordering. This module re-exports the shared pieces and adds
// the UI-only `flattenVisible` (honors the expanded-node set).
export { ancestorNamesOf, buildForest, childCountOf, parentSlugOf, type TreeNode } from '@po/core';
import type { Requirement, TreeNode } from '@po/core';

/**
 * UX-2: number of ALL transitive descendants of a requirement (children,
 * grandchildren, …), derived from PARENT_OF links. Excludes the node itself.
 * Cycle-safe via a visited set. Used to size the reinforced cascade-delete
 * confirmation — the actual number removed comes back from the server as
 * `deleted`. Counting here (rather than trusting a server counter) keeps the
 * confirm dialog honest even before the request fires.
 */
export function descendantCountOf(req: Requirement, requirements: readonly Requirement[]): number {
  const bySlug = new Map(requirements.map((r) => [r.slug, r]));
  const seen = new Set<string>([req.slug]);
  const stack: string[] = [req.slug];
  let count = 0;
  while (stack.length > 0) {
    const current = bySlug.get(stack.pop() as string);
    if (!current) continue;
    for (const link of current.links) {
      if (link.type !== 'PARENT_OF' || seen.has(link.targetSlug)) continue;
      seen.add(link.targetSlug);
      count += 1;
      stack.push(link.targetSlug);
    }
  }
  return count;
}

/** Flatten a forest into rows, honoring the set of expanded node slugs. */
export function flattenVisible(forest: TreeNode[], expanded: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode): void => {
    out.push(node);
    if (node.children.length > 0 && expanded.has(node.requirement.slug)) {
      node.children.forEach(walk);
    }
  };
  forest.forEach(walk);
  return out;
}
