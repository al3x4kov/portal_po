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
