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
const exportArchive = vi.fn();
const exportXlsx = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    get: (...a: unknown[]) => getProject(...a),
    export: (...a: unknown[]) => exportArchive(...a),
    exportXlsx: (...a: unknown[]) => exportXlsx(...a),
  },
  requirementsApi: {
    list: (...a: unknown[]) => listRequirements(...a),
    checkName: vi.fn().mockResolvedValue({ available: true, slug: 'x' }),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  linksApi: { create: vi.fn(), remove: vi.fn() },
}));

const requirements = [
  makeReq({
    slug: 'pay',
    name: 'Платежи',
    criticality: 'CRITICAL',
    description: 'Приём и обработка входящих платежей.',
    links: [{ type: 'PARENT_OF', targetSlug: 'token' }],
  }),
  makeReq({
    slug: 'token',
    name: 'Сохранение карты токенизация',
    criticality: 'HIGH',
    description: 'PCI-DSS токенизация: хранение токена вместо PAN. ' + 'Длинный текст. '.repeat(30),
    links: [{ type: 'CHILD_OF', targetSlug: 'pay' }],
  }),
  makeReq({ slug: 'sla', type: 'NFR', name: 'Доступность 99.95%', criticality: 'HIGH' }),
];

function renderMain(): void {
  renderWithProviders(
    <Routes>
      <Route path="/p/:id" element={<Main />} />
    </Routes>,
    { route: '/p/proj-1' },
  );
}

describe('Main page (E11 integration)', () => {
  beforeEach(() => {
    getProject.mockReset();
    listRequirements.mockReset();
    exportArchive.mockReset();
    exportXlsx.mockReset();
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
      expanded: new Set(),
      modal: null,
    });
  });

  it('UX-8: Excel export is a button routed through the same fetch/blob path (D7)', async () => {
    // never resolves during the assertion window → keeps the busy state on
    exportXlsx.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderMain();
    const xlsx = await screen.findByTestId('export-xlsx');
    expect(xlsx.tagName).toBe('BUTTON');
    expect(xlsx).not.toHaveAttribute('href');
    await user.click(xlsx);
    expect(exportXlsx).toHaveBeenCalledWith('proj-1');
  });

  it('UX-8: an xlsx export error is surfaced like the archive exports', async () => {
    exportXlsx.mockRejectedValueOnce(new Error('Не удалось собрать Excel'));
    const user = userEvent.setup();
    renderMain();
    await user.click(await screen.findByTestId('export-xlsx'));
    expect(await screen.findByTestId('export-error')).toHaveTextContent('Не удалось собрать Excel');
  });

  it('UX-8: all three export buttons are disabled while an export is in flight', async () => {
    exportXlsx.mockReturnValue(new Promise(() => {})); // stays pending
    const user = userEvent.setup();
    renderMain();
    await user.click(await screen.findByTestId('export-xlsx'));
    expect(await screen.findByTestId('export-busy')).toBeInTheDocument();
    expect(screen.getByTestId('export-xlsx')).toBeDisabled();
    expect(screen.getByTestId('export-zip')).toBeDisabled();
    expect(screen.getByTestId('export-targz')).toBeDisabled();
  });

  it('renders both requirement sections after loading', async () => {
    renderMain();
    await screen.findByTestId('section-function');
    expect(screen.getByTestId('tree-row-pay')).toBeInTheDocument();
    expect(screen.getByTestId('tree-row-token')).toBeInTheDocument();
    expect(screen.getByTestId('tree-row-sla')).toBeInTheDocument();
  });

  it('search keeps a deep match with its ancestor context (T-1103)', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('section-function');
    await user.type(screen.getByTestId('search-input'), 'токенизация');
    await waitFor(() => expect(screen.getByTestId('search-count')).toBeInTheDocument());
    expect(screen.getByTestId('tree-row-token')).toBeInTheDocument();
    // Ancestor kept as context.
    expect(screen.getByTestId('tree-row-pay')).toHaveAttribute('data-row-kind', 'context');
    // Unrelated NFR filtered out.
    expect(screen.queryByTestId('tree-row-sla')).not.toBeInTheDocument();
  });

  it('shows the empty state when nothing matches (T-1103, S29)', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('section-function');
    await user.type(screen.getByTestId('search-input'), 'блокчейн');
    expect(await screen.findByTestId('search-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('section-function')).not.toBeInTheDocument();
  });

  it('SA-6: shows a broken-panel when the API reports unparseable files', async () => {
    listRequirements.mockResolvedValue({
      requirements,
      broken: [{ file: 'functions/oops.md', slug: 'oops', error: 'Ошибка разбора' }],
      incomplete: [],
    });
    renderMain();
    const panel = await screen.findByTestId('broken-panel');
    expect(panel).toHaveTextContent('functions/oops.md');
    expect(panel).toHaveTextContent('Ошибка разбора');
  });

  it('SA-6: flags requirements without an acceptance criterion (incomplete-badge)', async () => {
    listRequirements.mockResolvedValue({ requirements, broken: [], incomplete: ['pay'] });
    renderMain();
    await screen.findByTestId('tree-row-pay');
    const badges = screen.getAllByTestId('incomplete-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveAttribute('data-slug', 'pay');
  });

  it('UX-6: offers "Сбросить фильтры" when filters hide everything, and restores the tree', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ implementationFilter: new Set(['PLANNED']) });
    renderMain();
    const reset = await screen.findByTestId('filters-reset');
    expect(screen.queryByTestId('section-function')).not.toBeInTheDocument();
    await user.click(reset);
    expect(await screen.findByTestId('tree-row-pay')).toBeInTheDocument();
  });

  it('UX-3: disables the delete confirm for a requirement that still has children', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-pay');
    const payRow = screen.getByTestId('tree-row-pay');
    await user.click(payRow.querySelector('[data-testid="delete-btn-pay"]') as HTMLElement);
    const confirm = await screen.findByTestId('delete-dialog-confirm');
    expect(confirm).toBeDisabled();
  });

  it('UX-2: shows a success toast after deleting a leaf requirement', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-sla');
    const slaRow = screen.getByTestId('tree-row-sla');
    await user.click(slaRow.querySelector('[data-testid="delete-btn-sla"]') as HTMLElement);
    const confirm = await screen.findByTestId('delete-dialog-confirm');
    expect(confirm).not.toBeDisabled();
    await user.click(confirm);
    expect(await screen.findByTestId('toast')).toHaveTextContent('Требование удалено');
  });

  it('opens the description drawer on demand and closes it (T-1104)', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-token');
    const tokenRow = screen.getByTestId('tree-row-token');
    const descBtn = tokenRow.querySelector('[data-testid="desc-expand"]') as HTMLElement;
    await user.click(descBtn);
    const panel = await screen.findByTestId('desc-panel');
    expect(panel).toHaveTextContent('PCI-DSS токенизация');
    expect(screen.getByTestId('desc-panel-path')).toHaveTextContent('Платежи');
    await user.click(screen.getByTestId('desc-panel-close'));
    await waitFor(() => expect(screen.queryByTestId('desc-panel')).not.toBeInTheDocument());
  });
});
