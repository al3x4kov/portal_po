import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OpenExisting } from './OpenExisting';
import { renderWithProviders } from '../test/utils';
import { sampleProjects } from '../test/fixtures';

const list = vi.fn();
const remove = vi.fn();

vi.mock('../api/endpoints', () => ({
  projectsApi: {
    list: () => list(),
    create: vi.fn(),
    get: vi.fn(),
    import: vi.fn(),
    export: vi.fn(),
    remove: (id: string) => remove(id),
  },
  requirementsApi: {},
  linksApi: {},
}));

beforeEach(() => {
  list.mockReset();
  remove.mockReset();
});

describe('OpenExisting (T-603, FR-4)', () => {
  it('renders the project list from GET /api/projects', async () => {
    list.mockResolvedValueOnce(sampleProjects);
    renderWithProviders(<OpenExisting />);

    expect(await screen.findByTestId('open-list')).toBeInTheDocument();
    expect(screen.getByTestId('open-project-payments-platform')).toHaveAttribute(
      'href',
      '/p/payments-platform',
    );
    expect(screen.getByText('imported-crm')).toBeInTheDocument();
  });

  it('shows an empty state when there are no projects', async () => {
    list.mockResolvedValueOnce([]);
    renderWithProviders(<OpenExisting />);
    expect(await screen.findByTestId('open-empty')).toBeInTheDocument();
  });

  it('uses a widened container so long paths have room (A1)', async () => {
    list.mockResolvedValueOnce(sampleProjects);
    renderWithProviders(<OpenExisting />);

    await screen.findByTestId('open-list');
    const container = screen.getByTestId('open-container');
    expect(container).toHaveClass('w-[min(56rem,calc(100vw-2rem))]');
  });

  it('truncates a ~120-char path with the full path in title, name fully visible (A1)', async () => {
    const longPath = `/Users/someone/Documents/very/deep/nested/workspace/${'segment/'.repeat(7)}Projects/long-project`;
    expect(longPath.length).toBeGreaterThanOrEqual(120);

    list.mockResolvedValueOnce([
      {
        id: 'long-project',
        name: 'long-project',
        mainPath: longPath,
        createdAt: '2026-01-03T00:00:00.000Z',
      },
    ]);
    renderWithProviders(<OpenExisting />);

    await screen.findByTestId('open-list');

    // Path: secondary text, truncated with ellipsis, full path available via title.
    const path = screen.getByTestId('open-project-path-long-project');
    expect(path).toHaveTextContent('long-project');
    expect(path).toHaveClass('truncate');
    expect(path).toHaveAttribute('title', longPath);

    // Name stays fully visible (allowed to wrap, never truncated).
    const name = screen.getByText('long-project', { selector: 'span.font-medium' });
    expect(name).toHaveClass('break-words');
    expect(name).not.toHaveClass('truncate');
  });
});

describe('OpenExisting — project deletion (B1, todo_16)', () => {
  it('opens the confirm dialog from the trash button; cancel deletes nothing', async () => {
    list.mockResolvedValue(sampleProjects);
    renderWithProviders(<OpenExisting />);
    const user = userEvent.setup();

    await screen.findByTestId('open-list');
    await user.click(screen.getByTestId('project-delete-payments-platform'));

    const dialog = await screen.findByTestId('project-delete-dialog');
    expect(dialog).toHaveTextContent('Удалить проект');
    expect(screen.getByTestId('project-delete-dialog-message')).toHaveTextContent(
      'Проект „payments-platform“ и все его файлы будут удалены с диска. Действие необратимо.',
    );

    await user.click(screen.getByTestId('project-delete-dialog-cancel'));

    expect(screen.queryByTestId('project-delete-dialog')).not.toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByTestId('open-project-payments-platform')).toBeInTheDocument();
  });

  it('confirm calls DELETE, removes the project from the list and shows a success toast', async () => {
    list
      .mockResolvedValueOnce(sampleProjects) // initial load
      .mockResolvedValue([sampleProjects[1]]); // refetch after invalidation
    remove.mockResolvedValue(null); // 204 → empty body
    renderWithProviders(<OpenExisting />);
    const user = userEvent.setup();

    await screen.findByTestId('open-list');
    await user.click(screen.getByTestId('project-delete-payments-platform'));
    await user.click(screen.getByTestId('project-delete-dialog-confirm'));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('payments-platform'));
    // The list updates without a page reload (query invalidation).
    await waitFor(() =>
      expect(screen.queryByTestId('open-project-payments-platform')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('open-project-imported-crm')).toBeInTheDocument();
    expect(screen.queryByTestId('project-delete-dialog')).not.toBeInTheDocument();

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent('Проект «payments-platform» удалён');
    expect(toast).toHaveAttribute('data-tone', 'success');
  });

  it('shows an error toast and closes the dialog when DELETE fails; project stays', async () => {
    list.mockResolvedValue(sampleProjects);
    remove.mockRejectedValue(new Error('Проект не найден'));
    renderWithProviders(<OpenExisting />);
    const user = userEvent.setup();

    await screen.findByTestId('open-list');
    await user.click(screen.getByTestId('project-delete-imported-crm'));
    await user.click(screen.getByTestId('project-delete-dialog-confirm'));

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent('Проект не найден');
    expect(toast).toHaveAttribute('data-tone', 'error');
    // Dialog is closed, nothing disappeared from the list.
    expect(screen.queryByTestId('project-delete-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('open-project-imported-crm')).toBeInTheDocument();
  });
});
