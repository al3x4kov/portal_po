import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { App, AppRoutes, createQueryClient } from './App';
import { renderWithProviders } from './test/utils';
import { useUiStore } from './store/ui';

describe('App routing (T-601/T-602)', () => {
  it('renders the start page at "/"', () => {
    renderWithProviders(<AppRoutes />, { route: '/' });
    expect(screen.getByTestId('start-page')).toBeInTheDocument();
    expect(screen.getByText('С чего начнём?')).toBeInTheDocument();
  });

  it('renders the new-project page at "/new"', () => {
    renderWithProviders(<AppRoutes />, { route: '/new' });
    expect(screen.getByTestId('newproject-page')).toBeInTheDocument();
  });
});

describe('App shell (createQueryClient / ThemeApplier / App)', () => {
  afterEach(() => {
    window.history.pushState({}, '', '/');
    document.documentElement.classList.remove('dark');
  });

  it('createQueryClient builds a QueryClient with retries disabled', () => {
    const qc = createQueryClient();
    expect(qc).toBeInstanceOf(QueryClient);
    const opts = qc.getDefaultOptions();
    expect(opts.queries?.retry).toBe(false);
    expect(opts.queries?.refetchOnWindowFocus).toBe(false);
  });

  it('mounts the full App and applies the persisted dark theme via ThemeApplier', () => {
    useUiStore.setState({ theme: 'dark' });
    window.history.pushState({}, '', '/');
    render(<App />);
    // App mounts the router (Start at "/") and the floating chat FAB.
    expect(screen.getByTestId('start-page')).toBeInTheDocument();
    // ThemeApplier syncs the <html> `dark` class to the store.
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      useUiStore.setState({ theme: 'light' });
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
