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
  it('renders the project name (h1) and the mono main path', () => {
    renderWithProviders(
      <PathHeader name="payments-platform" mainPath="/Projects/payments-platform" />,
    );
    expect(screen.getByTestId('project-name')).toHaveTextContent('payments-platform');
    const path = screen.getByTestId('main-path');
    expect(path).toHaveTextContent('/Projects/payments-platform');
    expect(path).toHaveAttribute('title', '/Projects/payments-platform');
  });

  it('navigates back to "/" via «Проекты»', async () => {
    const user = userEvent.setup();
    navigate.mockClear();
    renderWithProviders(<PathHeader name="proj" mainPath="/Projects/proj" />);
    const back = screen.getByTestId('main-back');
    expect(back).toHaveTextContent('Проекты');
    await user.click(back);
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('copies the path to the clipboard on click and shows a toast (§2.9)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PathHeader name="proj" mainPath="/Projects/proj" />);
    const copyBtn = screen.getByTestId('copy-path');
    expect(copyBtn).toHaveTextContent('копируется по клику');
    await user.click(copyBtn);
    expect(await navigator.clipboard.readText()).toBe('/Projects/proj');
    expect(await screen.findByTestId('toast')).toHaveTextContent('Путь скопирован');
  });

  it('renders the theme toggle', () => {
    renderWithProviders(<PathHeader name="proj" mainPath="/Projects/proj" />);
    expect(screen.getByTestId('path-header')).toBeInTheDocument();
    expect(screen.getByTestId('main-back')).toBeInTheDocument();
  });
});
