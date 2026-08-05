import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { ExportPage } from './ExportPage';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';
import { ApiError } from '../api/client';

/**
 * Полноэкранный экспорт (макеты Э1–Э4): один экран вместо двухшагового
 * диалога — дерево слева, формат и живой состав справа.
 */

const exportXlsx = vi.fn();
const exportArchive = vi.fn();
const exportSelected = vi.fn();
const getProject = vi.fn();
const listRequirements = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    get: (...a: unknown[]) => getProject(...a),
    exportXlsx: (...a: unknown[]) => exportXlsx(...a),
    export: (...a: unknown[]) => exportArchive(...a),
    exportSelected: (...a: unknown[]) => exportSelected(...a),
  },
  requirementsApi: { list: (...a: unknown[]) => listRequirements(...a) },
  linksApi: {},
  aiApi: {},
}));

const requirements = [
  makeReq({
    slug: 'r1',
    name: 'Оплата картой',
    type: 'FUNCTION',
    links: [{ type: 'PARENT_OF', targetSlug: 'r2' }],
  }),
  makeReq({
    slug: 'r2',
    name: 'Возвраты',
    type: 'FUNCTION',
    links: [{ type: 'CHILD_OF', targetSlug: 'r1' }],
  }),
  makeReq({ slug: 'n1', name: 'Доступность', type: 'NFR' }),
];

async function renderPage(): Promise<void> {
  renderWithProviders(
    <Routes>
      <Route path="/p/:id/export" element={<ExportPage />} />
      <Route path="/p/:id" element={<div data-testid="tree-screen" />} />
    </Routes>,
    { route: '/p/p1/export' },
  );
  await screen.findByTestId('export-item-r1');
}

/** Снять выделение со строки (у листа чекбокс переключает только её). */
async function uncheck(user: ReturnType<typeof userEvent.setup>, slug: string): Promise<void> {
  const row = screen.getByTestId(`export-item-${slug}`);
  await user.click(row.querySelector('input[type="checkbox"]') as HTMLElement);
}

describe('ExportPage (Э1–Э4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProject.mockResolvedValue({ id: 'p1', name: 'Twitter', mainPath: '/Projects/Twitter' });
    listRequirements.mockResolvedValue({ requirements, broken: [] });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  // ── Э1 · базовый путь ─────────────────────────────────────────────────────

  it('Э1: дерево и панель формата видны одновременно, весь проект выбран по умолчанию', async () => {
    await renderPage();
    expect(screen.getByTestId('workspace-title')).toHaveTextContent('Экспорт проекта · Twitter');
    // Оба прежних шага — на одном экране.
    expect(screen.getByTestId('export-item-r1')).toBeInTheDocument();
    expect(screen.getByTestId('export-fmt-zip')).toBeInTheDocument();
    expect(screen.getByTestId('export-fmt-targz')).toBeInTheDocument();
    expect(screen.getByTestId('export-fmt-xlsx')).toBeInTheDocument();
    expect(screen.getByTestId('export-run')).toHaveTextContent('Экспортировать (3)');
  });

  it('Э1: живой состав выгрузки пересчитывается при снятии требования', async () => {
    const user = userEvent.setup();
    await renderPage();
    expect(screen.getByTestId('export-summary-fn')).toHaveTextContent('2');
    expect(screen.getByTestId('export-summary-nfr')).toHaveTextContent('1');
    // r1 → r2 связаны, обе стороны в выборке.
    expect(screen.getByTestId('export-summary-links')).toHaveTextContent('1');

    await uncheck(user, 'n1');
    expect(screen.getByTestId('export-summary-nfr')).toHaveTextContent('0');
    expect(screen.getByTestId('export-run')).toHaveTextContent('Экспортировать (2)');
  });

  it('Э1: чекбокс родителя выбирает и снимает всю ветку', async () => {
    const user = userEvent.setup();
    await renderPage();
    // Снимаем ветку r1 целиком — уходит и ребёнок r2.
    await uncheck(user, 'r1');
    expect(screen.getByTestId('export-summary-fn')).toHaveTextContent('0');
    expect(screen.getByTestId('export-item-r1')).toHaveAttribute('data-select-state', 'off');

    // Возвращаем только ребёнка — родитель показывает частичный выбор.
    await uncheck(user, 'r2');
    expect(screen.getByTestId('export-item-r1')).toHaveAttribute('data-select-state', 'partial');
  });

  it('Э1: весь проект выгружается архивом через projectsApi.export', async () => {
    const user = userEvent.setup();
    exportArchive.mockResolvedValue({ blob: new Blob(['x']), filename: 'p1.zip' });
    await renderPage();
    await user.click(screen.getByTestId('export-run'));
    await waitFor(() => expect(exportArchive).toHaveBeenCalledTimes(1));
    expect(exportArchive).toHaveBeenCalledWith('p1', 'zip', [
      'source',
      'description',
      'info',
      'links',
    ]);
    // После успешной выгрузки возвращаемся к дереву требований.
    await screen.findByTestId('tree-screen');
  });

  it('Э1: частичная выборка уходит через exportSelected', async () => {
    const user = userEvent.setup();
    exportSelected.mockResolvedValue({ blob: new Blob(['x']), filename: 'p1-partial.tar.gz' });
    await renderPage();
    await uncheck(user, 'n1');
    await user.click(screen.getByTestId('export-fmt-targz'));
    await user.click(screen.getByTestId('export-run'));
    await waitFor(() => expect(exportSelected).toHaveBeenCalledTimes(1));
    expect(exportSelected.mock.calls[0]?.[1]).toBe('targz');
    expect([...(exportSelected.mock.calls[0]?.[2] as string[])].sort()).toEqual(['r1', 'r2']);
    expect(exportArchive).not.toHaveBeenCalled();
  });

  it('Э1: набор полей выгрузки — 3 замка и 4 переключателя, снятие меняет превью и запрос', async () => {
    const user = userEvent.setup();
    exportArchive.mockResolvedValue({ blob: new Blob(['x']), filename: 'p1.zip' });
    await renderPage();
    expect(screen.getByTestId('export-field-lock-name')).toBeDisabled();
    expect(screen.getByTestId('export-field-lock-criticality')).toBeChecked();
    expect(screen.getByTestId('export-field-description')).toBeChecked();

    await user.click(screen.getByTestId('export-field-description'));
    expect(screen.getByTestId('export-fields-preview')).not.toHaveTextContent('Описание');

    await user.click(screen.getByTestId('export-run'));
    await waitFor(() => expect(exportArchive).toHaveBeenCalledTimes(1));
    expect(exportArchive).toHaveBeenCalledWith('p1', 'zip', ['source', 'info', 'links']);
  });

  // ── Э2 · негатив: ничего не выбрано ───────────────────────────────────────

  it('Э2: пустой выбор блокирует кнопку, обнуляет состав и объясняет, что делать', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByTestId('export-untoggle-all'));

    expect(screen.getByTestId('export-run')).toBeDisabled();
    expect(screen.getByTestId('export-run')).toHaveTextContent('Экспортировать (0)');
    expect(screen.getByTestId('export-summary-fn')).toHaveTextContent('0');
    expect(screen.getByTestId('export-summary-file')).toHaveTextContent('—');
    expect(screen.getByTestId('export-empty-hint')).toHaveTextContent(
      'Отметьте требования в дереве слева',
    );
    // Это не ошибка — красной плашки нет.
    expect(screen.queryByTestId('export-error')).not.toBeInTheDocument();
  });

  // ── Э3 · развилка формата ─────────────────────────────────────────────────

  it('Э3: выбор .xlsx меняет имя файла и предупреждает об ограничениях формата', async () => {
    const user = userEvent.setup();
    await renderPage();
    expect(screen.queryByTestId('export-xlsx-note')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('export-fmt-xlsx'));
    expect(screen.getByTestId('export-fmt-xlsx')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('export-summary-file')).toHaveTextContent('.xlsx');
    expect(screen.getByTestId('export-xlsx-note')).toHaveTextContent(
      'повторный импорт из .xlsx не поддерживается',
    );
  });

  it('Э3: .xlsx на всём проекте идёт через exportXlsx, на подвыборке — через exportSelected', async () => {
    const user = userEvent.setup();
    exportXlsx.mockResolvedValue({ blob: new Blob(['x']), filename: 'p1.xlsx' });
    await renderPage();
    await user.click(screen.getByTestId('export-fmt-xlsx'));
    await user.click(screen.getByTestId('export-run'));
    await waitFor(() => expect(exportXlsx).toHaveBeenCalledTimes(1));
    expect(exportSelected).not.toHaveBeenCalled();
  });

  it('Э3: .xlsx с подвыборкой уходит через exportSelected', async () => {
    const user = userEvent.setup();
    exportSelected.mockResolvedValue({ blob: new Blob(['x']), filename: 'p1-partial.xlsx' });
    await renderPage();
    await uncheck(user, 'n1');
    await user.click(screen.getByTestId('export-fmt-xlsx'));
    await user.click(screen.getByTestId('export-run'));
    await waitFor(() => expect(exportSelected).toHaveBeenCalledTimes(1));
    expect(exportSelected.mock.calls[0]?.[1]).toBe('xlsx');
    expect(exportXlsx).not.toHaveBeenCalled();
  });

  // ── Э4 · негатив: ошибка сервера ──────────────────────────────────────────

  it('Э4: ошибка сервера не теряет выбор — причина видна, повтор в один клик', async () => {
    const user = userEvent.setup();
    exportSelected.mockRejectedValueOnce(
      new ApiError(500, { code: 'INTERNAL', message: 'Недостаточно места на диске' }),
    );
    await renderPage();
    await uncheck(user, 'n1');
    await user.click(screen.getByTestId('export-run'));

    const err = await screen.findByTestId('export-error');
    expect(err).toHaveTextContent('Недостаточно места на диске');
    // Экран остался на месте, выбор сохранён.
    expect(screen.queryByTestId('tree-screen')).not.toBeInTheDocument();
    expect(screen.getByTestId('export-run')).toHaveTextContent('Экспортировать (2)');

    exportSelected.mockResolvedValueOnce({ blob: new Blob(['x']), filename: 'p1-partial.zip' });
    await user.click(screen.getByTestId('export-run'));
    await waitFor(() => expect(exportSelected).toHaveBeenCalledTimes(2));
  });

  it('«Отмена» возвращает к дереву требований', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByTestId('export-cancel'));
    await screen.findByTestId('tree-screen');
  });
});
