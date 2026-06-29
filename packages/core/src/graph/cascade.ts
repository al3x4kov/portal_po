import type { Requirement } from '../domain/types.js';
import { HasChildrenError } from '../domain/errors.js';

/** Ids of requirements that are direct children (CHILD_OF) of `parentId`. */
export function findChildren(reqs: readonly Requirement[], parentId: string): string[] {
  return reqs
    .filter(
      (r) =>
        r.id !== parentId && r.links.some((l) => l.type === 'CHILD_OF' && l.targetId === parentId),
    )
    .map((r) => r.id);
}

/**
 * Remove `deletedId` and strip every back-reference to it (FR-9.2 / §2.4.7),
 * leaving no dangling links.
 *
 * Policy (FR-9.3): deleting a requirement that still has children is rejected.
 *
 * @returns a new requirement array (input is not mutated).
 * @throws {HasChildrenError} when the requirement has child requirements.
 */
export function cascadeUnlink(reqs: readonly Requirement[], deletedId: string): Requirement[] {
  const children = findChildren(reqs, deletedId);
  if (children.length > 0) {
    throw new HasChildrenError(children);
  }

  return reqs
    .filter((r) => r.id !== deletedId)
    .map((r) => {
      const remaining = r.links.filter((l) => l.targetId !== deletedId);
      return remaining.length === r.links.length ? r : { ...r, links: remaining };
    });
}
