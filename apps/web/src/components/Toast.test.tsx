import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast, type ToastTone } from './Toast';

function Emitter({ tone = 'success' }: { tone?: ToastTone }): React.ReactElement {
  const { show } = useToast();
  return (
    <button type="button" data-testid="emit" onClick={() => show('Требование создано', tone)}>
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

  it('is positioned above the chat FAB via --toast-offset', () => {
    render(
      <ToastProvider>
        <span />
      </ToastProvider>,
    );
    expect(screen.getByTestId('toast-region').style.bottom).toBe('var(--toast-offset)');
  });

  it('keeps error toasts for 8 seconds (longer than success)', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Emitter tone="error" />
      </ToastProvider>,
    );
    act(() => {
      screen.getByTestId('emit').click();
    });
    expect(screen.getByTestId('toast')).toHaveAttribute('data-tone', 'error');
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    // Success would already be gone; an error toast is still visible.
    expect(screen.getByTestId('toast')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });

  it('pauses the auto-dismiss timer on hover and resumes with remaining time', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Emitter tone="error" />
      </ToastProvider>,
    );
    act(() => {
      screen.getByTestId('emit').click();
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    fireEvent.mouseEnter(screen.getByTestId('toast'));
    // Way past the nominal 8 s — hover keeps it alive.
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(screen.getByTestId('toast')).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByTestId('toast'));
    // 6 s were remaining when paused; not gone yet after 5 s…
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('toast')).toBeInTheDocument();
    // …gone once the remaining time fully elapses.
    act(() => {
      vi.advanceTimersByTime(1100);
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
