import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

export type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastApi {
  /** Show a non-blocking, auto-dismissing toast (aria-live). */
  show: (message: string, tone?: ToastTone) => void;
}

/** Default no-op so components using `useToast` work without a provider (tests). */
const ToastContext = createContext<ToastApi>({ show: () => {} });

const TONE_STYLE: Record<ToastTone, React.CSSProperties> = {
  success: { background: 'var(--color-success-bg)', color: 'var(--color-success-fg)' },
  error: { background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' },
  info: { background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' },
};

const AUTO_DISMISS_MS = 3500;

/**
 * Lightweight toast host (UX-2): renders a polite aria-live region so successful
 * create/update/delete operations get non-blocking, auto-dismissing feedback.
 */
export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'success'): void => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, tone }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-[100] flex flex-col items-end gap-2"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="toast-region"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="flex max-w-sm items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg"
            style={TONE_STYLE[t.tone]}
            data-testid="toast"
            data-tone={t.tone}
          >
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
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Access the toast API. Safe to call without a provider (no-op fallback). */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}
