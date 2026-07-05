import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequirementPickerModal } from './RequirementPickerModal';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';

const requirements = [
  makeReq({ slug: 'f1', name: 'Оплата', type: 'FUNCTION' }),
  makeReq({ slug: 'f2', name: 'Возвраты', type: 'FUNCTION' }),
];

describe('RequirementPickerModal', () => {
  it('explains why the confirm button is disabled when nothing is selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementPickerModal
        title="Выбор требований"
        requirements={requirements}
        initialSelected={new Set()}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    // 0 selected → confirm disabled with a visible reason.
    expect(screen.getByTestId('export-next')).toBeDisabled();
    expect(screen.getByTestId('export-next-hint')).toHaveTextContent(
      'Выберите хотя бы одно требование',
    );

    // Select all → hint disappears, button enables.
    await user.click(screen.getByTestId('export-toggle-all'));
    expect(screen.queryByTestId('export-next-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('export-next')).toBeEnabled();
  });

  it('renders named filter groups', () => {
    renderWithProviders(
      <RequirementPickerModal
        title="Выбор требований"
        requirements={[
          makeReq({ slug: 'f1', name: 'Оплата', type: 'FUNCTION', source: 'АС21' }),
          makeReq({ slug: 'f2', name: 'Возвраты', type: 'FUNCTION', source: 'Регламент' }),
        ]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    // Each filter group has its own heading. «Источник» is present because
    // there are 2+ distinct sources.
    expect(screen.getByRole('group', { name: 'Критичность' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Реализация' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Источник' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Выбор' })).toBeInTheDocument();

    // «Выбор» group owns the toggle-all control and the counter.
    const selectGroup = screen.getByRole('group', { name: 'Выбор' });
    expect(selectGroup).toContainElement(screen.getByTestId('export-toggle-all'));
  });

  it('does not show the «Источник» group when there is a single distinct source', () => {
    renderWithProviders(
      <RequirementPickerModal
        title="Выбор требований"
        requirements={[
          makeReq({ slug: 'f1', name: 'Оплата', type: 'FUNCTION', source: 'АС21' }),
          makeReq({ slug: 'f2', name: 'Возвраты', type: 'FUNCTION', source: 'ас21' }),
        ]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    // Two rows but only one normalized source → group hidden.
    expect(screen.queryByRole('group', { name: 'Источник' })).not.toBeInTheDocument();
  });

  it('treats sources differing only by case as one, and filters both', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementPickerModal
        title="Выбор требований"
        requirements={[
          makeReq({ slug: 'f1', name: 'Оплата', type: 'FUNCTION', source: 'АС21' }),
          makeReq({ slug: 'f2', name: 'Возвраты', type: 'FUNCTION', source: 'ас21' }),
          makeReq({ slug: 'f3', name: 'Отчёты', type: 'FUNCTION', source: 'Регламент' }),
        ]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    // «АС21» and «ас21» collapse to a single chip with the canonical label.
    const chips = screen.getAllByTestId(/^export-filter-src-/);
    const labels = chips.map((c) => c.textContent);
    expect(labels.filter((l) => l && /ас21/i.test(l))).toHaveLength(1);
    // Canonical label is the first original spelling seen.
    expect(screen.getByTestId('export-filter-src-АС21')).toBeInTheDocument();

    // Filtering by that chip catches BOTH «АС21» and «ас21» rows,
    // but excludes the «Регламент» row.
    await user.click(screen.getByTestId('export-filter-src-АС21'));
    expect(screen.getByTestId('export-item-f1')).toBeInTheDocument();
    expect(screen.getByTestId('export-item-f2')).toBeInTheDocument();
    expect(screen.queryByTestId('export-item-f3')).not.toBeInTheDocument();
  });

  // ── Task 12 · F-2.2: filter/selection branches ─────────────────────────────
  describe('implementation & quarter filters', () => {
    const plannedQ1 = makeReq({
      slug: 'f1',
      name: 'Оплата',
      type: 'FUNCTION',
      implemented: false,
      targetQuarter: 'Q1',
      targetYear: 2027,
    });
    const plannedQ2 = makeReq({
      slug: 'f2',
      name: 'Возвраты',
      type: 'FUNCTION',
      implemented: false,
      targetQuarter: 'Q2',
      targetYear: 2027,
    });
    const done = makeReq({ slug: 'f3', name: 'Отчёты', type: 'FUNCTION', implemented: true });
    const plannedNoQuarter = makeReq({
      slug: 'f4',
      name: 'Аудит',
      type: 'FUNCTION',
      implemented: false,
    });

    function renderPicker(onConfirm = vi.fn()) {
      renderWithProviders(
        <RequirementPickerModal
          title="Выбор требований"
          requirements={[plannedQ1, plannedQ2, done, plannedNoQuarter]}
          onClose={vi.fn()}
          onConfirm={onConfirm}
        />,
      );
      return onConfirm;
    }

    it('«Реализовано» keeps only implemented requirements', async () => {
      const user = userEvent.setup();
      renderPicker();
      await user.click(screen.getByTestId('export-filter-impl-done'));
      expect(screen.getByTestId('export-item-f3')).toBeInTheDocument();
      expect(screen.queryByTestId('export-item-f1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('export-item-f2')).not.toBeInTheDocument();
    });

    it('«Запланировано» shows quarter chips; a chip narrows to its quarter and drops rows without a quarter', async () => {
      const user = userEvent.setup();
      renderPicker();

      // Chips are hidden while the filter is 'all'.
      expect(screen.queryByTestId('export-filter-q-Q1-2027')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('export-filter-impl-planned'));
      expect(screen.getByTestId('export-filter-q-Q1-2027')).toBeInTheDocument();
      expect(screen.getByTestId('export-filter-q-Q2-2027')).toBeInTheDocument();
      // planned filter alone: implemented row gone, all planned rows present.
      expect(screen.queryByTestId('export-item-f3')).not.toBeInTheDocument();
      expect(screen.getByTestId('export-item-f4')).toBeInTheDocument();

      await user.click(screen.getByTestId('export-filter-q-Q1-2027'));
      expect(screen.getByTestId('export-item-f1')).toBeInTheDocument();
      expect(screen.queryByTestId('export-item-f2')).not.toBeInTheDocument();
      // f4 has no targetQuarter/Year → excluded once a quarter is chosen.
      expect(screen.queryByTestId('export-item-f4')).not.toBeInTheDocument();

      // Toggling the chip off restores the other planned rows.
      await user.click(screen.getByTestId('export-filter-q-Q1-2027'));
      expect(screen.getByTestId('export-item-f2')).toBeInTheDocument();
      expect(screen.getByTestId('export-item-f4')).toBeInTheDocument();
    });

    it('switching the implementation filter resets the chosen quarters', async () => {
      const user = userEvent.setup();
      renderPicker();
      await user.click(screen.getByTestId('export-filter-impl-planned'));
      await user.click(screen.getByTestId('export-filter-q-Q1-2027'));
      expect(screen.queryByTestId('export-item-f2')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('export-filter-impl-all'));
      // Everything is visible again — the quarter filter did not survive.
      expect(screen.getByTestId('export-item-f1')).toBeInTheDocument();
      expect(screen.getByTestId('export-item-f2')).toBeInTheDocument();
      expect(screen.getByTestId('export-item-f3')).toBeInTheDocument();
    });

    it('shows an explicit empty state when filters match nothing', async () => {
      const user = userEvent.setup();
      renderWithProviders(
        <RequirementPickerModal
          title="Выбор требований"
          requirements={[done]}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
      await user.click(screen.getByTestId('export-filter-impl-planned'));
      expect(screen.getByText('Нет требований, подходящих под фильтры.')).toBeInTheDocument();
    });

    it('planned rows show their quarter next to the criticality', () => {
      renderPicker();
      expect(screen.getByTestId('export-item-f1')).toHaveTextContent('Q1 2027');
    });
  });

  describe('selection behaviour', () => {
    it('selects everything by default (no initialSelected) and confirms with the full set', async () => {
      const onConfirm = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(
        <RequirementPickerModal
          title="Выбор требований"
          requirements={requirements}
          onClose={vi.fn()}
          onConfirm={onConfirm}
        />,
      );
      const confirm = screen.getByTestId('export-next');
      expect(confirm).toBeEnabled();
      expect(confirm).toHaveTextContent('(2)');

      await user.click(confirm);
      expect(onConfirm).toHaveBeenCalledWith(new Set(['f1', 'f2']));
    });

    it('unchecking a row removes it from the confirmed set; re-checking restores it', async () => {
      const onConfirm = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(
        <RequirementPickerModal
          title="Выбор требований"
          requirements={requirements}
          onClose={vi.fn()}
          onConfirm={onConfirm}
        />,
      );

      const rowCheckbox = screen.getByTestId('export-item-f2').querySelector('input')!;
      await user.click(rowCheckbox);
      expect(screen.getByTestId('export-next')).toHaveTextContent('(1)');
      await user.click(rowCheckbox);
      expect(screen.getByTestId('export-next')).toHaveTextContent('(2)');

      await user.click(screen.getByTestId('export-next'));
      expect(onConfirm).toHaveBeenCalledWith(new Set(['f1', 'f2']));
    });

    it('T4: «Выбрать все» и «Снять выделение» — две отдельные кнопки (picker-modal mockup)', async () => {
      const user = userEvent.setup();
      renderWithProviders(
        <RequirementPickerModal
          title="Выбор требований"
          requirements={requirements}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
      const selectAll = screen.getByTestId('export-toggle-all');
      const deselectAll = screen.getByTestId('export-untoggle-all');
      expect(selectAll).toHaveTextContent('Выбрать все');
      expect(deselectAll).toHaveTextContent('Снять выделение');
      // All selected by default → «Выбрать все» is redundant and disabled.
      expect(selectAll).toBeDisabled();

      await user.click(deselectAll);
      expect(screen.getByTestId('export-next')).toBeDisabled();
      expect(screen.getByTestId('picker-counter')).toHaveTextContent('Выбрано 0');

      await user.click(selectAll);
      expect(screen.getByTestId('export-next')).toBeEnabled();
      expect(screen.getByTestId('picker-counter')).toHaveTextContent('Выбрано 2');
    });

    it('T4: поиск по имени фильтрует список; счётчик показывает «(из них видно…)» и hint о невидимых выбранных', async () => {
      const user = userEvent.setup();
      renderWithProviders(
        <RequirementPickerModal
          title="Выбор требований"
          requirements={requirements}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );

      // Everything selected; the search hides «Возвраты» but keeps it selected.
      await user.type(screen.getByTestId('picker-search'), 'Оплата');
      expect(screen.getByTestId('export-item-f1')).toBeInTheDocument();
      expect(screen.queryByTestId('export-item-f2')).not.toBeInTheDocument();

      // §2.12.1: two-part counter + warning that hidden rows stay selected.
      expect(screen.getByTestId('picker-counter')).toHaveTextContent('Выбрано 2 (из них видно 1)');
      expect(screen.getByTestId('picker-hidden-hint')).toHaveTextContent(
        'Невидимые из-за фильтра требования остаются выбранными — в экспорт попадут все 2.',
      );
      // Footer names how many rows the filters hid.
      expect(screen.getByTestId('picker-hidden-count')).toHaveTextContent(
        '1 требование скрыто фильтрами',
      );

      // «Сбросить» clears the filters and the hint disappears.
      await user.click(screen.getByTestId('picker-filters-reset'));
      expect(screen.getByTestId('export-item-f2')).toBeInTheDocument();
      expect(screen.queryByTestId('picker-hidden-hint')).not.toBeInTheDocument();
      expect(screen.getByTestId('picker-counter')).toHaveTextContent('Выбрано 2');
    });

    it('T4: критичность в строках — русский бейдж, не сырой enum', () => {
      renderWithProviders(
        <RequirementPickerModal
          title="Выбор требований"
          requirements={[
            makeReq({ slug: 'f1', name: 'Оплата', type: 'FUNCTION', criticality: 'CRITICAL' }),
          ]}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
      const row = screen.getByTestId('export-item-f1');
      expect(row).toHaveTextContent('Критическая');
      expect(row).not.toHaveTextContent('CRITICAL');
    });

    it('renders the ФТ hierarchy with tree markers («▾» for parents, «•» for leaves)', () => {
      const parent = makeReq({
        slug: 'p1',
        name: 'Платежи',
        links: [{ type: 'PARENT_OF', targetSlug: 'c1' }],
      });
      const child = makeReq({
        slug: 'c1',
        name: 'Оплата картой',
        links: [{ type: 'CHILD_OF', targetSlug: 'p1' }],
      });
      renderWithProviders(
        <RequirementPickerModal
          title="Выбор требований"
          requirements={[parent, child]}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
      expect(screen.getByTestId('export-item-p1')).toHaveTextContent('▾');
      expect(screen.getByTestId('export-item-c1')).toHaveTextContent('•');
    });

    it('lists NFRs in their own flat section with a planned quarter suffix', () => {
      const nfr = makeReq({
        slug: 'n1',
        name: 'Надёжность',
        type: 'NFR',
        implemented: false,
        targetQuarter: 'Q3',
        targetYear: 2026,
      });
      renderWithProviders(
        <RequirementPickerModal
          title="Выбор требований"
          requirements={[...requirements, nfr]}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
      expect(screen.getByText(/Нефункциональные требования \(1\)/)).toBeInTheDocument();
      expect(screen.getByTestId('export-item-n1')).toHaveTextContent('Q3 2026');
    });
  });

  it('keeps existing criticality and select-all behaviour working', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RequirementPickerModal
        title="Выбор требований"
        requirements={[
          makeReq({ slug: 'f1', name: 'Оплата', type: 'FUNCTION', criticality: 'CRITICAL' }),
          makeReq({ slug: 'f2', name: 'Возвраты', type: 'FUNCTION', criticality: 'LOW' }),
        ]}
        initialSelected={new Set()}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    // Filter by criticality CRITICAL → only f1 remains.
    await user.click(screen.getByTestId('export-filter-crit-CRITICAL'));
    expect(screen.getByTestId('export-item-f1')).toBeInTheDocument();
    expect(screen.queryByTestId('export-item-f2')).not.toBeInTheDocument();

    // Toggle-all selects the visible (filtered) row.
    await user.click(screen.getByTestId('export-toggle-all'));
    expect(screen.getByTestId('export-next')).toBeEnabled();
  });
});
