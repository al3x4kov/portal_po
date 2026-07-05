import { describe, it, expect, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Start } from './Start';
import { renderWithProviders } from '../test/utils';
import { RECENT_PROJECTS_KEY, type RecentProject } from '../lib/recentProjects';

beforeEach(() => localStorage.removeItem(RECENT_PROJECTS_KEY));

describe('Start page (T-602, todo_17 T2)', () => {
  it('shows three hero actions linking to New / Import / Open', () => {
    renderWithProviders(<Start />);
    expect(screen.getByTestId('start-new')).toHaveAttribute('href', '/new');
    expect(screen.getByTestId('start-import')).toHaveAttribute('href', '/import');
    expect(screen.getByTestId('start-open')).toHaveAttribute('href', '/open');
    expect(screen.getByText('Создать новый')).toBeInTheDocument();
    expect(screen.getByText('Импортировать')).toBeInTheDocument();
    expect(screen.getByText('Открыть существующий')).toBeInTheDocument();
    // Hero subtitle explains what a project is.
    expect(
      screen.getByText('Проект — это папка с .md-файлами в каталоге Projects/.'),
    ).toBeInTheDocument();
  });

  it('shows the recent-projects empty state when nothing was opened yet', () => {
    renderWithProviders(<Start />);
    expect(screen.getByTestId('recent-projects')).toBeInTheDocument();
    expect(screen.getByTestId('recent-empty')).toHaveTextContent(
      'Здесь появятся проекты, которые вы недавно открывали.',
    );
    expect(screen.queryByTestId('recent-list')).not.toBeInTheDocument();
  });

  it('renders recent projects from localStorage (name, path, link)', () => {
    const recents: RecentProject[] = [
      {
        id: 'portal',
        name: 'Портал поставщика',
        mainPath: '/Users/po/Projects/Портал_поставщика',
        openedAt: new Date().toISOString(),
      },
      {
        id: 'crm',
        name: 'Интеграция с CRM',
        mainPath: '/Users/po/Projects/Интеграция_CRM',
        openedAt: new Date().toISOString(),
      },
    ];
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recents));
    renderWithProviders(<Start />);

    const list = screen.getByTestId('recent-list');
    expect(within(list).getByText('Портал поставщика')).toBeInTheDocument();
    expect(screen.getByTestId('recent-project-portal')).toHaveAttribute('href', '/p/portal');
    expect(screen.getByTestId('recent-project-crm')).toHaveAttribute('href', '/p/crm');
    // Path is secondary and carries the full value in title.
    expect(within(list).getByTitle('/Users/po/Projects/Портал_поставщика')).toBeInTheDocument();
    expect(screen.queryByTestId('recent-empty')).not.toBeInTheDocument();
  });

  it('degrades to the empty state when localStorage holds garbage', () => {
    localStorage.setItem(RECENT_PROJECTS_KEY, 'не json');
    renderWithProviders(<Start />);
    expect(screen.getByTestId('recent-empty')).toBeInTheDocument();
  });

  it('renders the compact services section', () => {
    renderWithProviders(<Start />);
    expect(screen.getByTestId('services-section')).toBeInTheDocument();
    expect(screen.getByTestId('service-open-ai')).toBeInTheDocument();
  });
});
