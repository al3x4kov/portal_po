import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Import } from './Import';
import { renderWithProviders } from '../test/utils';
import { ApiError } from '../api/client';

const importFn = vi.fn();
const navSpy = vi.fn();

// Keep MemoryRouter & co. real; only intercept the imperative navigation.
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navSpy };
});

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    import: (name: string, file: File) => importFn(name, file),
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    export: vi.fn(),
  },
  requirementsApi: {},
  linksApi: {},
}));

describe('Import (T-603, FR-3)', () => {
  beforeEach(() => {
    importFn.mockReset();
    navSpy.mockReset();
  });

  it('rejects an unsupported file format on the client', async () => {
    renderWithProviders(<Import />);
    const badFile = new File(['x'], 'notes.txt', { type: 'text/plain' });
    // fireEvent bypasses the input's accept filter, mirroring the drag-drop path.
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [badFile] } });
    expect(await screen.findByTestId('import-error')).toHaveTextContent('Неподдерживаемый формат');
  });

  it('shows the broken-archive error returned by the API', async () => {
    importFn.mockRejectedValueOnce(new ApiError(422, { code: 'ARCHIVE', message: 'Битый архив' }));
    const user = userEvent.setup();
    renderWithProviders(<Import />);

    await user.type(screen.getByTestId('import-name'), 'imported-crm');
    const file = new File(['garbage'], 'broken.tar.gz', { type: 'application/gzip' });
    await user.upload(screen.getByTestId('import-file'), file);
    expect(screen.getByTestId('import-file-name')).toHaveTextContent('broken.tar.gz');

    await user.click(screen.getByTestId('import-submit'));
    expect(await screen.findByTestId('import-error')).toHaveTextContent('Битый архив');
  });

  // ── Task 12 · F-2.2: remaining handlers and error branches ─────────────────
  it('successful import navigates to the new project page', async () => {
    importFn.mockResolvedValueOnce({ id: 'imported-crm' });
    const user = userEvent.setup();
    renderWithProviders(<Import />);

    await user.type(screen.getByTestId('import-name'), 'imported-crm');
    const file = new File(['zip'], 'crm.zip', { type: 'application/zip' });
    await user.upload(screen.getByTestId('import-file'), file);
    await user.click(screen.getByTestId('import-submit'));

    await waitFor(() => expect(navSpy).toHaveBeenCalledWith('/p/imported-crm'));
    expect(importFn).toHaveBeenCalledWith('imported-crm', file);
  });

  it('accepts a valid archive dropped onto the dropzone', async () => {
    renderWithProviders(<Import />);
    const zone = screen.getByTestId('import-dropzone');
    const file = new File(['zip'], 'project.tgz', { type: 'application/gzip' });

    fireEvent.dragOver(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    expect(await screen.findByTestId('import-file-name')).toHaveTextContent('project.tgz');
    expect(screen.queryByTestId('import-error')).not.toBeInTheDocument();
  });

  it('rejects an unsupported file dropped onto the dropzone', async () => {
    renderWithProviders(<Import />);
    const zone = screen.getByTestId('import-dropzone');
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(['x'], 'notes.docx', { type: 'application/msword' })] },
    });

    expect(await screen.findByTestId('import-error')).toHaveTextContent('Неподдерживаемый формат');
    expect(screen.queryByTestId('import-file-name')).not.toBeInTheDocument();
  });

  it('a drop without files is a no-op (no card, no error)', () => {
    renderWithProviders(<Import />);
    fireEvent.drop(screen.getByTestId('import-dropzone'), { dataTransfer: { files: [] } });
    expect(screen.queryByTestId('import-file-name')).not.toBeInTheDocument();
    expect(screen.queryByTestId('import-error')).not.toBeInTheDocument();
  });

  it('«Убрать файл» removes the chosen archive and disables submit again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Import />);
    await user.type(screen.getByTestId('import-name'), 'proj');
    await user.upload(
      screen.getByTestId('import-file'),
      new File(['zip'], 'a.zip', { type: 'application/zip' }),
    );
    expect(screen.getByTestId('import-file-name')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Убрать файл' }));
    expect(screen.queryByTestId('import-file-name')).not.toBeInTheDocument();
    expect(screen.getByTestId('import-submit')).toBeDisabled();
  });

  it('«Выбрать файл» delegates to the hidden file input', async () => {
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => undefined);
    try {
      const user = userEvent.setup();
      renderWithProviders(<Import />);
      await user.click(screen.getByRole('button', { name: 'Выбрать файл' }));
      expect(clickSpy).toHaveBeenCalledTimes(1);
    } finally {
      clickSpy.mockRestore();
    }
  });

  it('submitting the form without a file shows «Выберите архив для импорта.»', async () => {
    const { container } = renderWithProviders(<Import />);
    // The submit button is disabled without a file; submit the form directly
    // (e.g. Enter in the name field) to exercise the guard.
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByTestId('import-error')).toHaveTextContent(
      'Выберите архив для импорта.',
    );
    expect(importFn).not.toHaveBeenCalled();
  });

  it('«Отменить» navigates back to the start screen', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Import />);
    await user.click(screen.getByRole('button', { name: 'Отменить' }));
    expect(navSpy).toHaveBeenCalledWith('/');
  });

  it('formats the file size in КБ and МБ', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Import />);

    // 2048 bytes → «2 КБ»
    await user.upload(
      screen.getByTestId('import-file'),
      new File([new Uint8Array(2048)], 'small.zip', { type: 'application/zip' }),
    );
    expect(screen.getByTestId('import-file-name')).toHaveTextContent('2 КБ');

    // 1.5 МБ → «1.5 МБ»
    await user.upload(
      screen.getByTestId('import-file'),
      new File([new Uint8Array(1.5 * 1024 * 1024)], 'big.zip', { type: 'application/zip' }),
    );
    expect(screen.getByTestId('import-file-name')).toHaveTextContent('1.5 МБ');
  });
});
