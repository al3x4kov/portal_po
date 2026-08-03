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
const removeRequirement = vi.fn();
const exportArchive = vi.fn();
const exportXlsx = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    get: (...a: unknown[]) => getProject(...a),
    export: (...a: unknown[]) => exportArchive(...a),
    exportXlsx: (...a: unknown[]) => exportXlsx(...a),
    exportSelected: vi.fn().mockResolvedValue({ blob: new Blob(), filename: 'partial.zip' }),
  },
  requirementsApi: {
    list: (...a: unknown[]) => listRequirements(...a),
    checkName: vi.fn().mockResolvedValue({ available: true, slug: 'x' }),
    create: vi.fn(),
    update: vi.fn(),
    remove: (...a: unknown[]) => removeRequirement(...a),
  },
  linksApi: { create: vi.fn(), remove: vi.fn() },
  // Task 11: the AI-import modal reads the AI config/models once opened.
  aiApi: {
    getConfig: vi
      .fn()
      .mockResolvedValue({ baseURL: 'https://ai', hasApiKey: true, model: 'GigaChat-2-Pro' }),
    listModels: vi.fn().mockResolvedValue({ models: ['GigaChat-2-Pro'] }),
  },
  aiImportApi: { start: vi.fn(), getJob: vi.fn(), cancel: vi.fn() },
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
    removeRequirement.mockReset();
    removeRequirement.mockResolvedValue(null);
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
      sourceFilter: new Set(),
      expanded: new Set(),
      collapsedOverrides: new Set(),
      modal: null,
    });
  });

  it('task23: chevron collapses and re-expands a branch in default expand-all mode', async () => {
    const user = userEvent.setup();
    renderMain();
    // Full tree by default: child row visible.
    expect(await screen.findByTestId('tree-row-token')).toBeInTheDocument();
    const chevron = screen
      .getByTestId('tree-row-pay')
      .querySelector('[data-testid="toggle-node"]') as HTMLElement;
    expect(chevron).toHaveAttribute('aria-expanded', 'true');

    await user.click(chevron);
    // Branch collapsed point-wise; the rest of the tree is untouched.
    expect(screen.queryByTestId('tree-row-token')).not.toBeInTheDocument();
    expect(screen.getByTestId('tree-row-pay')).toBeInTheDocument();
    expect(
      screen.getByTestId('tree-row-pay').querySelector('[data-testid="toggle-node"]'),
    ).toHaveAttribute('aria-expanded', 'false');

    // Second click restores the branch.
    await user.click(
      screen.getByTestId('tree-row-pay').querySelector('[data-testid="toggle-node"]')!,
    );
    expect(await screen.findByTestId('tree-row-token')).toBeInTheDocument();
  });

  it('task23: «Раскрыть все» clears manual branch collapses', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-token');
    await user.click(
      screen.getByTestId('tree-row-pay').querySelector('[data-testid="toggle-node"]')!,
    );
    expect(screen.queryByTestId('tree-row-token')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('toggle-expand-all'));
    expect(await screen.findByTestId('tree-row-token')).toBeInTheDocument();
  });

  it('UX-8: "Экспорт" footer button opens ExportModal', async () => {
    const user = userEvent.setup();
    renderMain();
    const btn = await screen.findByTestId('sidebar-open-export');
    expect(btn.tagName).toBe('BUTTON');
    await user.click(btn);
    expect(await screen.findByTestId('export-modal')).toBeInTheDocument();
  });

  it('UX-8: ExportModal shows format buttons on step 2 and calls exportXlsx', async () => {
    exportXlsx.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderMain();
    await user.click(await screen.findByTestId('sidebar-open-export'));
    // advance to format step
    await user.click(await screen.findByTestId('export-next'));
    const xlsxBtn = await screen.findByTestId('export-fmt-xlsx');
    expect(xlsxBtn.tagName).toBe('BUTTON');
    await user.click(xlsxBtn);
    // Task 2: default selection has all optional fields enabled.
    expect(exportXlsx).toHaveBeenCalledWith('proj-1', ['source', 'description', 'info', 'links']);
  });

  it('UX-8: ExportModal surfaces xlsx error on step 2', async () => {
    exportXlsx.mockRejectedValueOnce(new Error('Не удалось собрать Excel'));
    const user = userEvent.setup();
    renderMain();
    await user.click(await screen.findByTestId('sidebar-open-export'));
    await user.click(await screen.findByTestId('export-next'));
    await user.click(await screen.findByTestId('export-fmt-xlsx'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось собрать Excel');
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

  it('UX-6: offers "Сбросить фильтры" when filters hide everything, and restores the tree', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ implementationFilter: new Set(['PLANNED']) });
    renderMain();
    const reset = await screen.findByTestId('filters-reset');
    expect(screen.queryByTestId('section-function')).not.toBeInTheDocument();
    await user.click(reset);
    expect(await screen.findByTestId('tree-row-pay')).toBeInTheDocument();
  });

  it('UX-2: node with children offers a reinforced cascade delete (button enabled)', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-pay');
    const payRow = screen.getByTestId('tree-row-pay');
    const deleteBtn = payRow.querySelector('[data-testid="delete-btn-pay"]') as HTMLElement;
    // UX-2: the button is now enabled — deletion is allowed via cascade.
    expect(deleteBtn).not.toBeDisabled();
    expect(deleteBtn).toHaveAttribute('aria-label', 'Удалить требование со вложенными');
    await user.click(deleteBtn);
    // Cascade dialog: shows N (1 nested → total 2) and requires typing the name.
    const dialog = await screen.findByTestId('delete-dialog');
    expect(screen.getByTestId('delete-dialog-cascade')).toHaveTextContent(
      '«Платежи» содержит 1 требование во вложениях',
    );
    const confirm = screen.getByTestId('delete-dialog-confirm');
    expect(confirm).toHaveTextContent('Удалить 2 требования');
    // Confirm stays disabled until the exact name is typed.
    expect(confirm).toBeDisabled();
    await user.type(screen.getByTestId('delete-dialog-input'), 'Платежи');
    expect(confirm).not.toBeDisabled();
    await user.click(confirm);
    await waitFor(() => expect(removeRequirement).toHaveBeenCalledWith('proj-1', 'pay', true));
    expect(dialog).toBeDefined();
  });

  it('UX-2: cascade delete toast echoes the server `deleted` count and closes the dialog', async () => {
    const user = userEvent.setup();
    removeRequirement.mockResolvedValueOnce({ deleted: 3, slugs: ['pay', 'token', 'x'] });
    renderMain();
    await screen.findByTestId('tree-row-pay');
    const payRow = screen.getByTestId('tree-row-pay');
    await user.click(payRow.querySelector('[data-testid="delete-btn-pay"]') as HTMLElement);
    await screen.findByTestId('delete-dialog');
    await user.type(screen.getByTestId('delete-dialog-input'), 'Платежи');
    await user.click(screen.getByTestId('delete-dialog-confirm'));
    expect(await screen.findByTestId('toast')).toHaveTextContent('Удалено 3 требования');
    await waitFor(() => expect(screen.queryByTestId('delete-dialog')).not.toBeInTheDocument());
  });

  it('UX-2: leaf requirement deletes without cascade and shows a success toast', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-sla');
    const slaRow = screen.getByTestId('tree-row-sla');
    await user.click(slaRow.querySelector('[data-testid="delete-btn-sla"]') as HTMLElement);
    const confirm = await screen.findByTestId('delete-dialog-confirm');
    // No type-to-confirm for a leaf: the button is active immediately.
    expect(screen.queryByTestId('delete-dialog-input')).not.toBeInTheDocument();
    expect(confirm).not.toBeDisabled();
    await user.click(confirm);
    await waitFor(() => expect(removeRequirement).toHaveBeenCalledWith('proj-1', 'sla', false));
    expect(await screen.findByTestId('toast')).toHaveTextContent('Удалено 1 требование');
  });

  it('Task 11: «AI подгрузка из документации» footer button opens the AI-import modal', async () => {
    const user = userEvent.setup();
    renderMain();
    const btn = await screen.findByTestId('footer-ai-import');
    expect(btn).toHaveTextContent('AI подгрузка из документации');
    await user.click(btn);
    expect(await screen.findByTestId('ai-import')).toBeInTheDocument();
    expect(screen.getByTestId('ai-import-drop')).toBeInTheDocument();
    // Idle → the ✕ closes without any confirmation.
    await user.click(screen.getByTestId('ai-import-close'));
    await waitFor(() => expect(screen.queryByTestId('ai-import')).not.toBeInTheDocument());
  });

  it('UX-10: clicking a requirement name opens the edit modal (onEdit)', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-pay');
    await user.click(screen.getByTestId('req-name-pay'));
    const modal = await screen.findByTestId('requirement-modal');
    // Editing an existing requirement prefills its name.
    expect(modal).toBeInTheDocument();
    expect(screen.getByDisplayValue('Платежи')).toBeInTheDocument();
  });

  it('row link button opens the LinkModal for that requirement (onLink)', async () => {
    const user = userEvent.setup();
    renderMain();
    const row = await screen.findByTestId('tree-row-pay');
    await user.click(row.querySelector('[data-testid="link-btn-pay"]') as HTMLElement);
    expect(await screen.findByTestId('link-modal')).toBeInTheDocument();
  });

  it('T3: "+ Описание" on an empty cell opens the modal focused on the description (onAddDesc)', async () => {
    const user = userEvent.setup();
    renderMain();
    // sla (NFR) has no description → the row renders a «+ Описание» button.
    const row = await screen.findByTestId('tree-row-sla');
    await user.click(row.querySelector('[data-testid="desc-add"]') as HTMLElement);
    const modal = await screen.findByTestId('requirement-modal');
    expect(modal).toBeInTheDocument();
    // focusField='description' keeps the description tab active with its textarea visible.
    expect(screen.getByTestId('req-description')).toBeVisible();
  });

  it('T4: shield-plus on a functional row opens a pre-linked NFR create modal (onAddNfr)', async () => {
    const user = userEvent.setup();
    renderMain();
    const row = await screen.findByTestId('tree-row-pay');
    await user.click(row.querySelector('[data-testid="row-add-nfr"]') as HTMLElement);
    const modal = await screen.findByTestId('requirement-modal');
    // A create modal (no prefilled name) targeting an NFR.
    expect(modal).toBeInTheDocument();
    expect((screen.getByTestId('req-name') as HTMLInputElement).value).toBe('');
  });

  it('T-509: git-branch-plus on a functional row opens the add-child modal (handleAddChild)', async () => {
    const user = userEvent.setup();
    renderMain();
    const row = await screen.findByTestId('tree-row-pay');
    await user.click(row.querySelector('[data-testid="row-add-child"]') as HTMLElement);
    expect(await screen.findByTestId('requirement-modal')).toBeInTheDocument();
    expect((screen.getByTestId('req-name') as HTMLInputElement).value).toBe('');
  });

  it('section header "+ Функция" button opens a FUNCTION create modal (TreeTable onAdd)', async () => {
    const user = userEvent.setup();
    renderMain();
    await user.click(await screen.findByTestId('add-function'));
    expect(await screen.findByTestId('requirement-modal')).toBeInTheDocument();
  });

  it('section header "+ НФТ" button opens an NFR create modal (TreeTable onAdd)', async () => {
    const user = userEvent.setup();
    renderMain();
    await user.click(await screen.findByTestId('add-nfr'));
    expect(await screen.findByTestId('requirement-modal')).toBeInTheDocument();
  });

  it('footer "+ Функция" and "+ НФТ" buttons open the matching create modals', async () => {
    const user = userEvent.setup();
    renderMain();
    await user.click(await screen.findByTestId('footer-add-function'));
    expect(await screen.findByTestId('requirement-modal')).toBeInTheDocument();
    // Close and open the NFR one from the footer.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('requirement-modal')).not.toBeInTheDocument());
    await user.click(screen.getByTestId('footer-add-nfr'));
    expect(await screen.findByTestId('requirement-modal')).toBeInTheDocument();
  });

  it('sidebar "Генерация задач" opens the ExportTasksModal (onOpenTasks)', async () => {
    const user = userEvent.setup();
    renderMain();
    await user.click(await screen.findByTestId('sidebar-open-tasks'));
    expect(await screen.findByTestId('export-tasks-modal')).toBeInTheDocument();
  });

  it('search-empty state clears the query and restores the tree (onClick search reset)', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('section-function');
    await user.type(screen.getByTestId('search-input'), 'блокчейн');
    const empty = await screen.findByTestId('search-empty');
    // The empty state offers a reset button that clears the search.
    const reset = empty.querySelector('button') as HTMLElement;
    await user.click(reset);
    expect(await screen.findByTestId('tree-row-pay')).toBeInTheDocument();
  });

  it('onAddLink: editing → "+ Связать с ФТ" swaps the edit modal for the LinkModal', async () => {
    const user = userEvent.setup();
    renderMain();
    await screen.findByTestId('tree-row-pay');
    await user.click(screen.getByTestId('req-name-pay'));
    await screen.findByTestId('requirement-modal');
    await user.click(screen.getByTestId('req-tab-links'));
    await user.click(await screen.findByTestId('req-links-add-ft'));
    // The requirement modal closes and a LinkModal opens for the same source.
    expect(await screen.findByTestId('link-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('requirement-modal')).not.toBeInTheDocument();
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
