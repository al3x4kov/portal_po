// Tree traversal/sorting lives in core (BE-4) so the UI table and the Excel
// export share one ordering. This module re-exports the shared pieces and adds
// the UI-only `flattenVisible` (honors the expanded-node set).
export { ancestorNamesOf, buildForest, childCountOf, parentSlugOf, type TreeNode } from '@po/core';
import type { TreeNode } from '@po/core';

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
