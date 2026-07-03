import ELK from 'elkjs/lib/elk.bundled.js';
import type { GraphNode, GraphEdge } from './types';

const elk = new ELK();

const NODE_WIDTH = 220;
const NODE_HEIGHT = 100;

interface ELKLayoutOptions {
  /** If true (default), NFR nodes are shifted to the right of FUNCTION nodes after layout. */
  separateFunctionNFR?: boolean;
}

/**
 * Applies ELK layered layout to the given nodes/edges.
 * Returns the same nodes with updated `position` values.
 *
 * @param nodes - GraphNode array (positions will be overwritten)
 * @param edges - GraphEdge array (used for layout only, not mutated)
 * @param options - layout options
 */
export async function applyELKLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: ELKLayoutOptions = {},
): Promise<GraphNode[]> {
  if (nodes.length === 0) return [];

  const { separateFunctionNFR = true } = options;

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '60',
      'elk.spacing.nodeNode': '40',
      'elk.separateConnectedComponents': 'true',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const layouted = await elk.layout(graph);

  const positionMap = new Map<string, { x: number; y: number }>();
  for (const child of layouted.children ?? []) {
    positionMap.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }

  let updatedNodes = nodes.map((node) => ({
    ...node,
    position: positionMap.get(node.id) ?? node.position,
  }));

  if (separateFunctionNFR) {
    const functionNodes = updatedNodes.filter((n) => n.data.type === 'FUNCTION');
    const nfrNodes = updatedNodes.filter((n) => n.data.type === 'NFR');

    if (functionNodes.length > 0 && nfrNodes.length > 0) {
      // Find the max X of function nodes and add a gap for NFR nodes
      const maxFunctionX = Math.max(...functionNodes.map((n) => n.position.x + NODE_WIDTH));
      const nfrMinX = Math.min(...nfrNodes.map((n) => n.position.x));
      const shift = maxFunctionX + 80 - nfrMinX;

      updatedNodes = updatedNodes.map((node) => {
        if (node.data.type === 'NFR') {
          return { ...node, position: { x: node.position.x + shift, y: node.position.y } };
        }
        return node;
      });
    }
  }

  return updatedNodes;
}
