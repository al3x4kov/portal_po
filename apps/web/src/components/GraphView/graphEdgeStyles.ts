import type { LinkType } from '@po/core';
import { MarkerType } from '@xyflow/react';

export interface EdgeStylePatch {
  style?: React.CSSProperties;
  markerEnd?: { type: MarkerType; color?: string };
  markerStart?: { type: MarkerType; color?: string };
  label?: string;
  animated?: boolean;
}

/**
 * Returns ReactFlow edge style patches for a given LinkType.
 * Pure function — no React, safe to use in non-component contexts.
 */
export function getEdgeStyle(linkType: LinkType): EdgeStylePatch {
  switch (linkType) {
    case 'PARENT_OF':
      return {
        style: { stroke: '#64748b', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b' },
      };

    case 'DEPENDS_ON':
      return {
        style: { stroke: '#3b82f6', strokeWidth: 1.5, strokeDasharray: '5 5' },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#3b82f6' },
      };

    case 'BLOCKED_BY':
      return {
        style: { stroke: '#ef4444', strokeWidth: 1.5, strokeDasharray: '5 5' },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#ef4444' },
      };

    case 'RELATES_TO':
      return {
        style: { stroke: '#22c55e', strokeWidth: 1 },
        markerStart: { type: MarkerType.Arrow, color: '#22c55e' },
        markerEnd: { type: MarkerType.Arrow, color: '#22c55e' },
      };

    case 'CHILD_OF':
      // CHILD_OF edges are normally deduplicated into PARENT_OF,
      // but style them as PARENT_OF if they ever appear
      return {
        style: { stroke: '#64748b', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b' },
      };

    default:
      return {
        style: { stroke: '#94a3b8', strokeWidth: 1 },
        markerEnd: { type: MarkerType.Arrow, color: '#94a3b8' },
      };
  }
}
