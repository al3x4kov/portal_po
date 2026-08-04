import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { Main } from './Main';
import { renderWithProviders } from '../test/utils';
import { useUiStore } from '../store/ui';
import { makeReq } from '../test/fixtures';

const getProject = vi.fn();
const listRequirements = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    get: (...a: unknown[]) => getProject(...a),
    export: vi.fn(),
    exportXlsx: vi.fn(),
    exportSelected: vi.fn(),
  },
  requirementsApi: {
    list: (...a: unknown[]) => listRequirements(...a),
    checkName: vi.fn().mockResolvedValue({ available: true, slug: 'x' }),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  linksApi: { create: vi.fn(), remove: vi.fn() },
  dictionariesApi: {
    get: vi.fn().mockResolvedValue({ priorities: [], sources: [] }),
  },
  aiApi: {
    getConfig: vi.fn().mockResolvedValue({ baseURL: 'https://ai', hasApiKey: true }),
    listModels: vi.fn().mockResolvedValue({ models: [] }),
  },
  aiImportApi: { start: vi.fn(), getJob: vi.fn(), cancel: vi.fn() },
}));

/**
 * ФТ: Платежи (человек) → Оплата картой (ИИ, не проверено)
 *     Возвраты (ИИ, проверено человеком)
 * НФТ: Доступность (ИИ, не проверено)
 */
const requirements = [
  makeReq({
    slug: 'pay',
    name: 'Платежи',
    criticality: 'CRITICAL',
    links: [{ type: 'PARENT_OF', targetSlug: 'card' }],
  }),
  makeReq({
    slug: 'card',
    name: 'Оплата картой',
    origin: 'AI_DOCS',
    links: [{ type: 'CHILD_OF', targetSlug: 'pay' }],
  }),
  makeReq({ slug: 'refund', name: 'Возвраты', origin: 'AI_BACKLOG', aiValidated: true }),
  makeReq({ slug: 'sla', type: 'NFR', name: 'Доступность 99.95%', origin: 'AI_DOCS' }),
];

function renderMain(): void {
  renderWithProviders(
    <Routes>
      <Route path="/p/:id" element={<Main />} />
    </Routes>,
    { route: '/p/proj-1' },
  );
}

describe('Main — фильтр и счётчик непроверенных ИИ-требований (task26)', () => {
  beforeEach(() => {
    getProject.mockReset();
    listRequirements.mockReset();
    getProject.mockResolvedValue({
      id: 'proj-1',
      name: 'payments',
      mainPath: '/Projects/payments',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    listRequirements.mockResolvedValue({ requirements, broken: [] });
    useUiStore.setState({
      treeMode: 'expand-all',
      search: '',
      criticalityFilter: new Set(),
      implementationFilter: new Set(),
      sourceFilter: new Set(),
      aiPendingFilter: false,
      expanded: new Set(),
      collapsedOverrides: new Set(),
      modal: null,
      mainView: 'tree',
      graphView: false,
    });
  });

  it('счётчик считает непроверенные по обоим разделам (ФТ + НФТ)', async () => {
    renderMain();
    const counter = await screen.findByTestId('ai-pending-count');
    // card (ФТ) + sla (НФТ); refund проверен, pay создан человеком.
    expect(counter).toHaveTextContent('Не проверено: 2');
    expect(counter).toHaveAttribute('data-count', '2');
  });

  it('подсвечивает только непроверенные ИИ-строки в обоих деревьях', async () => {
    renderMain();
    expect(await screen.findByTestId('tree-row-card')).toHaveAttribute('data-ai-pending', 'true');
    expect(screen.getByTestId('tree-row-sla')).toHaveAttribute('data-ai-pending', 'true');
    expect(screen.getByTestId('tree-row-refund')).not.toHaveAttribute('data-ai-pending');
    expect(screen.getByTestId('tree-row-pay')).not.toHaveAttribute('data-ai-pending');
    expect(screen.getAllByTestId('ai-pending-badge')).toHaveLength(2);
  });

  it('фильтр оставляет непроверенные строки и их предков для контекста', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-card');

    await user.click(screen.getByTestId('filter-ai-pending'));

    expect(screen.getByTestId('filter-ai-pending')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('tree-row-card')).toBeInTheDocument();
    expect(screen.getByTestId('tree-row-sla')).toBeInTheDocument();
    // Предок остаётся как контекст (помечен «предок»), проверенное/ручное — уходят.
    expect(screen.getByTestId('tree-row-pay')).toHaveAttribute('data-row-kind', 'context');
    expect(screen.queryByTestId('tree-row-refund')).not.toBeInTheDocument();
    // Счётчик проекта не зависит от фильтров.
    expect(screen.getByTestId('ai-pending-count')).toHaveTextContent('Не проверено: 2');
  });

  it('клик по счётчику включает фильтр', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-card');
    expect(screen.getByTestId('filter-ai-pending')).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByTestId('ai-pending-count'));

    expect(screen.getByTestId('filter-ai-pending')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('tree-row-refund')).not.toBeInTheDocument();
  });

  it('пересекается с поиском (AND), как остальные фильтры', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-card');

    await user.click(screen.getByTestId('filter-ai-pending'));
    await user.type(screen.getByTestId('search-input'), 'Доступность');

    await waitFor(() => expect(screen.queryByTestId('tree-row-card')).not.toBeInTheDocument());
    expect(screen.getByTestId('tree-row-sla')).toBeInTheDocument();
  });

  it('учитывается в общем счётчике активных фильтров и сбрасывается «Сбросить фильтры»', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-card');

    await user.click(screen.getByTestId('filter-ai-pending'));
    expect(screen.getByTestId('filter-active-count')).toHaveTextContent('1');

    await user.click(screen.getByTestId('toolbar-reset-filters'));
    expect(screen.getByTestId('filter-ai-pending')).toHaveAttribute('aria-pressed', 'false');
    expect(await screen.findByTestId('tree-row-refund')).toBeInTheDocument();
  });

  it('счётчик скрыт, когда непроверенных нет (старый проект без ИИ-полей)', async () => {
    listRequirements.mockResolvedValue({
      requirements: [makeReq({ slug: 'pay', name: 'Платежи' })],
      broken: [],
    });
    renderMain();
    await screen.findByTestId('tree-row-pay');

    expect(screen.queryByTestId('ai-pending-count')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-pending-badge')).not.toBeInTheDocument();
    expect(screen.getByTestId('tree-row-pay')).not.toHaveAttribute('data-ai-pending');
  });
});
