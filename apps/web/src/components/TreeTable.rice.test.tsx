import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Criticality, SourcePriority } from '@po/core';
import { TreeTable } from './TreeTable';
import { renderWithProviders } from '../test/utils';
import { buildForest } from '../lib/tree';
import { computeVisibleRows } from '../lib/visibility';
import { makeReq } from '../test/fixtures';

const NO_CRIT = new Set<Criticality>();

const PRIORITIES: SourcePriority[] = [
  { id: 'p-crit', name: 'Критично для сделки', color: 'red', order: 0 },
  { id: 'default', name: 'Квартальная цель', color: 'amber', order: 1 },
  { id: 'p-wish', name: 'Пожелание', color: 'gray', order: 2 },
];

function reqWith(slug: string, name: string, over: Parameters<typeof makeReq>[0]) {
  return makeReq({ ...over, slug, name });
}

function renderRows(reqs: ReturnType<typeof makeReq>[]) {
  const rows = computeVisibleRows({
    forest: buildForest(reqs),
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
      count={reqs.length}
      rows={rows}
      nameBySlug={new Map(reqs.map((r) => [r.slug, r.name]))}
      priorities={PRIORITIES}
      onAdd={vi.fn()}
      onEdit={vi.fn()}
      onLink={vi.fn()}
      onDelete={vi.fn()}
      onDescExpand={vi.fn()}
      onExpandNode={vi.fn()}
    />,
  );
}

describe('TreeTable RICE / sources / term columns (T-207)', () => {
  it('shows aggregate RICE (max across sources) and «—» when none', () => {
    const scored = reqWith('a', 'Экспорт', {
      slug: 'a',
      name: 'Экспорт',
      sources: [
        {
          type: 'CLIENT',
          name: 'Альфа',
          priorityId: 'p-crit',
          rice: { reach: 4, impact: 3, confidence: 0.8, effort: 3 }, // 3.2
        },
        {
          type: 'STAKEHOLDER',
          name: 'Иванов',
          priorityId: 'default',
          rice: { reach: 3, impact: 2, confidence: 0.8, effort: 2 }, // 2.4
        },
      ],
    });
    const none = reqWith('b', 'Тёмная тема', { slug: 'b', name: 'Тёмная тема' });
    renderRows([scored, none]);
    expect(within(screen.getByTestId('tree-row-a')).getByTestId('req-rice-cell')).toHaveTextContent(
      '3.2',
    );
    expect(within(screen.getByTestId('tree-row-b')).getByTestId('req-rice-cell')).toHaveTextContent(
      '—',
    );
  });

  it('shows the senior source + priority badge + «+N» for extra sources', () => {
    const req = reqWith('a', 'Экспорт', {
      slug: 'a',
      name: 'Экспорт',
      sources: [
        { type: 'CLIENT', name: 'Альфа', priorityId: 'p-crit' },
        { type: 'STAKEHOLDER', name: 'Иванов', priorityId: 'default' },
      ],
    });
    renderRows([req]);
    const cell = screen.getByTestId('req-sources-cell');
    expect(cell).toHaveTextContent('Альфа');
    expect(screen.getByTestId('req-priority-badge-a')).toHaveTextContent('Критично для сделки');
    const extra = screen.getByTestId('req-sources-extra-a');
    expect(extra).toHaveTextContent('+1');
    expect(extra).toHaveAttribute('title', expect.stringContaining('Иванов'));
  });

  it('renders a two-level term cell: plan + release, and «Реализовано»', () => {
    const planned = reqWith('a', 'Экспорт', {
      slug: 'a',
      name: 'Экспорт',
      implemented: false,
      targetQuarter: 'Q3',
      targetYear: 2026,
      releaseDate: '2026-09-01',
    });
    const done = reqWith('b', 'Готово', { slug: 'b', name: 'Готово', implemented: true });
    renderRows([planned, done]);
    const planCell = within(screen.getByTestId('tree-row-a')).getByTestId('req-term-cell');
    expect(planCell).toHaveTextContent('Q3 2026');
    expect(planCell).toHaveTextContent('выпуск 2026-09-01');
    expect(within(screen.getByTestId('tree-row-b')).getByTestId('req-term-cell')).toHaveTextContent(
      'Реализовано',
    );
  });

  it('sorts by RICE (undefined last) when the header is toggled', async () => {
    const user = userEvent.setup();
    const low = reqWith('low', 'Низкий', {
      slug: 'low',
      name: 'Низкий',
      sources: [
        {
          type: 'CLIENT',
          name: 'A',
          priorityId: 'default',
          rice: { reach: 1, impact: 1, confidence: 1, effort: 8 },
        },
      ],
    });
    const high = reqWith('high', 'Высокий', {
      slug: 'high',
      name: 'Высокий',
      sources: [
        {
          type: 'CLIENT',
          name: 'B',
          priorityId: 'default',
          rice: { reach: 5, impact: 3, confidence: 1, effort: 1 },
        },
      ],
    });
    const none = reqWith('none', 'Без оценки', { slug: 'none', name: 'Без оценки' });
    renderRows([low, none, high]);
    await user.click(screen.getByTestId('sort-rice-function'));
    const rows = screen.getAllByTestId(/^tree-row-/);
    const order = rows.map((r) => r.getAttribute('data-testid'));
    expect(order).toEqual(['tree-row-high', 'tree-row-low', 'tree-row-none']);
  });
});
