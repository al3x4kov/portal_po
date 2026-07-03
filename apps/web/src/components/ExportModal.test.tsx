import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExportModal } from './ExportModal';
import { renderWithProviders } from '../test/utils';
import { makeReq } from '../test/fixtures';
import { ApiError } from '../api/client';

const exportXlsx = vi.fn();
const exportArchive = vi.fn();
const exportSelected = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    exportXlsx: (...a: unknown[]) => exportXlsx(...a),
    export: (...a: unknown[]) => exportArchive(...a),
    exportSelected: (...a: unknown[]) => exportSelected(...a),
  },
  requirementsApi: {},
  linksApi: {},
}));

const requirements = [
  makeReq({ slug: 'r1', name: 'Оплата картой', type: 'FUNCTION' }),
  makeReq({ slug: 'r2', name: 'Возвраты', type: 'FUNCTION' }),
  makeReq({ slug: 'n1', name: 'Доступность', type: 'NFR' }),
];

/** Advance from the picker step to the format step, keeping the given slugs selected. */
async function gotoFormatStep(
  user: ReturnType<typeof userEvent.setup>,
  deselect: string[] = [],
): Promise<void> {
  for (const slug of deselect) {
    const item = screen.getByTestId(`export-item-${slug}`);
    await user.click(item.querySelector('input[type="checkbox"]') as HTMLElement);
  }
  await user.click(screen.getByTestId('export-next'));
  await screen.findByTestId('export-fmt-xlsx');
}

describe('ExportModal', () => {
  beforeEach(() => {
    exportXlsx.mockReset();
    exportArchive.mockReset();
    exportSelected.mockReset();
    // jsdom lacks these — stub the download plumbing.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it('starts on the requirement-selection step', () => {
    renderWithProviders(
      <ExportModal projectId="p1" requirements={requirements} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId('export-modal')).toBeInTheDocument();
    expect(screen.getByTestId('export-next')).toBeInTheDocument();
    // format buttons not present yet
    expect(screen.queryByTestId('export-fmt-xlsx')).not.toBeInTheDocument();
  });

  it('shows all three format options on the format step', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportModal projectId="p1" requirements={requirements} onClose={vi.fn()} />,
    );
    await gotoFormatStep(user);
    expect(screen.getByTestId('export-fmt-xlsx')).toBeInTheDocument();
    expect(screen.getByTestId('export-fmt-zip')).toBeInTheDocument();
    expect(screen.getByTestId('export-fmt-targz')).toBeInTheDocument();
    expect(screen.getByText(/Выбрано/)).toHaveTextContent('3');
  });

  it('exports xlsx via exportXlsx and closes on success', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    exportXlsx.mockResolvedValue({ blob: new Blob(['x']), filename: 'p1.xlsx' });
    renderWithProviders(
      <ExportModal projectId="p1" requirements={requirements} onClose={onClose} />,
    );
    await gotoFormatStep(user);
    await user.click(screen.getByTestId('export-fmt-xlsx'));
    // Default selection → all optional fields, in @po/core order.
    await waitFor(() =>
      expect(exportXlsx).toHaveBeenCalledWith('p1', ['source', 'description', 'info', 'links']),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('exports the whole project archive when every requirement is selected', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    exportArchive.mockResolvedValue({ blob: new Blob(['z']), filename: 'p1.zip' });
    renderWithProviders(
      <ExportModal projectId="p1" requirements={requirements} onClose={onClose} />,
    );
    await gotoFormatStep(user);
    await user.click(screen.getByTestId('export-fmt-zip'));
    await waitFor(() =>
      expect(exportArchive).toHaveBeenCalledWith('p1', 'zip', [
        'source',
        'description',
        'info',
        'links',
      ]),
    );
    expect(exportSelected).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('exports only the selected requirements when a subset is chosen (targz)', async () => {
    const user = userEvent.setup();
    exportSelected.mockResolvedValue({ blob: new Blob(['t']), filename: 'p1-partial.tar.gz' });
    renderWithProviders(
      <ExportModal projectId="p1" requirements={requirements} onClose={vi.fn()} />,
    );
    await gotoFormatStep(user, ['r2']); // deselect one → subset
    await user.click(screen.getByTestId('export-fmt-targz'));
    await waitFor(() =>
      expect(exportSelected).toHaveBeenCalledWith(
        'p1',
        'targz',
        expect.arrayContaining(['r1', 'n1']),
        ['source', 'description', 'info', 'links'],
      ),
    );
    expect(exportArchive).not.toHaveBeenCalled();
  });

  it('renders 3 mandatory locks (checked + disabled) and 4 optional toggles (default on)', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportModal projectId="p1" requirements={requirements} onClose={vi.fn()} />,
    );
    await gotoFormatStep(user);
    for (const id of [
      'export-field-lock-name',
      'export-field-lock-criticality',
      'export-field-lock-impl',
    ]) {
      const cb = screen.getByTestId(id) as HTMLInputElement;
      expect(cb.checked).toBe(true);
      expect(cb.disabled).toBe(true);
    }
    for (const id of [
      'export-field-source',
      'export-field-description',
      'export-field-info',
      'export-field-links',
    ]) {
      const cb = screen.getByTestId(id) as HTMLInputElement;
      expect(cb.checked).toBe(true);
      expect(cb.disabled).toBe(false);
    }
    expect(screen.getByTestId('export-fields-preview')).toHaveTextContent('Источник');
    expect(screen.getByTestId('export-fields-preview')).toHaveTextContent('#### Links');
  });

  it('deselecting an optional field updates the preview and the fields sent to the API', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    exportXlsx.mockResolvedValue({ blob: new Blob(['x']), filename: 'p1.xlsx' });
    renderWithProviders(
      <ExportModal projectId="p1" requirements={requirements} onClose={onClose} />,
    );
    await gotoFormatStep(user);
    // turn off "Описание" and "Связи"
    await user.click(screen.getByTestId('export-field-description'));
    await user.click(screen.getByTestId('export-field-links'));
    const preview = screen.getByTestId('export-fields-preview');
    expect(preview).not.toHaveTextContent('Описание');
    expect(preview).not.toHaveTextContent('#### Links');
    await user.click(screen.getByTestId('export-fmt-xlsx'));
    await waitFor(() => expect(exportXlsx).toHaveBeenCalledWith('p1', ['source', 'info']));
  });

  it('sends an empty fields array (minimum) when all optional fields are off', async () => {
    const user = userEvent.setup();
    exportArchive.mockResolvedValue({ blob: new Blob(['z']), filename: 'p1.zip' });
    renderWithProviders(
      <ExportModal projectId="p1" requirements={requirements} onClose={vi.fn()} />,
    );
    await gotoFormatStep(user);
    for (const id of [
      'export-field-source',
      'export-field-description',
      'export-field-info',
      'export-field-links',
    ]) {
      await user.click(screen.getByTestId(id));
    }
    expect(screen.getByTestId('export-fields-preview')).toHaveTextContent('(минимум)');
    await user.click(screen.getByTestId('export-fmt-zip'));
    await waitFor(() => expect(exportArchive).toHaveBeenCalledWith('p1', 'zip', []));
  });

  it('shows a human-readable error when the export fails', async () => {
    const user = userEvent.setup();
    exportArchive.mockRejectedValueOnce(
      new ApiError(500, { code: 'INTERNAL', message: 'Не удалось собрать архив' }),
    );
    renderWithProviders(
      <ExportModal projectId="p1" requirements={requirements} onClose={vi.fn()} />,
    );
    await gotoFormatStep(user);
    await user.click(screen.getByTestId('export-fmt-zip'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось собрать архив');
  });

  it('cancels the whole flow via "Отменить" on the format step', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <ExportModal projectId="p1" requirements={requirements} onClose={onClose} />,
    );
    await gotoFormatStep(user);
    await user.click(screen.getByRole('button', { name: 'Отменить' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('goes back to the selection step via "← Назад"', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportModal projectId="p1" requirements={requirements} onClose={vi.fn()} />,
    );
    await gotoFormatStep(user);
    await user.click(screen.getByRole('button', { name: '← Назад' }));
    // back on picker step
    expect(screen.getByTestId('export-next')).toBeInTheDocument();
    expect(screen.queryByTestId('export-fmt-xlsx')).not.toBeInTheDocument();
  });
});
