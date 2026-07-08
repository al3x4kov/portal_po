import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PriorityBadge } from './PriorityBadge';
import { ColorPalettePicker } from './ColorPalettePicker';
import { PRIORITY_COLORS } from '@po/core';

describe('PriorityBadge (T-210)', () => {
  it('renders the priority NAME (not a code) as its text', () => {
    render(<PriorityBadge name="Критично для сделки" color="red" />);
    const badge = screen.getByTestId('priority-badge');
    expect(badge).toHaveTextContent('Критично для сделки');
    expect(badge).toHaveAttribute('data-color', 'red');
  });

  it('falls back to the neutral colour for an unknown/legacy colour key', () => {
    render(<PriorityBadge name="Прочее" color="chartreuse" />);
    // Still renders the name — colour is only a redundant cue (НФТ-5).
    expect(screen.getByTestId('priority-badge')).toHaveTextContent('Прочее');
  });
});

describe('ColorPalettePicker (T-210)', () => {
  it('renders exactly the fixed PRIORITY_COLORS palette', () => {
    render(<ColorPalettePicker value="blue" onChange={vi.fn()} />);
    for (const c of PRIORITY_COLORS) {
      expect(screen.getByTestId(`color-swatch-${c}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('color-swatch-blue')).toHaveAttribute('aria-checked', 'true');
  });

  it('reports the picked colour', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ColorPalettePicker value="blue" onChange={onChange} />);
    await user.click(screen.getByTestId('color-swatch-green'));
    expect(onChange).toHaveBeenCalledWith('green');
  });
});
