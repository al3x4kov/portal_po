import { describe, it, expect } from 'vitest';
import { transformRequirementsToGraph } from './graphTransform';
import type { Requirement } from '@po/core';

function makeReq(overrides: Partial<Requirement> & { slug: string; name: string }): Requirement {
  return {
    type: 'FUNCTION',
    criticality: 'MEDIUM',
    implemented: true,
    links: [],
    description: '',
    scenarios: [],
    quarter: undefined,
    year: undefined,
    ...overrides,
  } as Requirement;
}

describe('transformRequirementsToGraph', () => {
  it('returns empty nodes and edges for an empty array', () => {
    const result = transformRequirementsToGraph([]);
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('creates nodes for each requirement with correct data', () => {
    const reqs = [
      makeReq({ slug: 'req-a', name: 'Req A', type: 'FUNCTION', criticality: 'HIGH' }),
      makeReq({ slug: 'req-b', name: 'Req B', type: 'NFR', criticality: 'LOW' }),
    ];
    const { nodes } = transformRequirementsToGraph(reqs);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].data.slug).toBe('req-a');
    expect(nodes[0].data.type).toBe('FUNCTION');
    expect(nodes[1].data.slug).toBe('req-b');
    expect(nodes[1].data.type).toBe('NFR');
  });

  it('creates nodes with initial position 0,0', () => {
    const reqs = [makeReq({ slug: 'req-a', name: 'Req A' })];
    const { nodes } = transformRequirementsToGraph(reqs);
    expect(nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it('deduplicates PARENT_OF + CHILD_OF reciprocal pair into one PARENT_OF edge', () => {
    const reqs = [
      makeReq({
        slug: 'parent',
        name: 'Parent',
        links: [{ type: 'PARENT_OF', targetSlug: 'child' }],
      }),
      makeReq({
        slug: 'child',
        name: 'Child',
        links: [{ type: 'CHILD_OF', targetSlug: 'parent' }],
      }),
    ];
    const { edges } = transformRequirementsToGraph(reqs);
    expect(edges).toHaveLength(1);
    expect(edges[0].data?.linkType).toBe('PARENT_OF');
    expect(edges[0].source).toBe('parent');
    expect(edges[0].target).toBe('child');
  });

  it('deduplicates RELATES_TO bidirectional pair into one edge', () => {
    const reqs = [
      makeReq({
        slug: 'a',
        name: 'A',
        links: [{ type: 'RELATES_TO', targetSlug: 'b' }],
      }),
      makeReq({
        slug: 'b',
        name: 'B',
        links: [{ type: 'RELATES_TO', targetSlug: 'a' }],
      }),
    ];
    const { edges } = transformRequirementsToGraph(reqs);
    expect(edges).toHaveLength(1);
    expect(edges[0].data?.linkType).toBe('RELATES_TO');
  });

  it('creates DEPENDS_ON edges directly without deduplication', () => {
    const reqs = [
      makeReq({
        slug: 'a',
        name: 'A',
        links: [{ type: 'DEPENDS_ON', targetSlug: 'b' }],
      }),
      makeReq({ slug: 'b', name: 'B', links: [] }),
    ];
    const { edges } = transformRequirementsToGraph(reqs);
    expect(edges).toHaveLength(1);
    expect(edges[0].data?.linkType).toBe('DEPENDS_ON');
    expect(edges[0].source).toBe('a');
    expect(edges[0].target).toBe('b');
  });

  it('creates BLOCKED_BY edges directly without deduplication', () => {
    const reqs = [
      makeReq({
        slug: 'a',
        name: 'A',
        links: [{ type: 'BLOCKED_BY', targetSlug: 'b' }],
      }),
      makeReq({ slug: 'b', name: 'B', links: [] }),
    ];
    const { edges } = transformRequirementsToGraph(reqs);
    expect(edges).toHaveLength(1);
    expect(edges[0].data?.linkType).toBe('BLOCKED_BY');
  });

  it('skips links to unknown (broken) slugs', () => {
    const reqs = [
      makeReq({
        slug: 'a',
        name: 'A',
        links: [{ type: 'DEPENDS_ON', targetSlug: 'nonexistent' }],
      }),
    ];
    const { edges } = transformRequirementsToGraph(reqs);
    expect(edges).toHaveLength(0);
  });

  it('handles requirements with no links (isolated nodes)', () => {
    const reqs = [
      makeReq({ slug: 'a', name: 'A', links: [] }),
      makeReq({ slug: 'b', name: 'B', links: [] }),
    ];
    const { nodes, edges } = transformRequirementsToGraph(reqs);
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(0);
  });

  it('sets isBroken=false on regular nodes', () => {
    const reqs = [makeReq({ slug: 'a', name: 'A' })];
    const { nodes } = transformRequirementsToGraph(reqs);
    expect(nodes[0].data.isBroken).toBe(false);
  });

  it('handles CHILD_OF without corresponding PARENT_OF — emits PARENT_OF edge reversed', () => {
    const reqs = [
      makeReq({
        slug: 'child',
        name: 'Child',
        links: [{ type: 'CHILD_OF', targetSlug: 'parent' }],
      }),
      makeReq({ slug: 'parent', name: 'Parent', links: [] }),
    ];
    const { edges } = transformRequirementsToGraph(reqs);
    expect(edges).toHaveLength(1);
    expect(edges[0].data?.linkType).toBe('PARENT_OF');
    expect(edges[0].source).toBe('parent');
    expect(edges[0].target).toBe('child');
  });
});
