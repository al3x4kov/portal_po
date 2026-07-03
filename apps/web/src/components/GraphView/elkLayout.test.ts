import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock elkjs before importing elkLayout
vi.mock('elkjs/lib/elk.bundled.js', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      layout: vi.fn().mockImplementation(async (graph: { children?: Array<{ id: string }> }) => {
        // Simple mock: assign positions based on index
        const children = (graph.children ?? []).map(
          (child: { id: string }, i: number) => ({
            ...child,
            x: (i % 3) * 260,
            y: Math.floor(i / 3) * 160,
          }),
        );
        return { ...graph, children };
      }),
    })),
  };
});

import { applyELKLayout } from './elkLayout';
import type { GraphNode, GraphEdge } from './types';

function makeNode(
  id: string,
  type: 'FUNCTION' | 'NFR' = 'FUNCTION',
): GraphNode {
  return {
    id,
    type: 'requirementNode',
    position: { x: 0, y: 0 },
    data: {
      slug: id,
      name: `Node ${id}`,
      type,
      criticality: 'MEDIUM',
      implemented: true,
      isBroken: false,
      onClick: () => {},
    },
  };
}

function makeEdge(source: string, target: string): GraphEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    data: { linkType: 'PARENT_OF' },
  };
}

describe('applyELKLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no nodes', async () => {
    const result = await applyELKLayout([], []);
    expect(result).toHaveLength(0);
  });

  it('assigns positions to nodes (non-zero after layout)', async () => {
    const nodes = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c'),
      makeNode('d'),
    ];
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];
    const result = await applyELKLayout(nodes, edges);
    expect(result).toHaveLength(4);
    // After mock layout, nodes get x/y from the mock
    const positions = result.map((n) => `${n.position.x},${n.position.y}`);
    // With our mock, first 3 nodes are in row 0 with x=0, 260, 520
    // 4th node is in row 1 with x=0
    expect(positions).toContain('0,0');
    expect(positions).toContain('260,0');
  });

  it('no two nodes have identical positions with 10 nodes and 8 edges', async () => {
    const nodes = Array.from({ length: 10 }, (_, i) => makeNode(`node-${i}`));
    const edges = Array.from({ length: 8 }, (_, i) => makeEdge(`node-${i}`, `node-${i + 1}`));
    const result = await applyELKLayout(nodes, edges);
    const posSet = new Set(result.map((n) => `${n.position.x},${n.position.y}`));
    // All 10 nodes should have unique positions
    expect(posSet.size).toBe(10);
  });

  it('shifts NFR nodes to the right of FUNCTION nodes when separateFunctionNFR=true', async () => {
    const nodes = [
      makeNode('fn-1', 'FUNCTION'),
      makeNode('fn-2', 'FUNCTION'),
      makeNode('nfr-1', 'NFR'),
      makeNode('nfr-2', 'NFR'),
    ];
    const result = await applyELKLayout(nodes, [], { separateFunctionNFR: true });
    const fnNodes = result.filter((n) => n.data.type === 'FUNCTION');
    const nfrNodes = result.filter((n) => n.data.type === 'NFR');
    const maxFnX = Math.max(...fnNodes.map((n) => n.position.x));
    const minNfrX = Math.min(...nfrNodes.map((n) => n.position.x));
    // NFR nodes should be to the right of all FUNCTION nodes
    expect(minNfrX).toBeGreaterThan(maxFnX);
  });

  it('does not shift NFR nodes when separateFunctionNFR=false', async () => {
    const nodes = [
      makeNode('fn-1', 'FUNCTION'),
      makeNode('nfr-1', 'NFR'),
    ];
    // With mock: fn-1 at x=0, nfr-1 at x=260 (positions from index)
    // When separateFunctionNFR=false, we don't shift
    const result = await applyELKLayout(nodes, [], { separateFunctionNFR: false });
    expect(result).toHaveLength(2);
    // Positions should be exactly what the mock returned (no additional shift)
    const nfrNode = result.find((n) => n.id === 'nfr-1')!;
    expect(nfrNode.position.x).toBe(260); // from mock (index 1 → x = 1*260)
  });
});
