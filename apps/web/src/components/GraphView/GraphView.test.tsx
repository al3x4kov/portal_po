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
    children,
  }: {
    nodes: Array<{ id: string; data: { slug: string } }>;
    children?: React.ReactNode;
  }) => (
    <div data-testid="mock-react-flow">
      {nodes.map((n) => (
        <div key={n.id} data-testid={`flow-node-${n.data.slug}`} />
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
        const children = (graph.children ?? []).map(
          (child: { id: string }, i: number) => ({
            ...child,
            x: i * 260,
            y: 0,
          }),
        );
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

function makeQueryResult(overrides: Partial<{
  isLoading: boolean;
  isError: boolean;
  data: RequirementListResult | undefined;
}> = {}) {
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
});
