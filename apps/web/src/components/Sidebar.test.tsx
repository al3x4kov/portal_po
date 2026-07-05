import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from './Sidebar';
import { renderWithProviders } from '../test/utils';
import { useUiStore } from '../store/ui';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

function renderSidebar(activePage: 'requirements' | 'dashboard' | 'ai' = 'requirements'): {
  onOpenExport: ReturnType<typeof vi.fn>;
  onOpenTasks: ReturnType<typeof vi.fn>;
} {
  const onOpenExport = vi.fn();
  const onOpenTasks = vi.fn();
  renderWithProviders(
    <Sidebar
      projectId="p42"
      activePage={activePage}
      onOpenExport={onOpenExport}
      onOpenTasks={onOpenTasks}
    />,
  );
  return { onOpenExport, onOpenTasks };
}

describe('Sidebar (T3, new_design §2.8)', () => {
  beforeEach(() => {
    navigate.mockClear();
    useUiStore.setState({ graphView: false });
  });

  it('renders navigation and actions zones separated by «Действия»', () => {
    renderSidebar();
    expect(screen.getByTestId('sidebar-nav-requirements')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-nav-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-nav-ai')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-nav-graph')).toBeInTheDocument();
    expect(screen.getByText('Действия')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-open-export')).toHaveAccessibleName('Экспорт проекта');
    expect(screen.getByTestId('sidebar-open-tasks')).toHaveAccessibleName('Генерация задач');
  });

  it('«PO» logo navigates to the Start screen', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByTestId('sidebar-home'));
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('«Граф связей» turns on the existing graph mode and navigates to the tree page', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByTestId('sidebar-nav-graph'));
    expect(useUiStore.getState().graphView).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/p/p42');
  });

  it('«Требования» switches graph mode off', async () => {
    useUiStore.setState({ graphView: true });
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByTestId('sidebar-nav-requirements'));
    expect(useUiStore.getState().graphView).toBe(false);
    expect(navigate).toHaveBeenCalledWith('/p/p42');
  });

  it('marks the graph item as current when graph mode is active on the requirements page', () => {
    useUiStore.setState({ graphView: true });
    renderSidebar('requirements');
    expect(screen.getByTestId('sidebar-nav-graph')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('sidebar-nav-requirements')).not.toHaveAttribute('aria-current');
  });

  it('invokes export and tasks actions', async () => {
    const user = userEvent.setup();
    const { onOpenExport, onOpenTasks } = renderSidebar();
    await user.click(screen.getByTestId('sidebar-open-export'));
    expect(onOpenExport).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('sidebar-open-tasks'));
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
  });
});
