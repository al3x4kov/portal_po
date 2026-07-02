import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast } from './Toast';

function Emitter(): React.ReactElement {
  const { show } = useToast();
  return (
    <button type="button" data-testid="emit" onClick={() => show('Требование создано', 'success')}>
      emit
    </button>
  );
}

describe('ToastProvider (UX-2)', () => {
  afterEach(() => vi.useRealTimers());

  it('is a polite aria-live region', () => {
    render(
      <ToastProvider>
        <span />
      </ToastProvider>,
    );
    const region = screen.getByTestId('toast-region');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('shows a toast on demand and lets the user dismiss it', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Emitter />
      </ToastProvider>,
    );
    await user.click(screen.getByTestId('emit'));
    expect(screen.getByTestId('toast')).toHaveTextContent('Требование создано');
    await user.click(screen.getByTestId('toast-dismiss'));
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });

  it('auto-dismisses after the timeout', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Emitter />
      </ToastProvider>,
    );
    act(() => {
      screen.getByTestId('emit').click();
    });
    expect(screen.getByTestId('toast')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });

  it('useToast is a no-op without a provider', async () => {
    const user = userEvent.setup();
    render(<Emitter />);
    await user.click(screen.getByTestId('emit'));
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });
});
