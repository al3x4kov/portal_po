import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeToggle } from './ThemeToggle';
import { useUiStore } from '../store/ui';

describe('ThemeToggle (UX-10)', () => {
  it('shows a sun glyph in light theme and a moon glyph in dark theme', async () => {
    useUiStore.setState({ theme: 'light' });
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const btn = screen.getByTestId('theme-toggle');
    expect(btn).toHaveAttribute('data-theme', 'light');
    expect(btn).toHaveTextContent('☀');
    expect(btn).not.toHaveTextContent('☾');

    await user.click(btn);

    expect(btn).toHaveAttribute('data-theme', 'dark');
    expect(btn).toHaveTextContent('☾');
    expect(btn).not.toHaveTextContent('☀');
  });
});
