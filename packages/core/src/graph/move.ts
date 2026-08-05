import type { Requirement } from '../domain/types.js';
import { collectDescendants } from './cascade.js';
import { parentSlugOf } from './tree.js';

/**
 * Why a requirement cannot become a child of a given parent.
 *
 * The tree stores hierarchy as a single CHILD_OF link, so «moving a row» is
 * always one thing: replacing that link. These are the only ways it can fail,
 * and the UI shows the reason *before* the drop rather than as a server error
 * after it — the server enforces the very same rules.
 */
export type MoveBlockReason =
  /** The requirement (or the requested parent) is not in the set. */
  | 'NOT_FOUND'
  /** Dropping a row onto itself. */
  | 'SELF'
  /** The requested parent is a descendant of the row: that would close a cycle. */
  | 'DESCENDANT'
  /** Hierarchy exists inside one type only: an NFR never becomes a child of a FUNCTION. */
  | 'TYPE_MISMATCH'
  /** The row already hangs under that parent — nothing to change. */
  | 'SAME_PARENT';

/** A rejected move, with a message suitable for logs (the UI renders its own text). */
export interface MoveBlock {
  reason: MoveBlockReason;
  message: string;
}

/**
 * What a move actually changes: at most one CHILD_OF link is removed and at
 * most one is created. `newParentSlug === null` means «lift to the root».
 */
export interface MovePlan {
  childSlug: string;
  /** Parent before the move (null when the row was already a root). */
  oldParentSlug: string | null;
  /** Parent after the move (null when the row becomes a root). */
  newParentSlug: string | null;
  /** Transitive descendants that travel with the row (they keep their own links). */
  movedDescendants: string[];
}

/**
 * Check whether `childSlug` may become a child of `newParentSlug`
 * (`null` = move to the root of its type).
 *
 * @returns `null` when the move is allowed, otherwise the reason it is not.
 */
export function checkMove(
  reqs: readonly Requirement[],
  childSlug: string,
  newParentSlug: string | null,
): MoveBlock | null {
  const child = reqs.find((r) => r.slug === childSlug);
  if (!child) {
    return { reason: 'NOT_FOUND', message: `Requirement not found: "${childSlug}".` };
  }

  const currentParent = parentSlugOf(child) ?? null;

  if (newParentSlug === null) {
    if (currentParent === null) {
      return { reason: 'SAME_PARENT', message: `"${childSlug}" is already a root requirement.` };
    }
    return null;
  }

  if (newParentSlug === childSlug) {
    return { reason: 'SELF', message: `A requirement cannot be its own parent ("${childSlug}").` };
  }

  const parent = reqs.find((r) => r.slug === newParentSlug);
  if (!parent) {
    return { reason: 'NOT_FOUND', message: `Requirement not found: "${newParentSlug}".` };
  }

  if (parent.type !== child.type) {
    return {
      reason: 'TYPE_MISMATCH',
      message: `Hierarchy stays inside one type: cannot nest ${child.type} "${childSlug}" under ${parent.type} "${newParentSlug}".`,
    };
  }

  if (currentParent === newParentSlug) {
    return {
      reason: 'SAME_PARENT',
      message: `"${childSlug}" already hangs under "${newParentSlug}".`,
    };
  }

  if (collectDescendants(reqs, childSlug).includes(newParentSlug)) {
    return {
      reason: 'DESCENDANT',
      message: `"${newParentSlug}" is a descendant of "${childSlug}": the move would close a cycle.`,
    };
  }

  return null;
}

/**
 * Describe the move without performing it: the link to drop, the link to add
 * and the subtree that travels along. Callers check {@link checkMove} first;
 * this function assumes the move is legal and only reads the current state.
 */
export function planMove(
  reqs: readonly Requirement[],
  childSlug: string,
  newParentSlug: string | null,
): MovePlan {
  const child = reqs.find((r) => r.slug === childSlug);
  return {
    childSlug,
    oldParentSlug: child ? (parentSlugOf(child) ?? null) : null,
    newParentSlug,
    movedDescendants: collectDescendants(reqs, childSlug),
  };
}
