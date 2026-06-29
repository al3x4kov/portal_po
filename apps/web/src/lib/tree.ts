import type { Requirement } from '@po/core';

export interface TreeNode {
  requirement: Requirement;
  children: TreeNode[];
  depth: number;
}

/** Parent id of a requirement, derived from its CHILD_OF link (FR-7). */
export function parentIdOf(req: Requirement): string | undefined {
  return req.links.find((l) => l.type === 'CHILD_OF')?.targetId;
}

/** Number of direct children a requirement has (PARENT_OF links). */
export function childCountOf(req: Requirement): number {
  return req.links.filter((l) => l.type === 'PARENT_OF').length;
}

/**
 * Build a forest from a flat requirement list using CHILD_OF/PARENT_OF links.
 * Roots are requirements with no (in-set) parent. Cycle-safe via a visited set.
 */
export function buildForest(requirements: Requirement[]): TreeNode[] {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const childrenOf = new Map<string, Requirement[]>();
  const roots: Requirement[] = [];

  for (const req of requirements) {
    const parentId = parentIdOf(req);
    if (parentId && byId.has(parentId)) {
      const list = childrenOf.get(parentId) ?? [];
      list.push(req);
      childrenOf.set(parentId, list);
    } else {
      roots.push(req);
    }
  }

  const byName = (a: Requirement, b: Requirement): number => a.name.localeCompare(b.name, 'ru');

  const build = (req: Requirement, depth: number, seen: Set<string>): TreeNode => {
    seen.add(req.id);
    const kids = (childrenOf.get(req.id) ?? [])
      .filter((c) => !seen.has(c.id))
      .sort(byName)
      .map((c) => build(c, depth + 1, seen));
    return { requirement: req, children: kids, depth };
  };

  return roots.sort(byName).map((r) => build(r, 0, new Set()));
}

/** Flatten a forest into rows, honoring the set of expanded node ids. */
export function flattenVisible(forest: TreeNode[], expanded: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode): void => {
    out.push(node);
    if (node.children.length > 0 && expanded.has(node.requirement.id)) {
      node.children.forEach(walk);
    }
  };
  forest.forEach(walk);
  return out;
}
