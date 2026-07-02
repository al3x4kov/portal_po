import { describe, it, expect, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TreeToolbar } from './TreeToolbar';
import { renderWithProviders } from '../test/utils';
import { useUiStore } from '../store/ui';

describe('TreeToolbar (T-1101/1103/1105)', () => {
  beforeEach(() =>
    useUiStore.setState({
      treeMode: 'expand-all',
      search: '',
      criticalityFilter: new Set(),
      implementationFilter: new Set(),
      expanded: new Set(),
    }),
  );

  it('toggles the tree display mode (T-1101)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TreeToolbar shown={5} total={5} />);
    expect(useUiStore.getState().treeMode).toBe('expand-all');
    await user.click(screen.getByTestId('toggle-collapse'));
    expect(useUiStore.getState().treeMode).toBe('collapse');
    await user.click(screen.getByTestId('toggle-expand-all'));
    expect(useUiStore.getState().treeMode).toBe('expand-all');
  });

  it('updates and clears the search query (T-1103)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TreeToolbar shown={5} total={5} />);
    await user.type(screen.getByTestId('search-input'), 'токен');
    expect(useUiStore.getState().search).toBe('токен');
    await user.click(screen.getByTestId('search-clear'));
    expect(useUiStore.getState().search).toBe('');
  });

  it('applies a multi-select criticality filter only on "Применить" (T-1105)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TreeToolbar shown={5} total={5} />);
    await user.click(screen.getByTestId('criticality-filter'));
    expect(screen.getByTestId('criticality-dropdown')).toBeInTheDocument();

    // Selecting a checkbox is a draft — not applied yet.
    await user.click(screen.getByTestId('crit-opt-high'));
    await user.click(screen.getByTestId('crit-opt-critical'));
    expect(useUiStore.getState().criticalityFilter.size).toBe(0);

    await user.click(screen.getByTestId('crit-apply'));
    expect([...useUiStore.getState().criticalityFilter].sort()).toEqual(['CRITICAL', 'HIGH']);
  });

  it('offers the Blocker criticality option in the filter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TreeToolbar shown={5} total={5} />);
    await user.click(screen.getByTestId('criticality-filter'));
    const blocker = screen.getByTestId('crit-opt-blocker');
    expect(blocker).toBeInTheDocument();
    await user.click(blocker);
    await user.click(screen.getByTestId('crit-apply'));
    expect([...useUiStore.getState().criticalityFilter]).toEqual(['BLOCKER']);
  });

  it('resets the applied criticality filter (T-1105)', async () => {
    useUiStore.setState({ criticalityFilter: new Set(['HIGH']) });
    const user = userEvent.setup();
    renderWithProviders(<TreeToolbar shown={5} total={5} />);
    await user.click(screen.getByTestId('criticality-filter'));
    await user.click(screen.getByTestId('crit-reset'));
    expect(useUiStore.getState().criticalityFilter.size).toBe(0);
  });

  it('renders the shown/total counter', () => {
    renderWithProviders(<TreeToolbar shown={4} total={11} />);
    expect(screen.getByTestId('shown-count')).toHaveTextContent('Показано 4 из 11');
  });

  it('applies a multi-select implementation filter only on "Применить" (T1)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TreeToolbar shown={5} total={5} />);
    await user.click(screen.getByTestId('impl-filter'));
    expect(screen.getByTestId('impl-dropdown')).toBeInTheDocument();

    // Selecting a checkbox is a draft — not applied yet.
    await user.click(screen.getByTestId('impl-opt-planned'));
    expect(useUiStore.getState().implementationFilter.size).toBe(0);

    await user.click(screen.getByTestId('impl-apply'));
    expect([...useUiStore.getState().implementationFilter]).toEqual(['PLANNED']);
  });

  it('shows the applied implementation count badge (T1)', () => {
    useUiStore.setState({ implementationFilter: new Set(['DONE', 'PLANNED']) });
    renderWithProviders(<TreeToolbar shown={5} total={5} />);
    expect(screen.getByTestId('impl-count')).toHaveTextContent('2');
  });

  it('resets the applied implementation filter (T1)', async () => {
    useUiStore.setState({ implementationFilter: new Set(['DONE']) });
    const user = userEvent.setup();
    renderWithProviders(<TreeToolbar shown={5} total={5} />);
    await user.click(screen.getByTestId('impl-filter'));
    await user.click(screen.getByTestId('impl-reset'));
    expect(useUiStore.getState().implementationFilter.size).toBe(0);
  });
});
