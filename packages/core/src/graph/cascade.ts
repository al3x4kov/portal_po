import type { Requirement } from '../domain/types.js';
import { HasChildrenError } from '../domain/errors.js';

/** Slugs of requirements that are direct children (CHILD_OF) of `parentSlug`. */
export function findChildren(reqs: readonly Requirement[], parentSlug: string): string[] {
  return reqs
    .filter(
      (r) =>
        r.slug !== parentSlug &&
        r.links.some((l) => l.type === 'CHILD_OF' && l.targetSlug === parentSlug),
    )
    .map((r) => r.slug);
}

/**
 * Remove `deletedSlug` and strip every back-reference to it (FR-9.2 / §2.4.7),
 * leaving no dangling links.
 *
 * Policy (FR-9.3): deleting a requirement that still has children is rejected.
 *
 * @returns a new requirement array (input is not mutated).
 * @throws {HasChildrenError} when the requirement has child requirements.
 */
export function cascadeUnlink(reqs: readonly Requirement[], deletedSlug: string): Requirement[] {
  const children = findChildren(reqs, deletedSlug);
  if (children.length > 0) {
    throw new HasChildrenError(children);
  }

  return reqs
    .filter((r) => r.slug !== deletedSlug)
    .map((r) => {
      const remaining = r.links.filter((l) => l.targetSlug !== deletedSlug);
      return remaining.length === r.links.length ? r : { ...r, links: remaining };
    });
}

/**
 * Every transitive descendant slug of `rootSlug` following the CHILD_OF/PARENT_OF
 * hierarchy (breadth-first), excluding the root itself. Cycle-safe via a visited
 * set, so a malformed graph never loops.
 */
export function collectDescendants(reqs: readonly Requirement[], rootSlug: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([rootSlug]);
  const queue: string[] = [rootSlug];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of findChildren(reqs, current)) {
      if (!seen.has(child)) {
        seen.add(child);
        out.push(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/**
 * Cascade-delete a whole subtree (UX-2): remove `rootSlug` together with every
 * transitive descendant, and strip every back-reference to any removed node
 * (hierarchical AND non-hierarchical) from the requirements that survive —
 * leaving no dangling `targetSlug`, exactly like {@link cascadeUnlink} does for
 * a single node.
 *
 * Unlike {@link cascadeUnlink}, this never throws {@link HasChildrenError}: the
 * caller has explicitly opted into removing the children.
 *
 * @returns the surviving requirements (`remaining`, input not mutated) and the
 *   slugs that were removed (`removed`, root first). The removed list lets the
 *   caller resolve each file to delete and report the affected count.
 */
export function cascadeUnlinkSubtree(
  reqs: readonly Requirement[],
  rootSlug: string,
): { remaining: Requirement[]; removed: string[] } {
  const removed = [rootSlug, ...collectDescendants(reqs, rootSlug)];
  const removedSet = new Set(removed);

  const remaining = reqs
    .filter((r) => !removedSet.has(r.slug))
    .map((r) => {
      const links = r.links.filter((l) => !removedSet.has(l.targetSlug));
      return links.length === r.links.length ? r : { ...r, links };
    });

  return { remaining, removed };
}
