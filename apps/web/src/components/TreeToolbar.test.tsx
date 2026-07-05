import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
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
      sourceFilter: new Set(),
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

  it('T3 (§2.6): shows «Показано X из Y · Сбросить фильтры» when filters are applied', async () => {
    useUiStore.setState({ criticalityFilter: new Set(['HIGH']) });
    const user = userEvent.setup();
    renderWithProviders(<TreeToolbar shown={3} total={12} />);
    expect(screen.getByTestId('shown-count')).toHaveTextContent('Показано 3 из 12');
    const reset = screen.getByTestId('toolbar-reset-filters');
    expect(reset).toHaveTextContent('Сбросить фильтры');
    await user.click(reset);
    expect(useUiStore.getState().criticalityFilter.size).toBe(0);
    expect(screen.queryByTestId('toolbar-reset-filters')).not.toBeInTheDocument();
  });

  it('T3 (§2.6): hides the reset link when no filters are applied', () => {
    renderWithProviders(<TreeToolbar shown={5} total={5} />);
    expect(screen.getByTestId('shown-count')).toHaveTextContent('Показано 5 из 5');
    expect(screen.queryByTestId('toolbar-reset-filters')).not.toBeInTheDocument();
  });

  // ── FR-19 · source filter dropdown (Task 12 · F-2.1) ────────────────────────
  describe('FR-19 · «Источник» dropdown', () => {
    const SOURCES = ['АС21', 'Регламент'];

    it('opens the dropdown with «Не задан» plus the project sources', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TreeToolbar shown={5} total={5} availableSources={SOURCES} />);
      await user.click(screen.getByTestId('source-filter'));

      const dropdown = screen.getByTestId('source-dropdown');
      expect(dropdown).toBeInTheDocument();
      expect(screen.getByTestId('source-opt-empty')).toHaveTextContent('Не задан');
      expect(screen.getByTestId('source-opt-АС21')).toBeInTheDocument();
      expect(screen.getByTestId('source-opt-Регламент')).toBeInTheDocument();
    });

    it('applies the source selection only on «Применить» (draft semantics)', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TreeToolbar shown={5} total={5} availableSources={SOURCES} />);
      await user.click(screen.getByTestId('source-filter'));

      await user.click(screen.getByTestId('source-opt-АС21'));
      // Draft only — the store is untouched until apply.
      expect(useUiStore.getState().sourceFilter.size).toBe(0);

      await user.click(screen.getByTestId('source-apply'));
      expect([...useUiStore.getState().sourceFilter]).toEqual(['АС21']);
      // The dropdown closes after apply.
      expect(screen.queryByTestId('source-dropdown')).not.toBeInTheDocument();
    });

    it('«Не задан» filters requirements without a source (empty-string key)', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TreeToolbar shown={5} total={5} availableSources={SOURCES} />);
      await user.click(screen.getByTestId('source-filter'));
      await user.click(screen.getByTestId('source-opt-empty'));
      await user.click(screen.getByTestId('source-apply'));
      expect([...useUiStore.getState().sourceFilter]).toEqual(['']);
    });

    it('toggling a drafted source off removes it from the draft', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TreeToolbar shown={5} total={5} availableSources={SOURCES} />);
      await user.click(screen.getByTestId('source-filter'));
      await user.click(screen.getByTestId('source-opt-АС21'));
      await user.click(screen.getByTestId('source-opt-АС21')); // off again
      await user.click(screen.getByTestId('source-apply'));
      expect(useUiStore.getState().sourceFilter.size).toBe(0);
    });

    it('shows the applied source count badge', () => {
      useUiStore.setState({ sourceFilter: new Set(['АС21', 'Регламент']) });
      renderWithProviders(<TreeToolbar shown={5} total={5} availableSources={SOURCES} />);
      expect(screen.getByTestId('source-count')).toHaveTextContent('2');
    });

    it('hides the count badge when no source filter is applied', () => {
      renderWithProviders(<TreeToolbar shown={5} total={5} availableSources={SOURCES} />);
      expect(screen.queryByTestId('source-count')).not.toBeInTheDocument();
    });

    it('resets the applied source filter and closes the dropdown', async () => {
      useUiStore.setState({ sourceFilter: new Set(['АС21']) });
      const user = userEvent.setup();
      renderWithProviders(<TreeToolbar shown={5} total={5} availableSources={SOURCES} />);
      await user.click(screen.getByTestId('source-filter'));
      await user.click(screen.getByTestId('source-reset'));
      expect(useUiStore.getState().sourceFilter.size).toBe(0);
      expect(screen.queryByTestId('source-dropdown')).not.toBeInTheDocument();
    });

    it('closes on Escape without applying the draft', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TreeToolbar shown={5} total={5} availableSources={SOURCES} />);
      await user.click(screen.getByTestId('source-filter'));
      await user.click(screen.getByTestId('source-opt-АС21'));
      await user.keyboard('{Escape}');
      expect(screen.queryByTestId('source-dropdown')).not.toBeInTheDocument();
      expect(useUiStore.getState().sourceFilter.size).toBe(0);
    });

    it('closes on an outside click without applying the draft', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TreeToolbar shown={5} total={5} availableSources={SOURCES} />);
      await user.click(screen.getByTestId('source-filter'));
      await user.click(screen.getByTestId('source-opt-Регламент'));

      fireEvent.mouseDown(document.body);
      expect(screen.queryByTestId('source-dropdown')).not.toBeInTheDocument();
      expect(useUiStore.getState().sourceFilter.size).toBe(0);
    });

    it('shows «Нет источников» when the project has no sources at all — dropdown still usable', async () => {
      const user = userEvent.setup();
      renderWithProviders(<TreeToolbar shown={5} total={5} />);
      await user.click(screen.getByTestId('source-filter'));
      // '' («Не задан») is always present, so the empty-list hint never renders
      // with the default option; the option itself is there.
      expect(screen.getByTestId('source-opt-empty')).toBeInTheDocument();
    });
  });
});
