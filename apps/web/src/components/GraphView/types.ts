import type { Node, Edge } from '@xyflow/react';
import type { Criticality, LinkType, RequirementType } from '@po/core';

/**
 * Data payload for a Requirement node in the ReactFlow graph.
 * Must extend Record<string, unknown> to satisfy @xyflow/react Node generic constraint.
 */
export interface RequirementNodeData extends Record<string, unknown> {
  slug: string;
  name: string;
  type: RequirementType;
  criticality: Criticality;
  implemented: boolean;
  isBroken: boolean;
  description?: string;
  onClick: (slug: string) => void;
}

export type GraphNode = Node<RequirementNodeData>;
export type GraphEdge = Edge<{ linkType: LinkType } & Record<string, unknown>>;
