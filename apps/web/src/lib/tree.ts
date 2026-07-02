import type { Requirement } from '@po/core';

export interface TreeNode {
  requirement: Requirement;
  children: TreeNode[];
  depth: number;
}

/** Parent slug of a requirement, derived from its CHILD_OF link (FR-7). */
export function parentSlugOf(req: Requirement): string | undefined {
  return req.links.find((l) => l.type === 'CHILD_OF')?.targetSlug;
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
  const bySlug = new Map(requirements.map((r) => [r.slug, r]));
  const childrenOf = new Map<string, Requirement[]>();
  const roots: Requirement[] = [];

  for (const req of requirements) {
    const parentSlug = parentSlugOf(req);
    if (parentSlug && bySlug.has(parentSlug)) {
      const list = childrenOf.get(parentSlug) ?? [];
      list.push(req);
      childrenOf.set(parentSlug, list);
    } else {
      roots.push(req);
    }
  }

  const byName = (a: Requirement, b: Requirement): number => a.name.localeCompare(b.name, 'ru');

  const build = (req: Requirement, depth: number, seen: Set<string>): TreeNode => {
    seen.add(req.slug);
    const kids = (childrenOf.get(req.slug) ?? [])
      .filter((c) => !seen.has(c.slug))
      .sort(byName)
      .map((c) => build(c, depth + 1, seen));
    return { requirement: req, children: kids, depth };
  };

  return roots.sort(byName).map((r) => build(r, 0, new Set()));
}

/**
 * Ancestor names (root → parent) of a requirement, following CHILD_OF links.
 * Used for the description drawer breadcrumb. Cycle-safe.
 */
export function ancestorNamesOf(req: Requirement, requirements: Requirement[]): string[] {
  const bySlug = new Map(requirements.map((r) => [r.slug, r]));
  const names: string[] = [];
  const seen = new Set<string>([req.slug]);
  let parentSlug = parentSlugOf(req);
  while (parentSlug && bySlug.has(parentSlug) && !seen.has(parentSlug)) {
    seen.add(parentSlug);
    const parent = bySlug.get(parentSlug) as Requirement;
    names.unshift(parent.name);
    parentSlug = parentSlugOf(parent);
  }
  return names;
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
