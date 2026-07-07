import type { Link, LinkType, Requirement, RequirementType } from '../domain/types.js';
import {
  CycleError,
  MultipleParentError,
  SelfLinkError,
  TypeMismatchError,
} from '../domain/errors.js';

/** A link the caller intends to create, before it is persisted on either node. */
export interface ProposedLink {
  sourceSlug: string;
  type: LinkType;
  targetSlug: string;
}

const INVERSE: Record<LinkType, LinkType> = {
  PARENT_OF: 'CHILD_OF',
  CHILD_OF: 'PARENT_OF',
  RELATES_TO: 'RELATES_TO',
  DEPENDS_ON: 'BLOCKED_BY',
  BLOCKED_BY: 'DEPENDS_ON',
};

/** The reciprocal link type stored on the other endpoint. */
export function inverseLinkType(type: LinkType): LinkType {
  return INVERSE[type];
}

/** Hierarchical link types form the requirement tree. */
export function isHierarchyType(type: LinkType): boolean {
  return type === 'PARENT_OF' || type === 'CHILD_OF';
}

/** Dependency link types participate in cycle checks. */
export function isDependencyType(type: LinkType): boolean {
  return type === 'DEPENDS_ON' || type === 'BLOCKED_BY';
}

/**
 * Build the mutually-inverse pair of links for a relationship.
 * Returns the link to store on the source and the link to store on the target.
 * E.g. PARENT_OF on source ⇒ CHILD_OF on target.
 */
export function createLinkPair(
  sourceSlug: string,
  type: LinkType,
  targetSlug: string,
): { source: Link; sourceSlug: string; target: Link; targetSlug: string } {
  return {
    sourceSlug,
    source: { type, targetSlug },
    targetSlug,
    target: { type: INVERSE[type], targetSlug: sourceSlug },
  };
}

/** True when two links are identical (same type + target). */
export function sameLink(a: Link, b: Link): boolean {
  return a.type === b.type && a.targetSlug === b.targetSlug;
}

/** Reject a link from a requirement to itself. */
export function assertNoSelfLink(sourceSlug: string, targetSlug: string): void {
  if (sourceSlug === targetSlug) {
    throw new SelfLinkError(`A requirement cannot be linked to itself (slug=${sourceSlug}).`);
  }
}

/** Hierarchical links are only allowed between requirements of the same type. */
export function assertSameType(a: Requirement, b: Requirement): void {
  if (a.type !== b.type) {
    throw new TypeMismatchError(
      `Hierarchical link requires equal types, got ${a.type} (slug=${a.slug}) and ${b.type} (slug=${b.slug}).`,
    );
  }
}

/**
 * Assert a requirement keeps at most one parent (CHILD_OF).
 * When `newParentSlug` is supplied, the check accounts for the parent about to be added.
 *
 * @throws {MultipleParentError}
 */
export function assertSingleParent(
  reqs: readonly Requirement[],
  childSlug: string,
  newParentSlug?: string,
): void {
  const child = reqs.find((r) => r.slug === childSlug);
  const parents = new Set<string>(
    (child?.links ?? []).filter((l) => l.type === 'CHILD_OF').map((l) => l.targetSlug),
  );
  if (newParentSlug !== undefined) {
    parents.add(newParentSlug);
  }
  if (parents.size > 1) {
    throw new MultipleParentError(
      `Requirement ${childSlug} would have ${parents.size} parents; only one is allowed.`,
    );
  }
}

type Edge = [string, string];

function canonicalEdge(
  sourceSlug: string,
  link: Link,
  family: 'hierarchy' | 'dependency',
): Edge | null {
  if (family === 'hierarchy') {
    if (link.type === 'PARENT_OF') return [sourceSlug, link.targetSlug];
    if (link.type === 'CHILD_OF') return [link.targetSlug, sourceSlug];
    return null;
  }
  if (link.type === 'DEPENDS_ON') return [sourceSlug, link.targetSlug];
  if (link.type === 'BLOCKED_BY') return [link.targetSlug, sourceSlug];
  return null;
}

function findCycle(edges: readonly Edge[]): string[] | null {
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const [from, to] of edges) {
    nodes.add(from);
    nodes.add(to);
    const list = adj.get(from);
    if (list) list.push(to);
    else adj.set(from, [to]);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  let cycle: string[] | null = null;

  const visit = (node: string): boolean => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        const idx = stack.indexOf(next);
        cycle = [...stack.slice(idx), next];
        return true;
      }
      if (c === WHITE && visit(next)) {
        return true;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return false;
  };

  for (const node of nodes) {
    if ((color.get(node) ?? WHITE) === WHITE && visit(node)) {
      return cycle;
    }
  }
  return null;
}

/**
 * Assert that adding `proposed` does not introduce a cycle.
 * Cycle checks apply to hierarchy (PARENT_OF/CHILD_OF) and dependency
 * (DEPENDS_ON/BLOCKED_BY) edges; RELATES_TO is a symmetric association and is skipped.
 *
 * @throws {CycleError} with the offending path (e.g. A -> B -> A).
 */
export function assertNoCycle(reqs: readonly Requirement[], proposed: ProposedLink): void {
  let family: 'hierarchy' | 'dependency';
  if (isHierarchyType(proposed.type)) family = 'hierarchy';
  else if (isDependencyType(proposed.type)) family = 'dependency';
  else return; // RELATES_TO: no ordering, no cycle constraint.

  const edges: Edge[] = [];
  for (const req of reqs) {
    for (const link of req.links) {
      const edge = canonicalEdge(req.slug, link, family);
      if (edge) edges.push(edge);
    }
  }
  const proposedEdge = canonicalEdge(
    proposed.sourceSlug,
    { type: proposed.type, targetSlug: proposed.targetSlug },
    family,
  );
  if (proposedEdge) edges.push(proposedEdge);

  const cycle = findCycle(edges);
  if (cycle) {
    throw new CycleError(cycle);
  }
}

/**
 * Assert that the whole graph (all persisted links) is free of hierarchy and
 * dependency cycles. Unlike {@link assertNoCycle} this validates an existing
 * set rather than a single proposed edge — used when importing an archive.
 *
 * @throws {CycleError} with the offending path.
 */
export function assertAcyclic(reqs: readonly Requirement[]): void {
  for (const family of ['hierarchy', 'dependency'] as const) {
    const edges: Edge[] = [];
    for (const req of reqs) {
      for (const link of req.links) {
        const edge = canonicalEdge(req.slug, link, family);
        if (edge) edges.push(edge);
      }
    }
    const cycle = findCycle(edges);
    if (cycle) {
      throw new CycleError(cycle);
    }
  }
}

/** Discriminator for a single import-time graph-integrity breach (SA-3). */
export type ImportIntegrityViolationKind =
  'SELF_LINK' | 'DANGLING_TARGET' | 'MISSING_INVERSE' | 'MULTIPLE_PARENT' | 'CYCLE';

/**
 * One concrete way the imported link graph violates the 2.4 invariants.
 * Structured (not just a string) so callers can surface a machine-readable
 * `details` list (SA-3) and the same data drives the human-readable `message`.
 */
export interface ImportIntegrityViolation {
  kind: ImportIntegrityViolationKind;
  /** Human-readable, self-contained description (used verbatim in `details`). */
  message: string;
  /** Requirement the breach originates from (absent for graph-wide cycles). */
  slug?: string;
  /** The offending link target (for SELF_LINK / DANGLING_TARGET / MISSING_INVERSE). */
  targetSlug?: string;
  /** The offending path A -> B -> A (for CYCLE). */
  path?: string[];
}

const linkKey = (type: RequirementType, slug: string): string => `${type}:${slug}`;

/**
 * Collect EVERY graph-integrity breach in a set of parsed requirements without
 * failing fast (SA-3). Reuses the interactive-editing rules so an archive can
 * never smuggle in a graph the product forbids creating by hand
 * (2.4.3/2.4.4/2.4.7): self-links, links into nowhere, missing inverses,
 * multiple parents and hierarchy/dependency cycles. Returns [] for a clean
 * graph; the import path rejects when the list is non-empty.
 */
export function collectImportIntegrityViolations(
  reqs: readonly Requirement[],
): ImportIntegrityViolation[] {
  const violations: ImportIntegrityViolation[] = [];

  // Index by type:slug for hierarchy resolution; associations fall back to a
  // cross-type slug lookup (mirrors the import resolver exactly).
  const bySlug = new Map<string, Requirement>();
  for (const req of reqs) bySlug.set(linkKey(req.type, req.slug), req);

  for (const req of reqs) {
    for (const linkRef of req.links) {
      const other =
        bySlug.get(linkKey(req.type, linkRef.targetSlug)) ??
        reqs.find((r) => r.slug === linkRef.targetSlug && r !== req);

      if (other === req) {
        violations.push({
          kind: 'SELF_LINK',
          slug: req.slug,
          targetSlug: linkRef.targetSlug,
          message: `Self-link: "${req.slug}" links to itself (${linkRef.type}).`,
        });
        continue;
      }
      if (!other) {
        violations.push({
          kind: 'DANGLING_TARGET',
          slug: req.slug,
          targetSlug: linkRef.targetSlug,
          message: `Dangling link: "${req.slug}" (${linkRef.type}) references missing "${linkRef.targetSlug}".`,
        });
        continue;
      }
      const inverse = inverseLinkType(linkRef.type);
      const reciprocated = other.links.some((l) => l.type === inverse && l.targetSlug === req.slug);
      if (!reciprocated) {
        violations.push({
          kind: 'MISSING_INVERSE',
          slug: req.slug,
          targetSlug: linkRef.targetSlug,
          message: `Link from "${req.slug}" to "${linkRef.targetSlug}" (${linkRef.type}) is missing its inverse on the target.`,
        });
      }
    }

    // At most one parent per requirement, scoped to its own type.
    try {
      assertSingleParent(
        reqs.filter((r) => r.type === req.type),
        req.slug,
      );
    } catch (err) {
      if (err instanceof MultipleParentError) {
        violations.push({ kind: 'MULTIPLE_PARENT', slug: req.slug, message: err.message });
      } else {
        throw err;
      }
    }
  }

  // Hierarchy/dependency cycles across the whole graph.
  try {
    assertAcyclic(reqs);
  } catch (err) {
    if (err instanceof CycleError) {
      violations.push({ kind: 'CYCLE', path: err.path, message: err.message });
    } else {
      throw err;
    }
  }

  return violations;
}
