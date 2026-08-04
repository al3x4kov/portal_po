import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { Criticality, Requirement } from '@po/core';
import { TreeTable } from './TreeTable';
import { renderWithProviders } from '../test/utils';
import { buildForest } from '../lib/tree';
import { computeVisibleRows } from '../lib/visibility';
import { makeReq } from '../test/fixtures';

const NO_CRIT = new Set<Criticality>();

function renderRows(requirements: Requirement[]): void {
  const rows = computeVisibleRows({
    forest: buildForest(requirements),
    search: '',
    collapsed: false,
    expanded: new Set(),
    criticalityFilter: NO_CRIT,
  }).rows;
  renderWithProviders(
    <TreeTable
      title="Функциональные требования"
      addLabel="+ Функция"
      testidPrefix="function"
      count={requirements.length}
      rows={rows}
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

const aiPending = makeReq({ slug: 'ai-1', name: 'ИИ: платежи', origin: 'AI_DOCS' });
const aiChecked = makeReq({
  slug: 'ai-2',
  name: 'ИИ: возвраты',
  origin: 'AI_BACKLOG',
  aiValidated: true,
});
const manual = makeReq({ slug: 'man-1', name: 'Ручное требование' });

describe('TreeTable — подсветка непроверенных ИИ-требований (task26)', () => {
  it('подсвечивает строку и ставит бейдж «ИИ» только у непроверенного ИИ-требования', () => {
    renderRows([aiPending, aiChecked, manual]);

    const pendingRow = screen.getByTestId('tree-row-ai-1');
    expect(pendingRow).toHaveAttribute('data-ai-pending', 'true');
    // Мягкая заливка берётся из существующего токена (читаем в обеих темах).
    expect(pendingRow.getAttribute('style')).toContain('var(--color-warning-bg)');

    const badge = screen.getByTestId('ai-pending-badge');
    expect(pendingRow).toContainElement(badge);
    expect(badge).toHaveTextContent('ИИ');
    // НФТ доступности: цвет не единственный признак — есть текст + расшифровка.
    expect(badge).toHaveAttribute('title', 'Создано ИИ, не проверено');
    expect(badge).toHaveAccessibleName('Создано ИИ, не проверено');
  });

  it('проверенное ИИ-требование выглядит как обычная строка', () => {
    renderRows([aiPending, aiChecked, manual]);

    const checkedRow = screen.getByTestId('tree-row-ai-2');
    expect(checkedRow).not.toHaveAttribute('data-ai-pending');
    expect(checkedRow.getAttribute('style')).not.toContain('var(--color-warning-bg)');
    expect(checkedRow.querySelector('[data-testid="ai-pending-badge"]')).toBeNull();
  });

  it('требование, созданное человеком, не подсвечено и без бейджа', () => {
    renderRows([manual]);

    const row = screen.getByTestId('tree-row-man-1');
    expect(row).not.toHaveAttribute('data-ai-pending');
    expect(screen.queryByTestId('ai-pending-badge')).not.toBeInTheDocument();
  });

  it('бейдж ставится ровно на одну строку из трёх', () => {
    renderRows([aiPending, aiChecked, manual]);
    expect(screen.getAllByTestId('ai-pending-badge')).toHaveLength(1);
    expect(screen.getByTestId('ai-pending-badge')).toHaveAttribute('data-slug', 'ai-1');
  });

  it('подсветка и бейдж описаны только токенами — тёмная тема не ломается', () => {
    // Тема переключается классом .dark на <html>, а токены переопределяются в
    // CSS: если в inline-стилях нет захардкоженных цветов, тема работает.
    document.documentElement.classList.add('dark');
    try {
      renderRows([aiPending]);
      const rowStyle = screen.getByTestId('tree-row-ai-1').getAttribute('style') ?? '';
      const badgeStyle = screen.getByTestId('ai-pending-badge').getAttribute('style') ?? '';
      expect(rowStyle).toContain('var(--color-warning-bg)');
      expect(badgeStyle).toContain('var(--color-warning-fg)');
      for (const style of [rowStyle, badgeStyle]) {
        expect(style).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(style).not.toMatch(/rgb|hsl/i);
      }
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  it('подсветка не ломает разметку строки: имя, критичность и действия на месте', () => {
    renderRows([aiPending]);
    const row = screen.getByTestId('tree-row-ai-1');
    expect(row.querySelector('[data-testid="req-name-ai-1"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="row-actions-ai-1"]')).not.toBeNull();
    expect(row).toHaveTextContent('Средняя');
  });
});
