import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Import, deriveProjectName } from './Import';
import { renderWithProviders } from '../test/utils';
import { ApiError } from '../api/client';
import { RECENT_PROJECTS_KEY, readRecentProjects } from '../lib/recentProjects';

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

describe('deriveProjectName (todo_17 T2 — автоимя из архива)', () => {
  it('strips the archive extension', () => {
    expect(deriveProjectName('portal.zip')).toBe('portal');
    expect(deriveProjectName('portal.tar.gz')).toBe('portal');
    expect(deriveProjectName('portal.TGZ')).toBe('portal');
  });

  it('replaces characters illegal in directory names with «_»', () => {
    expect(deriveProjectName('портал:поставщика?.zip')).toBe('портал_поставщика_');
  });

  it('keeps letters, digits, spaces, hyphens and underscores', () => {
    expect(deriveProjectName('Портал поставщика_v2-final.zip')).toBe('Портал поставщика_v2-final');
  });
});

describe('Import (T-603, FR-3, todo_17 T2)', () => {
  beforeEach(() => {
    importFn.mockReset();
    navSpy.mockReset();
    localStorage.removeItem(RECENT_PROJECTS_KEY);
  });

  it('shows the empty state: dropzone first, disabled submit with a reason', () => {
    renderWithProviders(<Import />);
    expect(screen.getByTestId('import-dropzone')).toHaveTextContent(
      'Перетащите архив сюда или нажмите, чтобы выбрать',
    );
    expect(screen.getByTestId('import-dropzone')).toHaveTextContent(
      'Поддерживаются .zip и .tar.gz',
    );
    expect(screen.getByTestId('import-submit')).toBeDisabled();
    expect(screen.getByTestId('import-disabled-reason')).toHaveTextContent(
      'Выберите архив и укажите имя',
    );
  });

  it('highlights the dropzone on dragover («Отпустите, чтобы загрузить»)', () => {
    renderWithProviders(<Import />);
    const zone = screen.getByTestId('import-dropzone');

    fireEvent.dragOver(zone);
    expect(zone).toHaveAttribute('data-dragover', 'true');
    expect(zone).toHaveTextContent('Отпустите, чтобы загрузить');

    fireEvent.dragLeave(zone);
    expect(zone).not.toHaveAttribute('data-dragover');
  });

  it('clicking the dropzone delegates to the hidden file input', async () => {
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => undefined);
    try {
      const user = userEvent.setup();
      renderWithProviders(<Import />);
      await user.click(screen.getByTestId('import-dropzone'));
      expect(clickSpy).toHaveBeenCalledTimes(1);
    } finally {
      clickSpy.mockRestore();
    }
  });

  it('rejects an unsupported file format on the client', async () => {
    renderWithProviders(<Import />);
    const badFile = new File(['x'], 'notes.txt', { type: 'text/plain' });
    // fireEvent bypasses the input's accept filter, mirroring the drag-drop path.
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [badFile] } });
    expect(await screen.findByTestId('import-error')).toHaveTextContent('Неподдерживаемый формат');
  });

  it('prefills the project name from the picked archive (editable)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Import />);

    const file = new File(['zip'], 'портал_поставщика.zip', { type: 'application/zip' });
    await user.upload(screen.getByTestId('import-file'), file);

    expect(screen.getByTestId('import-file-card')).toHaveTextContent('портал_поставщика.zip');
    expect(screen.getByTestId('import-name')).toHaveValue('портал_поставщика');
    expect(screen.getByText('Подставлено из имени архива — можно изменить.')).toBeInTheDocument();
    expect(screen.getByTestId('import-disabled-reason')).toHaveTextContent('Всё готово к импорту');
    expect(screen.getByTestId('import-submit')).toBeEnabled();

    // The name stays editable after autofill.
    await user.clear(screen.getByTestId('import-name'));
    await user.type(screen.getByTestId('import-name'), 'Портал');
    expect(screen.getByTestId('import-name')).toHaveValue('Портал');
  });

  it('shows the broken-archive error returned by the API', async () => {
    importFn.mockRejectedValueOnce(new ApiError(422, { code: 'ARCHIVE', message: 'Битый архив' }));
    const user = userEvent.setup();
    renderWithProviders(<Import />);

    const file = new File(['garbage'], 'broken.tar.gz', { type: 'application/gzip' });
    await user.upload(screen.getByTestId('import-file'), file);
    expect(screen.getByTestId('import-file-name')).toHaveTextContent('broken.tar.gz');

    await user.click(screen.getByTestId('import-submit'));
    expect(await screen.findByTestId('import-error')).toHaveTextContent('Битый архив');
  });

  it('successful import navigates to the new project page and remembers it in recents', async () => {
    importFn.mockResolvedValueOnce({
      id: 'imported-crm',
      name: 'imported-crm',
      mainPath: '/Projects/imported-crm',
    });
    const user = userEvent.setup();
    renderWithProviders(<Import />);

    const file = new File(['zip'], 'crm.zip', { type: 'application/zip' });
    await user.upload(screen.getByTestId('import-file'), file);
    await user.clear(screen.getByTestId('import-name'));
    await user.type(screen.getByTestId('import-name'), 'imported-crm');
    await user.click(screen.getByTestId('import-submit'));

    await waitFor(() => expect(navSpy).toHaveBeenCalledWith('/p/imported-crm'));
    expect(importFn).toHaveBeenCalledWith('imported-crm', file);
    expect(readRecentProjects()[0]?.id).toBe('imported-crm');
  });

  it('accepts a valid archive dropped onto the dropzone', async () => {
    renderWithProviders(<Import />);
    const zone = screen.getByTestId('import-dropzone');
    const file = new File(['zip'], 'project.tgz', { type: 'application/gzip' });

    fireEvent.dragOver(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });

    expect(await screen.findByTestId('import-file-card')).toHaveTextContent('project.tgz');
    expect(screen.getByTestId('import-name')).toHaveValue('project');
    expect(screen.queryByTestId('import-error')).not.toBeInTheDocument();
  });

  it('rejects an unsupported file dropped onto the dropzone', async () => {
    renderWithProviders(<Import />);
    const zone = screen.getByTestId('import-dropzone');
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(['x'], 'notes.docx', { type: 'application/msword' })] },
    });

    expect(await screen.findByTestId('import-error')).toHaveTextContent('Неподдерживаемый формат');
    expect(screen.queryByTestId('import-file-card')).not.toBeInTheDocument();
  });

  it('a drop without files is a no-op (no card, no error)', () => {
    renderWithProviders(<Import />);
    fireEvent.drop(screen.getByTestId('import-dropzone'), { dataTransfer: { files: [] } });
    expect(screen.queryByTestId('import-file-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('import-error')).not.toBeInTheDocument();
  });

  it('«Убрать файл» removes the chosen archive and disables submit again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Import />);
    await user.upload(
      screen.getByTestId('import-file'),
      new File(['zip'], 'a.zip', { type: 'application/zip' }),
    );
    expect(screen.getByTestId('import-file-card')).toBeInTheDocument();

    await user.click(screen.getByTestId('import-file-remove'));
    expect(screen.queryByTestId('import-file-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('import-submit')).toBeDisabled();
    expect(screen.getByTestId('import-disabled-reason')).toHaveTextContent('Выберите архив');
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

  it('«Назад» in the header links to the start screen', () => {
    renderWithProviders(<Import />);
    expect(screen.getByTestId('aux-back')).toHaveAttribute('href', '/');
  });

  it('formats the file size in КБ and МБ', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Import />);

    // 2048 bytes → «2 КБ»
    await user.upload(
      screen.getByTestId('import-file'),
      new File([new Uint8Array(2048)], 'small.zip', { type: 'application/zip' }),
    );
    expect(screen.getByTestId('import-file-card')).toHaveTextContent('2 КБ');

    // 1.5 МБ → «1.5 МБ»
    await user.upload(
      screen.getByTestId('import-file'),
      new File([new Uint8Array(1.5 * 1024 * 1024)], 'big.zip', { type: 'application/zip' }),
    );
    expect(screen.getByTestId('import-file-card')).toHaveTextContent('1.5 МБ');
  });
});
