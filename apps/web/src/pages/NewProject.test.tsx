import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewProject } from './NewProject';
import { renderWithProviders } from '../test/utils';
import { ApiError } from '../api/client';
import { sampleProjects } from '../test/fixtures';
import { RECENT_PROJECTS_KEY, readRecentProjects } from '../lib/recentProjects';

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

describe('NewProject (T-603, FR-2, todo_17 T2)', () => {
  beforeEach(() => {
    create.mockReset();
    localStorage.removeItem(RECENT_PROJECTS_KEY);
  });

  it('autofocuses the name field and shows the allowed-characters hint', () => {
    renderWithProviders(<NewProject />);
    expect(screen.getByTestId('newproject-name')).toHaveFocus();
    expect(
      screen.getByText('Допустимы буквы, цифры, пробел, дефис и подчёркивание.'),
    ).toBeInTheDocument();
  });

  it('live-previews the path as «Будет создан проект: Projects/<имя>»', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewProject />);

    const preview = screen.getByTestId('newproject-path-preview');
    expect(preview).toHaveTextContent('Будет создан проект:');
    expect(preview).toHaveTextContent('Projects/<имя>');

    await user.type(screen.getByTestId('newproject-name'), 'Портал поставщика');
    expect(preview).toHaveTextContent('Projects/Портал поставщика');
    // Submit is enabled once the name is non-empty.
    expect(screen.getByTestId('newproject-submit')).toBeEnabled();
  });

  it('blocks a taken name using the API 409 response', async () => {
    create.mockRejectedValueOnce(new ApiError(409, { code: 'CONFLICT', message: 'exists' }));
    const user = userEvent.setup();
    renderWithProviders(<NewProject />);

    await user.type(screen.getByTestId('newproject-name'), 'payments-platform');
    await user.click(screen.getByTestId('newproject-submit'));

    expect(await screen.findByTestId('newproject-error')).toHaveTextContent(
      'Проект с таким именем уже есть',
    );
  });

  it('shows the success state with Main Path and remembers the project in recents', async () => {
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
    expect(screen.getByTestId('newproject-success')).toHaveTextContent(
      'Проект «payments-platform» создан',
    );
    expect(screen.getByTestId('newproject-open')).toBeInTheDocument();
    expect(screen.getByTestId('newproject-back')).toHaveAttribute('href', '/');

    // po.recentProjects gets the created project on top.
    const recents = readRecentProjects();
    expect(recents[0]?.id).toBe('payments-platform');
    expect(recents[0]?.mainPath).toBe('/Projects/payments-platform');
  });
});
