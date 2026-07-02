import type { Requirement } from '../domain/types.js';

/** A requirement together with its resolved children and hierarchy depth. */
export interface TreeNode {
  requirement: Requirement;
  children: TreeNode[];
  depth: number;
}

/** A requirement paired with its hierarchy depth (0 = root), in DFS order. */
export interface OrderedNode {
  requirement: Requirement;
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

/** Canonical sibling ordering (by name, Russian collation) shared by UI + export. */
const byName = (a: Requirement, b: Requirement): number => a.name.localeCompare(b.name, 'ru');

/** Group requirements by their in-set parent slug; requirements without an
 *  in-set parent are returned as roots. */
function partition(requirements: readonly Requirement[]): {
  childrenOf: Map<string, Requirement[]>;
  roots: Requirement[];
} {
  const bySlug = new Map(requirements.map((r) => [r.slug, r]));
  const childrenOf = new Map<string, Requirement[]>();
  const roots: Requirement[] = [];

  for (const req of requirements) {
    const parentSlug = parentSlugOf(req);
    if (parentSlug !== undefined && bySlug.has(parentSlug)) {
      const list = childrenOf.get(parentSlug) ?? [];
      list.push(req);
      childrenOf.set(parentSlug, list);
    } else {
      roots.push(req);
    }
  }
  return { childrenOf, roots };
}

/**
 * Build a forest from a flat requirement list using CHILD_OF/PARENT_OF links.
 * Roots are requirements with no in-set parent, siblings are sorted by name.
 * Cycle-safe via a per-branch visited set.
 */
export function buildForest(requirements: readonly Requirement[]): TreeNode[] {
  const { childrenOf, roots } = partition(requirements);

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
 * Order a set of requirements as a depth-first tree walk (BE-4). This is the
 * flattened, fully-expanded equivalent of {@link buildForest}, so a UI table
 * (buildForest + expand) and the Excel export share one ordering.
 *
 * Cycle-safe: a shared `seen` set guarantees every requirement is emitted at
 * most once, and any node unreachable from a root (e.g. trapped in a cycle) is
 * appended at depth 0 so the row count always equals the input size.
 */
export function orderTree(reqs: readonly Requirement[]): OrderedNode[] {
  const { childrenOf, roots } = partition(reqs);
  const out: OrderedNode[] = [];
  const seen = new Set<string>();

  const walk = (req: Requirement, depth: number): void => {
    if (seen.has(req.slug)) return;
    seen.add(req.slug);
    out.push({ requirement: req, depth });
    [...(childrenOf.get(req.slug) ?? [])].sort(byName).forEach((c) => walk(c, depth + 1));
  };

  [...roots].sort(byName).forEach((r) => walk(r, 0));
  // Defensive: emit any requirement not reached via a root (cycle guard).
  [...reqs].sort(byName).forEach((r) => walk(r, 0));
  return out;
}

/**
 * Ancestor names (root → parent) of a requirement, following CHILD_OF links.
 * Used for the description breadcrumb. Cycle-safe.
 */
export function ancestorNamesOf(req: Requirement, requirements: readonly Requirement[]): string[] {
  const bySlug = new Map(requirements.map((r) => [r.slug, r]));
  const names: string[] = [];
  const seen = new Set<string>([req.slug]);
  let parentSlug = parentSlugOf(req);
  while (parentSlug !== undefined && bySlug.has(parentSlug) && !seen.has(parentSlug)) {
    seen.add(parentSlug);
    const parent = bySlug.get(parentSlug) as Requirement;
    names.unshift(parent.name);
    parentSlug = parentSlugOf(parent);
  }
  return names;
}
