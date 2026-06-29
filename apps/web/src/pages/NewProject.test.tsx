import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewProject } from './NewProject';
import { renderWithProviders } from '../test/utils';
import { ApiError } from '../api/client';
import { sampleProjects } from '../test/fixtures';

const create = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    create: (name: string) => create(name),
    list: vi.fn(),
    get: vi.fn(),
    import: vi.fn(),
    export: vi.fn(),
  },
  requirementsApi: {},
  linksApi: {},
}));

describe('NewProject (T-603, FR-2)', () => {
  beforeEach(() => create.mockReset());

  it('blocks a taken name using the API 409 response', async () => {
    create.mockRejectedValueOnce(new ApiError(409, { code: 'CONFLICT', message: 'exists' }));
    const user = userEvent.setup();
    renderWithProviders(<NewProject />);

    await user.type(screen.getByTestId('newproject-name'), 'payments-platform');
    await user.click(screen.getByTestId('newproject-submit'));

    expect(await screen.findByTestId('newproject-error')).toHaveTextContent(
      'Каталог с таким именем уже есть',
    );
  });

  it('shows the Main Path after successful creation', async () => {
    create.mockResolvedValueOnce(sampleProjects[0]);
    const user = userEvent.setup();
    renderWithProviders(<NewProject />);

    await user.type(screen.getByTestId('newproject-name'), 'payments-platform');
    await user.click(screen.getByTestId('newproject-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('newproject-mainpath')).toHaveTextContent(
        '/Projects/payments-platform',
      ),
    );
  });
});
