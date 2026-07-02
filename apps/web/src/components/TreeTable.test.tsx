import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TreeTable } from './TreeTable';
import { renderWithProviders } from '../test/utils';
import { buildForest } from '../lib/tree';
import { computeVisibleRows } from '../lib/visibility';
import { makeHierarchy, makeReq } from '../test/fixtures';
import type { Criticality } from '@po/core';

const NO_CRIT = new Set<Criticality>();

function rowsFor(collapsed: boolean, expanded = new Set<string>()) {
  const { parent, child } = makeHierarchy();
  const leaf = makeReq({
    slug: 'r2',
    name: 'Возвраты',
    implemented: false,
    targetQuarter: 'Q4',
    targetYear: 2026,
  });
  return computeVisibleRows({
    forest: buildForest([parent, child, leaf]),
    search: '',
    collapsed,
    expanded,
    criticalityFilter: NO_CRIT,
  }).rows;
}

function renderTree(collapsed: boolean, expanded = new Set<string>()): void {
  renderWithProviders(
    <TreeTable
      title="Функциональные требования"
      addLabel="+ Функция"
      testidPrefix="function"
      count={3}
      rows={rowsFor(collapsed, expanded)}
      nameBySlug={new Map()}
      onAdd={vi.fn()}
      onEdit={vi.fn()}
      onLink={vi.fn()}
      onDelete={vi.fn()}
      onDescExpand={vi.fn()}
      onExpandNode={vi.fn()}
    />,
  );
}

describe('TreeTable (T-1102, FR-7)', () => {
  it('expand-all (default) renders the full tree including children', () => {
    renderTree(false);
    expect(screen.getByTestId('tree-row-p1')).toBeInTheDocument();
    expect(screen.getByTestId('tree-row-c1')).toBeInTheDocument();
    expect(screen.getByTestId('tree-row-r2')).toBeInTheDocument();
    expect(screen.getByText('Оплата картой')).toBeInTheDocument();
  });

  it('collapse mode hides descendants and shows a dependency chip', () => {
    renderTree(true);
    expect(screen.getByTestId('tree-row-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('tree-row-c1')).not.toBeInTheDocument();
    const chips = screen.getAllByTestId('expand-node');
    expect(chips.length).toBeGreaterThan(0);
    // UX-7: nested children are «подпункты», not «зависимости».
    expect(chips[0]).toHaveTextContent('подпункт');
    expect(chips[0]).not.toHaveTextContent('зависимост');
  });

  it('shows criticality and implementation badges', () => {
    renderTree(false);
    const row = screen.getByTestId('tree-row-r2');
    expect(row).toHaveTextContent('Q4 2026');
    expect(row).toHaveTextContent('Medium');
  });

  it('exposes a description button per row', () => {
    renderTree(false);
    expect(screen.getAllByTestId('desc-expand').length).toBe(3);
  });

  it('renders a description preview inline in the row', () => {
    const req = makeReq({ slug: 'd1', name: 'Отчёты', description: 'Ежемесячная выгрузка в PDF' });
    const rows = computeVisibleRows({
      forest: buildForest([req]),
      search: '',
      collapsed: false,
      expanded: new Set(),
      criticalityFilter: NO_CRIT,
    }).rows;
    renderWithProviders(
      <TreeTable
        title="Ф"
        addLabel="+"
        testidPrefix="function"
        count={1}
        rows={rows}
        nameBySlug={new Map([['d1', 'Отчёты']])}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onLink={vi.fn()}
        onDelete={vi.fn()}
        onDescExpand={vi.fn()}
        onExpandNode={vi.fn()}
      />,
    );
    expect(screen.getByTestId('tree-row-d1')).toHaveTextContent('Ежемесячная выгрузка в PDF');
  });

  it('renders a "Связи" column header in the section', () => {
    renderTree(false);
    const table = screen.getByTestId('table-function');
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) =>
      th.textContent?.trim(),
    );
    expect(headers).toEqual(['Требование', 'Критичность', 'Реализация', 'Связи', 'Описание', '']);
  });

  it('renders relationship chips inside the "Связи" cell, not the name column', () => {
    const a = makeReq({
      slug: 'a1',
      name: 'Оплата',
      links: [
        { type: 'DEPENDS_ON', targetSlug: 'b1' },
        { type: 'RELATES_TO', targetSlug: 'c9' },
      ],
    });
    const rows = computeVisibleRows({
      forest: buildForest([a]),
      search: '',
      collapsed: false,
      expanded: new Set(),
      criticalityFilter: NO_CRIT,
    }).rows;
    renderWithProviders(
      <TreeTable
        title="Ф"
        addLabel="+"
        testidPrefix="function"
        count={1}
        rows={rows}
        nameBySlug={
          new Map([
            ['a1', 'Оплата'],
            ['b1', 'Авторизация'],
            ['c9', 'Аудит-лог'],
          ])
        }
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onLink={vi.fn()}
        onDelete={vi.fn()}
        onDescExpand={vi.fn()}
        onExpandNode={vi.fn()}
      />,
    );
    const dep = screen.getByTestId('rel-chip-a1-b1');
    expect(dep).toHaveAttribute('data-rel-type', 'DEPENDS_ON');
    expect(dep).toHaveTextContent('Авторизация');
    const rel = screen.getByTestId('rel-chip-a1-c9');
    expect(rel).toHaveAttribute('data-rel-type', 'RELATES_TO');
    expect(rel).toHaveTextContent('Аудит-лог');

    // Chips live in the dedicated "Связи" cell, not under the requirement name.
    const linksCell = screen.getByTestId('req-links-cell');
    expect(linksCell.contains(dep)).toBe(true);
    expect(linksCell.contains(rel)).toBe(true);
    const nameCell = screen.getByTestId('req-name-a1').closest('td') as HTMLElement;
    expect(nameCell.contains(dep)).toBe(false);
  });

  it('shows an em dash in the "Связи" cell when a row has no relationship links', () => {
    const req = makeReq({ slug: 'nolinks', name: 'Без связей' });
    const rows = computeVisibleRows({
      forest: buildForest([req]),
      search: '',
      collapsed: false,
      expanded: new Set(),
      criticalityFilter: NO_CRIT,
    }).rows;
    renderWithProviders(
      <TreeTable
        title="Ф"
        addLabel="+"
        testidPrefix="function"
        count={1}
        rows={rows}
        nameBySlug={new Map([['nolinks', 'Без связей']])}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onLink={vi.fn()}
        onDelete={vi.fn()}
        onDescExpand={vi.fn()}
        onExpandNode={vi.fn()}
      />,
    );
    expect(screen.getByTestId('req-links-cell')).toHaveTextContent('—');
    expect(screen.queryByTestId(/^rel-chip-/)).not.toBeInTheDocument();
  });

  it('T4: offers "+ НФТ" on functional rows and reports the source slug', async () => {
    const onAddNfr = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <TreeTable
        title="Функциональные требования"
        addLabel="+ Функция"
        testidPrefix="function"
        count={3}
        rows={rowsFor(false)}
        nameBySlug={new Map()}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onLink={vi.fn()}
        onAddNfr={onAddNfr}
        onDelete={vi.fn()}
        onDescExpand={vi.fn()}
        onExpandNode={vi.fn()}
      />,
    );
    const addButtons = screen.getAllByTestId('row-add-nfr');
    expect(addButtons.length).toBe(3);
    const slugs = addButtons.map((b) => b.getAttribute('data-slug')).sort();
    expect(slugs).toEqual(['c1', 'p1', 'r2']);
    const parentBtn = addButtons.find((b) => b.getAttribute('data-slug') === 'p1')!;
    await user.click(parentBtn);
    expect(onAddNfr).toHaveBeenCalledTimes(1);
    expect(onAddNfr.mock.calls[0][0]).toMatchObject({ slug: 'p1', type: 'FUNCTION' });
  });

  it('a functional row exposes row-add-nfr, link-btn and delete-btn actions', () => {
    const req = makeReq({ slug: 'f1', name: 'Функция', type: 'FUNCTION' });
    const rows = computeVisibleRows({
      forest: buildForest([req]),
      search: '',
      collapsed: false,
      expanded: new Set(),
      criticalityFilter: NO_CRIT,
    }).rows;
    renderWithProviders(
      <TreeTable
        title="Ф"
        addLabel="+"
        testidPrefix="function"
        count={1}
        rows={rows}
        nameBySlug={new Map([['f1', 'Функция']])}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onLink={vi.fn()}
        onAddNfr={vi.fn()}
        onDelete={vi.fn()}
        onDescExpand={vi.fn()}
        onExpandNode={vi.fn()}
      />,
    );
    const rowEl = screen.getByTestId('tree-row-f1');
    expect(rowEl.querySelector('[data-testid="row-add-nfr"]')).not.toBeNull();
    expect(rowEl.querySelector('[data-testid="link-btn-f1"]')).not.toBeNull();
    expect(rowEl.querySelector('[data-testid="delete-btn-f1"]')).not.toBeNull();
  });

  it('UX-1: row actions are visible without hover (not opacity-0) and focus-reachable', () => {
    renderTree(false);
    const actions = screen.getByTestId('row-actions-r2');
    expect(actions.className).not.toContain('opacity-0');
    expect(actions.className).toContain('group-focus-within:opacity-100');
    // The action buttons are always in the DOM inside the row card (keyboard-reachable).
    const rowEl = screen.getByTestId('tree-row-r2');
    expect(rowEl.contains(actions)).toBe(true);
    expect(actions.querySelector('[data-testid="delete-btn-r2"]')).not.toBeNull();
  });

  it('SA-6: renders an incomplete-badge for requirements missing an acceptance criterion', () => {
    const req = makeReq({ slug: 'f1', name: 'Функция без критерия' });
    const rows = computeVisibleRows({
      forest: buildForest([req]),
      search: '',
      collapsed: false,
      expanded: new Set(),
      criticalityFilter: NO_CRIT,
    }).rows;
    renderWithProviders(
      <TreeTable
        title="Ф"
        addLabel="+"
        testidPrefix="function"
        count={1}
        rows={rows}
        nameBySlug={new Map([['f1', 'Функция без критерия']])}
        incompleteSet={new Set(['f1'])}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onLink={vi.fn()}
        onDelete={vi.fn()}
        onDescExpand={vi.fn()}
        onExpandNode={vi.fn()}
      />,
    );
    const badge = screen.getByTestId('incomplete-badge');
    expect(badge).toHaveAttribute('data-slug', 'f1');
    expect(badge).toHaveAttribute('aria-label', 'Нет полного критерия приёмки');
  });

  it('SA-6: renders no incomplete-badge when the slug is not flagged', () => {
    renderTree(false);
    expect(screen.queryByTestId('incomplete-badge')).not.toBeInTheDocument();
  });

  it('UX-7: an interactive chevron toggles the node in collapse mode', async () => {
    const onToggleNode = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <TreeTable
        title="Ф"
        addLabel="+"
        testidPrefix="function"
        count={3}
        rows={rowsFor(true)}
        nameBySlug={new Map()}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onLink={vi.fn()}
        onDelete={vi.fn()}
        onDescExpand={vi.fn()}
        onExpandNode={vi.fn()}
        onToggleNode={onToggleNode}
        interactiveChevron
      />,
    );
    const chevron = screen.getAllByTestId('toggle-node')[0];
    expect(chevron.tagName).toBe('BUTTON');
    expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await user.click(chevron);
    expect(onToggleNode).toHaveBeenCalledWith('p1');
  });

  it('UX-7: the chevron is a non-clickable marker when not interactive (no false affordance)', () => {
    renderTree(false); // expand-all, interactiveChevron not set
    expect(screen.queryByTestId('toggle-node')).not.toBeInTheDocument();
  });

  it('UX-10: the name is an explicit edit affordance and description an expand affordance', () => {
    renderTree(false);
    const name = screen.getByTestId('req-name-p1');
    expect(name).toHaveAttribute('aria-label', expect.stringContaining('Редактировать'));
    const desc = screen.getAllByTestId('desc-expand')[0];
    expect(desc).toHaveAttribute('aria-label', 'Открыть описание');
  });

  it('T4: does not show "+ НФТ" on NFR rows', () => {
    const nfr = makeReq({ slug: 'n1', name: 'Доступность', type: 'NFR' });
    const rows = computeVisibleRows({
      forest: buildForest([nfr]),
      search: '',
      collapsed: false,
      expanded: new Set(),
      criticalityFilter: NO_CRIT,
    }).rows;
    renderWithProviders(
      <TreeTable
        title="НФТ"
        addLabel="+ НФТ"
        testidPrefix="nfr"
        count={1}
        rows={rows}
        nameBySlug={new Map()}
        onAdd={vi.fn()}
        onEdit={vi.fn()}
        onLink={vi.fn()}
        onAddNfr={vi.fn()}
        onDelete={vi.fn()}
        onDescExpand={vi.fn()}
        onExpandNode={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('row-add-nfr')).not.toBeInTheDocument();
  });
});
