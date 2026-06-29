import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Import } from './Import';
import { renderWithProviders } from '../test/utils';
import { ApiError } from '../api/client';

const importFn = vi.fn();

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
  beforeEach(() => importFn.mockReset());

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
});
