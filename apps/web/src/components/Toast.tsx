import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';

export type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastApi {
  /** Show non-blocking, auto-dismissing toast (aria-live). */
  show: (message: string, tone?: ToastTone) => void;
}

/** Default no-op so components using `useToast` work without provider (tests). */
const ToastContext = createContext<ToastApi>({ show: () => {} });

const TONE_STYLE: Record<ToastTone, React.CSSProperties> = {
  success: { background: 'var(--color-success-bg)', color: 'var(--color-success-fg)' },
  error: { background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' },
  info: { background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' },
};

const TONE_ICON: Record<ToastTone, LucideIcon> = {
  success: CircleCheck,
  error: TriangleAlert,
  info: Info,
};

/** Error toasts stay longer (8 s) so the message can actually be read. */
const AUTO_DISMISS_MS: Record<ToastTone, number> = {
  success: 3500,
  info: 3500,
  error: 8000,
};

interface ToastTimer {
  handle: ReturnType<typeof setTimeout>;
  /** Absolute epoch-ms when the toast should dismiss (to compute remaining on pause). */
  expiresAt: number;
  /** Milliseconds left when paused. */
  remaining: number;
  paused: boolean;
}

/**
 * Lightweight toast host (UX-2): renders polite aria-live region so successful
 * create/update/delete operations get non-blocking, auto-dismissing feedback.
 * Positioned ABOVE the chat FAB (`bottom: var(--toast-offset)`); hovering a
 * toast pauses its auto-dismiss timer (resumes with the remaining time).
 */
export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ToastTimer>());

  const dismiss = useCallback((id: number): void => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer.handle);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const startTimer = useCallback(
    (id: number, ms: number): void => {
      const handle = setTimeout(() => dismiss(id), ms);
      timers.current.set(id, { handle, expiresAt: Date.now() + ms, remaining: ms, paused: false });
    },
    [dismiss],
  );

  /** Pause auto-dismiss while the pointer is over the toast. */
  const pause = useCallback((id: number): void => {
    const timer = timers.current.get(id);
    if (!timer || timer.paused) return;
    clearTimeout(timer.handle);
    timer.remaining = Math.max(0, timer.expiresAt - Date.now());
    timer.paused = true;
  }, []);

  /** Resume the timer with whatever time was left when paused. */
  const resume = useCallback(
    (id: number): void => {
      const timer = timers.current.get(id);
      if (!timer || !timer.paused) return;
      startTimer(id, Math.max(timer.remaining, 500));
    },
    [startTimer],
  );

  const show = useCallback(
    (message: string, tone: ToastTone = 'success'): void => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, tone }]);
      startTimer(id, AUTO_DISMISS_MS[tone]);
    },
    [startTimer],
  );

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="fixed right-4 z-[100] flex flex-col items-end gap-2"
        style={{ bottom: 'var(--toast-offset)' }}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="toast-region"
      >
        {toasts.map((t) => {
          const ToneIcon = TONE_ICON[t.tone];
          return (
            <div
              key={t.id}
              className="flex max-w-sm items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg"
              style={TONE_STYLE[t.tone]}
              data-testid="toast"
              data-tone={t.tone}
              onMouseEnter={() => pause(t.id)}
              onMouseLeave={() => resume(t.id)}
            >
              <ToneIcon className="icon-sm" aria-hidden="true" />
              <span className="min-w-0 flex-1">{t.message}</span>
              <button
                type="button"
                className="shrink-0 opacity-70 hover:opacity-100"
                aria-label="Закрыть уведомление"
                data-testid="toast-dismiss"
                onClick={() => dismiss(t.id)}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** Access the toast API. Safe to call without a provider (no-op fallback). */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}
