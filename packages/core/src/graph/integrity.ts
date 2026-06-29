import type { Link, LinkType, Requirement } from '../domain/types.js';
import {
  CycleError,
  MultipleParentError,
  SelfLinkError,
  TypeMismatchError,
} from '../domain/errors.js';

/** A link the caller intends to create, before it is persisted on either node. */
export interface ProposedLink {
  sourceId: string;
  type: LinkType;
  targetId: string;
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
  sourceId: string,
  type: LinkType,
  targetId: string,
): { source: Link; sourceId: string; target: Link; targetId: string } {
  return {
    sourceId,
    source: { type, targetId },
    targetId,
    target: { type: INVERSE[type], targetId: sourceId },
  };
}

/** Reject a link from a requirement to itself. */
export function assertNoSelfLink(sourceId: string, targetId: string): void {
  if (sourceId === targetId) {
    throw new SelfLinkError(`A requirement cannot be linked to itself (id=${sourceId}).`);
  }
}

/** Hierarchical links are only allowed between requirements of the same type. */
export function assertSameType(a: Requirement, b: Requirement): void {
  if (a.type !== b.type) {
    throw new TypeMismatchError(
      `Hierarchical link requires equal types, got ${a.type} (id=${a.id}) and ${b.type} (id=${b.id}).`,
    );
  }
}

/**
 * Assert a requirement keeps at most one parent (CHILD_OF).
 * When `newParentId` is supplied, the check accounts for the parent about to be added.
 *
 * @throws {MultipleParentError}
 */
export function assertSingleParent(
  reqs: readonly Requirement[],
  childId: string,
  newParentId?: string,
): void {
  const child = reqs.find((r) => r.id === childId);
  const parents = new Set<string>(
    (child?.links ?? []).filter((l) => l.type === 'CHILD_OF').map((l) => l.targetId),
  );
  if (newParentId !== undefined) {
    parents.add(newParentId);
  }
  if (parents.size > 1) {
    throw new MultipleParentError(
      `Requirement ${childId} would have ${parents.size} parents; only one is allowed.`,
    );
  }
}

type Edge = [string, string];

function canonicalEdge(
  sourceId: string,
  link: Link,
  family: 'hierarchy' | 'dependency',
): Edge | null {
  if (family === 'hierarchy') {
    if (link.type === 'PARENT_OF') return [sourceId, link.targetId];
    if (link.type === 'CHILD_OF') return [link.targetId, sourceId];
    return null;
  }
  if (link.type === 'DEPENDS_ON') return [sourceId, link.targetId];
  if (link.type === 'BLOCKED_BY') return [link.targetId, sourceId];
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
      const edge = canonicalEdge(req.id, link, family);
      if (edge) edges.push(edge);
    }
  }
  const proposedEdge = canonicalEdge(
    proposed.sourceId,
    { type: proposed.type, targetId: proposed.targetId },
    family,
  );
  if (proposedEdge) edges.push(proposedEdge);

  const cycle = findCycle(edges);
  if (cycle) {
    throw new CycleError(cycle);
  }
}
