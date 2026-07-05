import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Panel needs a ReactFlow store in the real library — replace it with a plain
// container that keeps the passed props (incl. data-testid). Same approach as
// the other GraphView tests.
vi.mock('@xyflow/react', () => ({
  Panel: ({
    children,
    position: _position,
    ...rest
  }: {
    children?: React.ReactNode;
    position?: string;
  } & Record<string, unknown>) => <div {...rest}>{children}</div>,
}));

import { GraphLegend } from './GraphLegend';

describe('GraphLegend (FR-G7.3, T6 · graph-view mockup §2.20.1)', () => {
  it('renders node types, edge types and the broken-file state with Russian labels', () => {
    render(<GraphLegend />);
    expect(screen.getByTestId('graph-legend')).toBeInTheDocument();
    expect(screen.getByText('ФТ — функциональное')).toBeInTheDocument();
    expect(screen.getByText('НФТ — нефункциональное')).toBeInTheDocument();
    expect(screen.getByText('Иерархия (входит в)')).toBeInTheDocument();
    expect(screen.getByText('Зависит от')).toBeInTheDocument();
    expect(screen.getByText('Блокируется')).toBeInTheDocument();
    expect(screen.getByText('Смысловая связь')).toBeInTheDocument();
    expect(screen.getByText('Битый файл')).toBeInTheDocument();
  });

  it('collapses and expands the entry list via the toggle', async () => {
    const user = userEvent.setup();
    render(<GraphLegend />);
    const toggle = screen.getByTestId('graph-legend-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('▼');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('▶');
    expect(screen.queryByText('Иерархия (входит в)')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Иерархия (входит в)')).toBeInTheDocument();
  });
});
