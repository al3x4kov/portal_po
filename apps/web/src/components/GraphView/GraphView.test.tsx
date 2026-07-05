import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RequirementListResult } from '../../api/types';
import type { Requirement } from '@po/core';

// ---- Mock @xyflow/react ----
// We use a factory returning React hooks — we need useState imported inside the factory
// to avoid the no-require-imports rule we use a top-level import
import reactPkg from 'react';

vi.mock('@xyflow/react', () => {
  const ReactFlow = ({
    nodes,
    edges,
    children,
  }: {
    nodes: Array<{ id: string; data: { slug: string; onClick?: (slug: string) => void } }>;
    edges?: Array<{ id: string; label?: unknown }>;
    children?: React.ReactNode;
  }) => (
    <div data-testid="mock-react-flow" data-node-count={nodes.length}>
      {nodes.map((n) => (
        <button
          type="button"
          key={n.id}
          data-testid={`flow-node-${n.data.slug}`}
          onClick={() => n.data.onClick?.(n.data.slug)}
        />
      ))}
      {(edges ?? []).map((e) => (
        <div key={e.id} data-testid={`flow-edge-${e.id}`} data-label={String(e.label ?? '')} />
      ))}
      {children}
    </div>
  );

  return {
    ReactFlow,
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Panel: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="panel">{children}</div>
    ),
    useNodesState: (initial: unknown[]) => {
      const [n, setN] = reactPkg.useState(initial);
      return [n, setN, vi.fn()];
    },
    useEdgesState: (initial: unknown[]) => {
      const [e, setE] = reactPkg.useState(initial);
      return [e, setE, vi.fn()];
    },
    MarkerType: { Arrow: 'arrow', ArrowClosed: 'arrowclosed' },
  };
});

// ---- Mock elkjs ----
vi.mock('elkjs/lib/elk.bundled.js', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      layout: vi.fn().mockImplementation(async (graph: { children?: Array<{ id: string }> }) => {
        const children = (graph.children ?? []).map((child: { id: string }, i: number) => ({
          ...child,
          x: i * 260,
          y: 0,
        }));
        return { ...graph, children };
      }),
    })),
  };
});

// ---- Mock useRequirements ----
const mockUseRequirements = vi.fn();
vi.mock('../../api/hooks', () => ({
  useRequirements: (...args: unknown[]) => mockUseRequirements(...args),
}));

import { GraphView } from './GraphView';
import { renderWithProviders } from '../../test/utils';
import { useUiStore } from '../../store/ui';

function makeReq(slug: string, name: string): Requirement {
  return {
    slug,
    name,
    type: 'FUNCTION',
    criticality: 'MEDIUM',
    implemented: true,
    links: [],
    description: '',
    scenarios: [],
    quarter: undefined,
    year: undefined,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  } as unknown as Requirement;
}

function makeQueryResult(
  overrides: Partial<{
    isLoading: boolean;
    isError: boolean;
    data: RequirementListResult | undefined;
  }> = {},
) {
  return {
    isLoading: false,
    isError: false,
    data: { requirements: [], broken: [], incomplete: [] } satisfies RequirementListResult,
    error: null,
    ...overrides,
  };
}

describe('GraphView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ modal: null });
  });

  it('shows loading state when requirements are loading', () => {
    mockUseRequirements.mockReturnValue(makeQueryResult({ isLoading: true }));
    renderWithProviders(<GraphView projectId="proj-1" />);
    expect(screen.getByTestId('graph-loading')).toBeInTheDocument();
  });

  it('shows error state when requirements fail to load', () => {
    mockUseRequirements.mockReturnValue(makeQueryResult({ isError: true, data: undefined }));
    renderWithProviders(<GraphView projectId="proj-1" />);
    expect(screen.getByTestId('graph-error')).toBeInTheDocument();
  });

  it('shows empty state when project has no requirements', async () => {
    mockUseRequirements.mockReturnValue(
      makeQueryResult({ data: { requirements: [], broken: [], incomplete: [] } }),
    );
    renderWithProviders(<GraphView projectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('graph-empty')).toBeInTheDocument();
    });
  });

  it('T6 §2.20.2: показывает оверлей «Раскладываем граф…» поверх канвы на время раскладки', async () => {
    const reqs = [makeReq('req-1', 'Req 1'), makeReq('req-2', 'Req 2')];
    mockUseRequirements.mockReturnValue(
      makeQueryResult({ data: { requirements: reqs, broken: [], incomplete: [] } }),
    );
    renderWithProviders(<GraphView projectId="proj-1" />);
    // Канва рендерится сразу; оверлей закрывает её, пока ELK не вернул координаты
    expect(screen.getByTestId('graph-canvas')).toBeInTheDocument();
    const overlay = screen.getByTestId('graph-building');
    expect(overlay).toHaveTextContent('Раскладываем граф…');
    expect(overlay).toHaveTextContent('2 узла · обычно занимает пару секунд');
    await waitFor(() => {
      expect(screen.queryByTestId('graph-building')).not.toBeInTheDocument();
    });
  });

  it('renders graph canvas after layout completes with requirements', async () => {
    const reqs = [makeReq('req-1', 'Req 1'), makeReq('req-2', 'Req 2')];
    mockUseRequirements.mockReturnValue(
      makeQueryResult({ data: { requirements: reqs, broken: [], incomplete: [] } }),
    );
    renderWithProviders(<GraphView projectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('graph-canvas')).toBeInTheDocument();
    });
  });

  it('renders flow nodes for each requirement', async () => {
    const reqs = [
      makeReq('req-a', 'Requirement A'),
      makeReq('req-b', 'Requirement B'),
      makeReq('req-c', 'Requirement C'),
    ];
    mockUseRequirements.mockReturnValue(
      makeQueryResult({ data: { requirements: reqs, broken: [], incomplete: [] } }),
    );
    renderWithProviders(<GraphView projectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('flow-node-req-a')).toBeInTheDocument();
      expect(screen.getByTestId('flow-node-req-b')).toBeInTheDocument();
      expect(screen.getByTestId('flow-node-req-c')).toBeInTheDocument();
    });
  });

  it('shows perf banner when node count exceeds 200', async () => {
    const reqs = Array.from({ length: 201 }, (_, i) => makeReq(`req-${i}`, `Req ${i}`));
    mockUseRequirements.mockReturnValue(
      makeQueryResult({ data: { requirements: reqs, broken: [], incomplete: [] } }),
    );
    renderWithProviders(<GraphView projectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('graph-perf-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('graph-show-all')).toBeInTheDocument();
  });

  it('hides perf banner after clicking "Показать всё"', async () => {
    const user = userEvent.setup();
    const reqs = Array.from({ length: 201 }, (_, i) => makeReq(`req-${i}`, `Req ${i}`));
    mockUseRequirements.mockReturnValue(
      makeQueryResult({ data: { requirements: reqs, broken: [], incomplete: [] } }),
    );
    renderWithProviders(<GraphView projectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('graph-show-all')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('graph-show-all'));
    await waitFor(() => {
      expect(screen.queryByTestId('graph-perf-banner')).not.toBeInTheDocument();
    });
  });

  it('shows graph-toolbar after layout', async () => {
    const reqs = [makeReq('req-1', 'Req 1')];
    mockUseRequirements.mockReturnValue(
      makeQueryResult({ data: { requirements: reqs, broken: [], incomplete: [] } }),
    );
    renderWithProviders(<GraphView projectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('graph-toolbar')).toBeInTheDocument();
    });
  });

  it('perf-gate keeps roots + direct children visible when over the limit with hierarchy edges', async () => {
    // 201 nodes → over PERF_LIMIT. req-0 is the parent of req-1 (a direct child).
    const reqs = Array.from({ length: 201 }, (_, i) => makeReq(`req-${i}`, `Req ${i}`));
    (reqs[0] as unknown as { links: unknown[] }).links = [
      { type: 'PARENT_OF', targetSlug: 'req-1' },
    ];
    (reqs[1] as unknown as { links: unknown[] }).links = [
      { type: 'CHILD_OF', targetSlug: 'req-0' },
    ];
    mockUseRequirements.mockReturnValue(
      makeQueryResult({ data: { requirements: reqs, broken: [], incomplete: [] } }),
    );
    renderWithProviders(<GraphView projectId="proj-1" />);
    // req-1 has a parent (req-0) → it is a direct child of a root and stays visible.
    expect(await screen.findByTestId('flow-node-req-1')).toBeInTheDocument();
    // req-0 is a root → visible.
    expect(screen.getByTestId('flow-node-req-0')).toBeInTheDocument();
    // The perf banner is shown because we exceeded the limit.
    expect(screen.getByTestId('graph-perf-banner')).toBeInTheDocument();
  });

  it('opens the requirement modal when a node is clicked', async () => {
    const user = userEvent.setup();
    const reqs = [makeReq('req-1', 'Req 1')];
    mockUseRequirements.mockReturnValue(
      makeQueryResult({ data: { requirements: reqs, broken: [], incomplete: [] } }),
    );
    renderWithProviders(<GraphView projectId="proj-1" />);
    const node = await screen.findByTestId('flow-node-req-1');
    await user.click(node);
    await waitFor(() => {
      const modal = useUiStore.getState().modal;
      expect(modal).toMatchObject({ kind: 'requirement', reqType: 'FUNCTION' });
    });
  });

  it('hides NFR nodes when the НФТ toggle is turned off', async () => {
    const user = userEvent.setup();
    const fn = makeReq('fn-1', 'Функция');
    const nfr = { ...makeReq('nfr-1', 'НФТ'), type: 'NFR' } as unknown as Requirement;
    mockUseRequirements.mockReturnValue(
      makeQueryResult({ data: { requirements: [fn, nfr], broken: [], incomplete: [] } }),
    );
    renderWithProviders(<GraphView projectId="proj-1" />);
    await screen.findByTestId('flow-node-nfr-1');
    await user.click(screen.getByTestId('graph-toggle-nfr'));
    await waitFor(() => {
      expect(screen.queryByTestId('flow-node-nfr-1')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('flow-node-fn-1')).toBeInTheDocument();
  });

  it('renders edge labels only after the "Метки рёбер" toggle is enabled', async () => {
    const user = userEvent.setup();
    const a = {
      ...makeReq('a', 'A'),
      links: [{ type: 'RELATES_TO', targetSlug: 'b' }],
    } as unknown as Requirement;
    const b = {
      ...makeReq('b', 'B'),
      links: [{ type: 'RELATES_TO', targetSlug: 'a' }],
    } as unknown as Requirement;
    mockUseRequirements.mockReturnValue(
      makeQueryResult({ data: { requirements: [a, b], broken: [], incomplete: [] } }),
    );
    renderWithProviders(<GraphView projectId="proj-1" />);
    const edge = await screen.findByTestId('flow-edge-a->b:RELATES_TO');
    expect(edge).toHaveAttribute('data-label', '');
    await user.click(screen.getByTestId('graph-toggle-labels'));
    await waitFor(() => {
      expect(screen.getByTestId('flow-edge-a->b:RELATES_TO')).toHaveAttribute(
        'data-label',
        'RELATES_TO',
      );
    });
  });

  it('re-runs layout when the "Перерасставить" button is clicked', async () => {
    const user = userEvent.setup();
    const reqs = [makeReq('req-1', 'Req 1')];
    mockUseRequirements.mockReturnValue(
      makeQueryResult({ data: { requirements: reqs, broken: [], incomplete: [] } }),
    );
    renderWithProviders(<GraphView projectId="proj-1" />);
    await screen.findByTestId('graph-relayout');
    await user.click(screen.getByTestId('graph-relayout'));
    // canvas still present after relayout completes
    await waitFor(() => {
      expect(screen.getByTestId('graph-canvas')).toBeInTheDocument();
    });
    // clicking a node after relayout opens the modal via the relayout onClick closure
    await user.click(await screen.findByTestId('flow-node-req-1'));
    await waitFor(() => {
      expect(useUiStore.getState().modal).toMatchObject({ kind: 'requirement' });
    });
  });

  it('renders broken requirements as nodes even without valid requirements', async () => {
    const user = userEvent.setup();
    mockUseRequirements.mockReturnValue(
      makeQueryResult({
        data: {
          requirements: [],
          broken: [{ file: 'bad.md', error: 'parse error' }],
          incomplete: [],
        },
      }),
    );
    renderWithProviders(<GraphView projectId="proj-1" />);
    const brokenNode = await screen.findByTestId('flow-node-broken-bad.md');
    // not the empty state
    expect(screen.queryByTestId('graph-empty')).not.toBeInTheDocument();
    // broken node has a no-op onClick — clicking it does not open any modal
    await user.click(brokenNode);
    expect(useUiStore.getState().modal).toBeNull();
  });
});
