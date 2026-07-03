import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GraphToolbar } from './GraphToolbar';

function setup(overrides: Partial<React.ComponentProps<typeof GraphToolbar>> = {}) {
  const props = {
    showNfr: true,
    onToggleNfr: vi.fn(),
    showEdgeLabels: false,
    onToggleEdgeLabels: vi.fn(),
    onRelayout: vi.fn(),
    ...overrides,
  };
  render(<GraphToolbar {...props} />);
  return props;
}

describe('GraphToolbar', () => {
  it('renders the toolbar container', () => {
    setup();
    expect(screen.getByTestId('graph-toolbar')).toBeInTheDocument();
  });

  it('fires onRelayout when the relayout button is clicked', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByTestId('graph-relayout'));
    expect(props.onRelayout).toHaveBeenCalledTimes(1);
  });

  it('fires onToggleNfr when the NFR button is clicked', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByTestId('graph-toggle-nfr'));
    expect(props.onToggleNfr).toHaveBeenCalledTimes(1);
  });

  it('fires onToggleEdgeLabels when the labels button is clicked', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByTestId('graph-toggle-labels'));
    expect(props.onToggleEdgeLabels).toHaveBeenCalledTimes(1);
  });

  it('shows the NFR button as pressed and labelled "вкл" when showNfr=true', () => {
    setup({ showNfr: true });
    const btn = screen.getByTestId('graph-toggle-nfr');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveTextContent('НФТ вкл');
    expect(btn).toHaveAttribute('title', 'Скрыть НФТ');
    expect(btn.className).toContain('btn-primary');
  });

  it('shows the NFR button as un-pressed and labelled "выкл" when showNfr=false', () => {
    setup({ showNfr: false });
    const btn = screen.getByTestId('graph-toggle-nfr');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveTextContent('НФТ выкл');
    expect(btn).toHaveAttribute('title', 'Показать НФТ');
    expect(btn.className).toContain('btn-secondary');
  });

  it('shows the edge-labels button as pressed when showEdgeLabels=true', () => {
    setup({ showEdgeLabels: true });
    const btn = screen.getByTestId('graph-toggle-labels');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAttribute('title', 'Скрыть метки рёбер');
    expect(btn.className).toContain('btn-primary');
  });

  it('shows the edge-labels button as un-pressed when showEdgeLabels=false', () => {
    setup({ showEdgeLabels: false });
    const btn = screen.getByTestId('graph-toggle-labels');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveAttribute('title', 'Показать метки рёбер');
    expect(btn.className).toContain('btn-secondary');
  });
});
