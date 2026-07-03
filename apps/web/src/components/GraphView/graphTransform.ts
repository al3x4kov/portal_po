import type { Requirement } from '@po/core';
import type { GraphNode, GraphEdge } from './types';

/**
 * Transforms an array of Requirements (including broken ones) into ReactFlow
 * nodes and edges with deduplication of reciprocal link pairs.
 *
 * Deduplication rules:
 * - PARENT_OF(A→B) + CHILD_OF(B→A)  → 1 edge, type PARENT_OF, source=A, target=B
 * - RELATES_TO(A→B) + RELATES_TO(B→A) → 1 edge, type RELATES_TO
 * - DEPENDS_ON and BLOCKED_BY are directional — no deduplication
 */
export function transformRequirementsToGraph(reqs: Requirement[]): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  if (reqs.length === 0) {
    return { nodes: [], edges: [] };
  }

  // Build a slug→requirement map
  const bySlug = new Map<string, Requirement>(reqs.map((r) => [r.slug, r]));

  const nodes: GraphNode[] = reqs.map((req) => ({
    id: req.slug,
    type: 'requirementNode',
    position: { x: 0, y: 0 },
    data: {
      slug: req.slug,
      name: req.name,
      type: req.type,
      criticality: req.criticality,
      implemented: req.implemented,
      isBroken: false,
      description: req.description,
      onClick: () => {},
    },
  }));

  // Track emitted edges to avoid duplicates
  // Key format: `${source}|${target}|${type}`
  const emitted = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const req of reqs) {
    for (const link of req.links) {
      const sourceSlug = req.slug;
      const targetSlug = link.targetSlug;
      const linkType = link.type;

      // Skip links to unknown slugs (broken references)
      if (!bySlug.has(targetSlug)) continue;

      if (linkType === 'PARENT_OF') {
        // Canonical: source → target with PARENT_OF
        // Also suppress the reverse CHILD_OF edge
        const key = `${sourceSlug}|${targetSlug}|PARENT_OF`;
        const reverseKey = `${targetSlug}|${sourceSlug}|PARENT_OF`;
        if (!emitted.has(key) && !emitted.has(reverseKey)) {
          emitted.add(key);
          edges.push({
            id: `${sourceSlug}->${targetSlug}:PARENT_OF`,
            source: sourceSlug,
            target: targetSlug,
            data: { linkType: 'PARENT_OF' },
          });
        }
      } else if (linkType === 'CHILD_OF') {
        // CHILD_OF(B→A) is the inverse of PARENT_OF(A→B).
        // If PARENT_OF already emitted, skip. Otherwise emit as PARENT_OF(target→source).
        const parentOfKey = `${targetSlug}|${sourceSlug}|PARENT_OF`;
        const childOfAsParentKey = `${sourceSlug}|${targetSlug}|PARENT_OF`;
        if (!emitted.has(parentOfKey) && !emitted.has(childOfAsParentKey)) {
          emitted.add(parentOfKey);
          edges.push({
            id: `${targetSlug}->${sourceSlug}:PARENT_OF`,
            source: targetSlug,
            target: sourceSlug,
            data: { linkType: 'PARENT_OF' },
          });
        }
      } else if (linkType === 'RELATES_TO') {
        // Bidirectional — deduplicate both directions
        const key = `${sourceSlug}|${targetSlug}|RELATES_TO`;
        const reverseKey = `${targetSlug}|${sourceSlug}|RELATES_TO`;
        if (!emitted.has(key) && !emitted.has(reverseKey)) {
          emitted.add(key);
          edges.push({
            id: `${sourceSlug}->${targetSlug}:RELATES_TO`,
            source: sourceSlug,
            target: targetSlug,
            data: { linkType: 'RELATES_TO' },
          });
        }
      } else {
        // DEPENDS_ON, BLOCKED_BY — directional, no deduplication
        const key = `${sourceSlug}|${targetSlug}|${linkType}`;
        if (!emitted.has(key)) {
          emitted.add(key);
          edges.push({
            id: `${sourceSlug}->${targetSlug}:${linkType}`,
            source: sourceSlug,
            target: targetSlug,
            data: { linkType },
          });
        }
      }
    }
  }

  return { nodes, edges };
}
