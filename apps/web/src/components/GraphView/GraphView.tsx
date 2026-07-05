import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type NodeProps,
} from '@xyflow/react';
import type { ComponentType } from 'react';
import '@xyflow/react/dist/style.css';
import type { Requirement } from '@po/core';
import { useRequirements } from '../../api/hooks';
import { plural } from '../../lib/plural';
import { useUiStore } from '../../store/ui';
import { transformRequirementsToGraph } from './graphTransform';
import { applyELKLayout } from './elkLayout';
import { getEdgeStyle } from './graphEdgeStyles';
import { RequirementNode } from './RequirementNode';
import { GraphToolbar } from './GraphToolbar';
import { GraphLegend } from './GraphLegend';
import type { GraphNode, GraphEdge } from './types';

const NODE_TYPES: Record<string, ComponentType<NodeProps & { data: unknown; type: unknown }>> = {
  requirementNode: RequirementNode as unknown as ComponentType<
    NodeProps & { data: unknown; type: unknown }
  >,
};

const PERF_LIMIT = 200;

interface GraphViewProps {
  projectId: string;
}

/**
 * Main graph view component (FR-G2, FR-G3, FR-G4, FR-G5, FR-G6, FR-G8).
 * Renders requirements as a directed graph using ReactFlow + ELK layout.
 */
export function GraphView({ projectId }: GraphViewProps): React.ReactElement {
  const reqQuery = useRequirements(projectId);
  const openModal = useUiStore((s) => s.openModal);

  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<GraphEdge>([]);
  const [showNfr, setShowNfr] = useState(true);
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [isLayingOut, setIsLayingOut] = useState(false);
  const [hasLayout, setHasLayout] = useState(false);

  const requirements: Requirement[] = useMemo(
    () => reqQuery.data?.requirements ?? [],
    [reqQuery.data],
  );

  const brokenRequirements = useMemo(() => reqQuery.data?.broken ?? [], [reqQuery.data]);

  // Build broken requirements as nodes
  const brokenNodes = useMemo<GraphNode[]>(() => {
    return brokenRequirements.map((b) => ({
      id: `broken-${b.file}`,
      type: 'requirementNode',
      position: { x: 0, y: 0 },
      data: {
        slug: `broken-${b.file}`,
        name: b.file,
        type: 'FUNCTION' as const,
        criticality: 'MEDIUM' as const,
        implemented: false,
        isBroken: true,
        description: b.error,
        onClick: () => {},
      },
    }));
  }, [brokenRequirements]);

  const handleRelayout = useCallback(
    async (_reqs: Requirement[], graphNodes: GraphNode[], graphEdges: GraphEdge[]) => {
      if (graphNodes.length === 0) return;
      setIsLayingOut(true);
      try {
        const laidOut = await applyELKLayout(graphNodes, graphEdges);
        setNodes(laidOut);
        setEdges(graphEdges);
      } finally {
        setIsLayingOut(false);
        setHasLayout(true);
      }
    },
    [setNodes, setEdges],
  );

  // Rebuild graph when requirements change
  useEffect(() => {
    if (reqQuery.isLoading || reqQuery.isError) return;

    const { nodes: graphNodes, edges: graphEdges } = transformRequirementsToGraph(requirements);

    // Add broken nodes (no edges for them)
    const allNodes = [...graphNodes, ...brokenNodes];

    // Apply onClick handler to all nodes
    const onClick = (slug: string): void => {
      const req = requirements.find((r) => r.slug === slug);
      if (req) {
        openModal({ kind: 'requirement', reqType: req.type, requirement: req });
      }
    };
    const nodesWithHandlers = allNodes.map((n) => ({
      ...n,
      data: { ...n.data, onClick },
    }));

    setHasLayout(false);
    void handleRelayout(requirements, nodesWithHandlers, graphEdges);
  }, [requirements, brokenNodes, reqQuery.isLoading, reqQuery.isError, openModal, handleRelayout]);

  // Filter nodes based on showNfr and showAll (perf gate)
  const visibleNodes = useMemo(() => {
    let filtered = nodes;

    // Filter NFR if toggled off
    if (!showNfr) {
      filtered = filtered.filter((n) => n.data.type !== 'NFR');
    }

    // Perf gate: if > PERF_LIMIT nodes and !showAll, show root + direct children
    if (filtered.length > PERF_LIMIT && !showAll) {
      const nodeIds = new Set(filtered.map((n) => n.id));
      const edgesByTarget = new Map<string, string[]>();
      for (const edge of edges) {
        if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
          if (!edgesByTarget.has(edge.target)) {
            edgesByTarget.set(edge.target, []);
          }
          edgesByTarget.get(edge.target)!.push(edge.source);
        }
      }
      // Root nodes = nodes without incoming PARENT_OF edges
      const nodesWithParents = new Set<string>();
      for (const edge of edges) {
        if (edge.data?.linkType === 'PARENT_OF') {
          nodesWithParents.add(edge.target);
        }
      }
      const rootIds = new Set(filtered.filter((n) => !nodesWithParents.has(n.id)).map((n) => n.id));

      // Direct children of roots
      const childIds = new Set<string>();
      for (const edge of edges) {
        if (edge.data?.linkType === 'PARENT_OF' && rootIds.has(edge.source)) {
          childIds.add(edge.target);
        }
      }

      const visibleIds = new Set([...rootIds, ...childIds]);
      filtered = filtered.filter((n) => visibleIds.has(n.id));
    }

    return filtered;
  }, [nodes, showNfr, showAll, edges]);

  const visibleEdges = useMemo(() => {
    const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
    let filtered = edges.filter(
      (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target),
    );

    // Apply edge styles
    filtered = filtered.map((edge) => {
      const styleProps = getEdgeStyle(edge.data?.linkType ?? 'RELATES_TO');
      return {
        ...edge,
        ...styleProps,
        label: showEdgeLabels ? edge.data?.linkType : undefined,
      };
    });

    return filtered;
  }, [edges, visibleNodes, showEdgeLabels]);

  const totalNodeCount = nodes.length;
  const showPerfBanner = totalNodeCount > PERF_LIMIT && !showAll;

  // Loading state
  if (reqQuery.isLoading) {
    return (
      <div
        className="flex h-full flex-1 items-center justify-center"
        style={{ color: 'var(--color-text-3)' }}
        data-testid="graph-loading"
      >
        <p>Загрузка графа…</p>
      </div>
    );
  }

  // Error state
  if (reqQuery.isError) {
    return (
      <div
        className="m-4 rounded-lg p-3 text-sm"
        role="alert"
        style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
        data-testid="graph-error"
      >
        Ошибка загрузки данных для графа.
      </div>
    );
  }

  // Empty state
  if (requirements.length === 0 && brokenRequirements.length === 0) {
    return (
      <div
        className="flex h-full flex-1 flex-col items-center justify-center text-center"
        data-testid="graph-empty"
      >
        <p className="font-semibold" style={{ color: 'var(--color-text)' }}>
          Проект пуст.
        </p>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-3)' }}>
          Добавьте требования в режиме Дерево
        </p>
      </div>
    );
  }

  const totalGraphNodes = requirements.length + brokenNodes.length;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 0',
        minHeight: 400,
        overflow: 'hidden',
      }}
    >
      {/* Fixed-height header: toolbar + optional perf banner */}
      <div style={{ flexShrink: 0 }}>
        <GraphToolbar
          showNfr={showNfr}
          onToggleNfr={() => setShowNfr((v) => !v)}
          showEdgeLabels={showEdgeLabels}
          onToggleEdgeLabels={() => setShowEdgeLabels((v) => !v)}
          onRelayout={() => {
            const onClick = (slug: string): void => {
              const req = requirements.find((r) => r.slug === slug);
              if (req) {
                openModal({ kind: 'requirement', reqType: req.type, requirement: req });
              }
            };
            const allNodes = nodes.map((n) => ({ ...n, data: { ...n.data, onClick } }));
            void handleRelayout(requirements, allNodes, edges);
          }}
        />

        {showPerfBanner ? (
          <div
            className="flex items-center gap-2 px-4 py-2 text-sm"
            role="alert"
            style={{
              background: 'var(--color-warning-bg)',
              color: 'var(--color-warning-fg)',
              borderBottom: '1px solid var(--color-border)',
            }}
            data-testid="graph-perf-banner"
          >
            <span>Граф содержит {totalNodeCount} узлов. Рекомендуется использовать фильтры.</span>
            <button
              type="button"
              className="ml-2 font-semibold underline"
              data-testid="graph-show-all"
              onClick={() => setShowAll(true)}
            >
              Показать всё
            </button>
          </div>
        ) : null}
      </div>

      {/* Flex-grow canvas: absolute inner div gives ReactFlow a concrete height */}
      <div
        className="relative"
        style={{ flexGrow: 1, flexShrink: 1, flexBasis: '0px', minHeight: 400 }}
        data-testid="graph-canvas"
        role="application"
        aria-label="Граф требований"
      >
        {/* position:absolute + inset:0 gives ReactFlow a concrete width+height
            equal to the flex-grown parent, bypassing the height:100% limitation */}
        <div style={{ position: 'absolute', inset: 0 }}>
          <ReactFlow
            nodes={visibleNodes}
            edges={visibleEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={NODE_TYPES}
            fitView
            attributionPosition="bottom-right"
          >
            <Background />
            <Controls />
            <MiniMap />
            <GraphLegend />
          </ReactFlow>
        </div>

        {/* §2.20.2: пока ELK считает координаты, канва не выглядит пустой —
            полупрозрачный оверлей со спиннером и статусом. */}
        {isLayingOut || !hasLayout ? (
          <div
            className="absolute inset-0 z-10 grid place-items-center"
            style={{ background: 'color-mix(in srgb, var(--color-bg) 55%, transparent)' }}
            role="status"
            aria-live="polite"
            data-testid="graph-building"
          >
            <div
              className="card flex items-center gap-3 px-5 py-4"
              style={{ boxShadow: 'var(--shadow-lg)' }}
            >
              <span
                className="spinner"
                style={{ color: 'var(--color-primary)', width: 18, height: 18 }}
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-semibold">Раскладываем граф…</p>
                <p className="hint">
                  {totalGraphNodes} {plural(totalGraphNodes, 'узел', 'узла', 'узлов')} · обычно
                  занимает пару секунд
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
