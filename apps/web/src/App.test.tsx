import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { AppRoutes } from './App';
import { renderWithProviders } from './test/utils';

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
