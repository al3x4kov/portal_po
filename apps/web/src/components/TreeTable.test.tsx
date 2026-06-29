import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TreeTable } from './TreeTable';
import { renderWithProviders } from '../test/utils';
import { useUiStore } from '../store/ui';
import { makeHierarchy, makeReq } from '../test/fixtures';

function renderTree(): void {
  const { parent, child } = makeHierarchy();
  const leaf = makeReq({ id: 'r2', name: 'Возвраты', implemented: false, targetQuarter: 'Q4', targetYear: 2026 });
  renderWithProviders(
    <TreeTable
      title="Функциональные требования"
      addLabel="+ Функция"
      testidPrefix="function"
      requirements={[parent, child, leaf]}
      onAdd={vi.fn()}
      onEdit={vi.fn()}
      onLink={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe('TreeTable (T-604, FR-7)', () => {
  beforeEach(() => useUiStore.setState({ expanded: new Set() }));

  it('renders roots and hides children of a collapsed parent', () => {
    renderTree();
    expect(screen.getByTestId('tree-row-p1')).toBeInTheDocument();
    expect(screen.getByTestId('tree-row-r2')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-row-c1')).not.toBeInTheDocument();
  });

  it('reveals children after expanding the parent node', async () => {
    const user = userEvent.setup();
    renderTree();
    await user.click(screen.getByTestId('tree-toggle-p1'));
    expect(screen.getByTestId('tree-row-c1')).toBeInTheDocument();
    expect(screen.getByText('Оплата картой')).toBeInTheDocument();
  });

  it('shows criticality and implementation badges', () => {
    renderTree();
    // Leaf "Возвраты" is not implemented → shows quarter+year badge.
    const row = screen.getByTestId('tree-row-r2');
    expect(row).toHaveTextContent('Q4 2026');
    expect(row).toHaveTextContent('Medium');
  });
});
