import {
  assertNoCycle,
  assertSameType,
  assertSingleParent,
  isHierarchyType,
  CycleError,
  MultipleParentError,
  SelfLinkError,
  TypeMismatchError,
  type LinkType,
  type Requirement,
} from '@po/core';

/**
 * Whether a proposed link (source → type → target) is allowed on the client,
 * with a human-readable reason when it is not (UX-4).
 *
 * The rules are NOT re-implemented here: we reuse the very same integrity
 * predicates the server enforces ({@link isHierarchyType}, {@link assertSameType},
 * {@link assertSingleParent}, {@link assertNoCycle}) and translate the typed
 * domain errors they throw into short Russian reasons. The server remains the
 * last line of defence; this only spares the user from picking an invalid target.
 */
export interface CandidateStatus {
  ok: boolean;
  /** Why the target is unavailable (shown next to a disabled candidate). */
  reason?: string;
}

export function linkCandidateStatus(
  reqs: readonly Requirement[],
  source: Requirement,
  type: LinkType,
  target: Requirement,
): CandidateStatus {
  if (source.slug === target.slug) return { ok: false, reason: 'это же требование' };
  try {
    if (isHierarchyType(type)) {
      // Hierarchy only between requirements of the same kind (ФТ↔ФТ, НФТ↔НФТ).
      assertSameType(source, target);
      // At most one parent — direction decides who is the child.
      if (type === 'CHILD_OF') {
        // source becomes a child of target.
        assertSingleParent(reqs, source.slug, target.slug);
      } else {
        // PARENT_OF: target becomes a child of source.
        assertSingleParent(reqs, target.slug, source.slug);
      }
    }
    // Hierarchy + dependency edges must stay acyclic (RELATES_TO is skipped inside).
    assertNoCycle(reqs, { sourceSlug: source.slug, type, targetSlug: target.slug });
    return { ok: true };
  } catch (err) {
    if (err instanceof TypeMismatchError) return { ok: false, reason: 'другой тип требования' };
    if (err instanceof MultipleParentError) {
      return {
        ok: false,
        reason: type === 'CHILD_OF' ? 'у требования уже есть родитель' : 'у цели уже есть родитель',
      };
    }
    if (err instanceof CycleError) return { ok: false, reason: 'создаст цикл' };
    if (err instanceof SelfLinkError) return { ok: false, reason: 'это же требование' };
    return { ok: false, reason: 'недоступно' };
  }
}
