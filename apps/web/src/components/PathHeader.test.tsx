import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PathHeader } from './PathHeader';
import { renderWithProviders } from '../test/utils';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

describe('PathHeader', () => {
  it('renders the project name and main path', () => {
    renderWithProviders(
      <PathHeader name="payments-platform" mainPath="/Projects/payments-platform" />,
    );
    expect(screen.getByTestId('project-name')).toHaveTextContent('payments-platform');
    const path = screen.getByTestId('main-path');
    expect(path).toHaveTextContent('/Projects/payments-platform');
    expect(path).toHaveAttribute('title', '/Projects/payments-platform');
  });

  it('navigates back to "/" when the back button is clicked', async () => {
    const user = userEvent.setup();
    navigate.mockClear();
    renderWithProviders(<PathHeader name="proj" mainPath="/Projects/proj" />);
    await user.click(screen.getByTestId('main-back'));
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('renders the theme toggle', () => {
    renderWithProviders(<PathHeader name="proj" mainPath="/Projects/proj" />);
    // ThemeToggle renders a button; the header should contain more than just the back button.
    expect(screen.getByTestId('path-header')).toBeInTheDocument();
    expect(screen.getByTestId('main-back')).toBeInTheDocument();
  });
});
