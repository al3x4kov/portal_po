import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OpenExisting } from './OpenExisting';
import { renderWithProviders } from '../test/utils';
import { sampleProjects } from '../test/fixtures';
import { RECENT_PROJECTS_KEY, rememberRecentProject } from '../lib/recentProjects';
import type { ProjectSummary } from '../api/types';

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
  localStorage.removeItem(RECENT_PROJECTS_KEY);
});

function makeProject(id: string): ProjectSummary {
  return {
    id,
    name: id,
    mainPath: `/Projects/${id}`,
    createdAt: '2026-01-03T00:00:00.000Z',
  };
}

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
    const name = screen.getByText('long-project', { selector: 'span.font-semibold' });
    expect(name).toHaveClass('break-words');
    expect(name).not.toHaveClass('truncate');
  });
});

describe('OpenExisting — фильтр-поиск (§2.4-2, todo_17 T2)', () => {
  const eight = Array.from({ length: 8 }, (_, i) => makeProject(`proj-${i}`));

  it('hides the filter for short lists (fewer than 8 projects)', async () => {
    list.mockResolvedValueOnce(sampleProjects);
    renderWithProviders(<OpenExisting />);
    await screen.findByTestId('open-list');
    expect(screen.queryByTestId('project-filter')).not.toBeInTheDocument();
  });

  it('filters the list by name with 8+ projects', async () => {
    list.mockResolvedValueOnce(eight);
    renderWithProviders(<OpenExisting />);
    const user = userEvent.setup();

    await screen.findByTestId('open-list');
    const filter = screen.getByTestId('project-filter');
    expect(filter).toHaveAttribute('placeholder', 'Найти проект…');

    await user.type(filter, 'proj-3');
    const listEl = screen.getByTestId('open-list');
    expect(within(listEl).getAllByRole('link')).toHaveLength(1);
    expect(screen.getByTestId('open-project-proj-3')).toBeInTheDocument();
  });

  it('shows «Ничего не найдено…» when the filter matches nothing', async () => {
    list.mockResolvedValueOnce(eight);
    renderWithProviders(<OpenExisting />);
    const user = userEvent.setup();

    await screen.findByTestId('open-list');
    await user.type(screen.getByTestId('project-filter'), 'нет такого');

    expect(screen.queryByTestId('open-list')).not.toBeInTheDocument();
    expect(screen.getByTestId('open-filter-empty')).toHaveTextContent(
      'Ничего не найдено по запросу «нет такого».',
    );
  });
});

describe('OpenExisting — удаление с подтверждением вводом имени (§2.4-1/-4, todo_17 T2)', () => {
  it('opens the dialog; confirm is disabled until the exact name is typed', async () => {
    list.mockResolvedValue(sampleProjects);
    renderWithProviders(<OpenExisting />);
    const user = userEvent.setup();

    await screen.findByTestId('open-list');
    await user.click(screen.getByTestId('project-delete-payments-platform'));

    const dialog = await screen.findByTestId('project-delete-dialog');
    expect(dialog).toHaveTextContent('Удалить проект «payments-platform»?');
    expect(screen.getByTestId('project-delete-dialog-message')).toHaveTextContent(
      'Папка проекта и все .md-файлы требований будут удалены с диска безвозвратно.',
    );
    expect(dialog).toHaveTextContent('Кнопка активируется при точном совпадении имени');

    const confirm = screen.getByTestId('project-delete-dialog-confirm');
    expect(confirm).toBeDisabled();

    await user.type(screen.getByTestId('delete-confirm-input'), 'не то имя');
    expect(confirm).toBeDisabled();

    await user.clear(screen.getByTestId('delete-confirm-input'));
    await user.type(screen.getByTestId('delete-confirm-input'), 'payments-platform');
    expect(confirm).toBeEnabled();
  });

  it('cancel closes the dialog and deletes nothing', async () => {
    list.mockResolvedValue(sampleProjects);
    renderWithProviders(<OpenExisting />);
    const user = userEvent.setup();

    await screen.findByTestId('open-list');
    await user.click(screen.getByTestId('project-delete-payments-platform'));
    await screen.findByTestId('project-delete-dialog');
    await user.click(screen.getByTestId('project-delete-dialog-cancel'));

    expect(screen.queryByTestId('project-delete-dialog')).not.toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByTestId('open-project-payments-platform')).toBeInTheDocument();
  });

  it('confirm calls DELETE, updates the list, drops recents and shows a success toast', async () => {
    rememberRecentProject({ id: 'payments-platform', name: 'payments-platform' });
    list
      .mockResolvedValueOnce(sampleProjects) // initial load
      .mockResolvedValue([sampleProjects[1]]); // refetch after invalidation
    remove.mockResolvedValue(null); // 204 → empty body
    renderWithProviders(<OpenExisting />);
    const user = userEvent.setup();

    await screen.findByTestId('open-list');
    await user.click(screen.getByTestId('project-delete-payments-platform'));
    await user.type(screen.getByTestId('delete-confirm-input'), 'payments-platform');
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

    // Recents no longer offer the deleted project.
    expect(localStorage.getItem(RECENT_PROJECTS_KEY)).not.toContain('payments-platform');
  });

  it('shows the DELETE error INSIDE the open dialog; the project stays', async () => {
    list.mockResolvedValue(sampleProjects);
    remove.mockRejectedValue(new Error('Файл занят другим процессом'));
    renderWithProviders(<OpenExisting />);
    const user = userEvent.setup();

    await screen.findByTestId('open-list');
    await user.click(screen.getByTestId('project-delete-imported-crm'));
    await user.type(screen.getByTestId('delete-confirm-input'), 'imported-crm');
    await user.click(screen.getByTestId('project-delete-dialog-confirm'));

    // §2.4-4: the dialog does NOT close, the error is rendered inside it.
    const error = await screen.findByTestId('delete-error');
    expect(error).toHaveTextContent('Файл занят другим процессом');
    expect(screen.getByTestId('project-delete-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('project-delete-dialog-confirm')).toHaveTextContent(
      'Повторить удаление',
    );
    expect(screen.getByTestId('open-project-imported-crm')).toBeInTheDocument();
  });
});
