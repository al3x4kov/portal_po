import { useEffect, useRef } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  widthClass?: string;
  testid?: string;
  /** Optional pill shown before the title (e.g. requirement type). */
  badge?: string;
  /**
   * Opt-in backdrop click handler (Task 11 AI-import modal: the spec requires
   * a click outside to behave like ✕ — guarded by its own ConfirmDialog while
   * a job is running). Absent by default, which keeps the UX-10 policy below
   * for every form-bearing dialog.
   */
  onOverlayClick?: () => void;
}

/**
 * Accessible modal shell: dimmed overlay, Esc to close, focus-trapped card.
 *
 * Scrim policy (UX-10): form-bearing dialogs (this Modal and ConfirmDialog) do
 * NOT close on a backdrop click — an accidental click must never discard typed
 * data; users close via Esc or the explicit ✕ / Cancel controls. Read-only
 * overlays (DescPanel drawer, ServiceScreen) DO close on scrim click, since
 * there is nothing to lose. Keep this split consistent across overlays.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  widthClass = 'max-w-xl',
  testid = 'modal',
  badge,
  onOverlayClick,
}: ModalProps): React.ReactElement {
  const cardRef = useRef<HTMLDivElement>(null);
  // UX-5: capture the opener during the first render — before the form's inner
  // `autoFocus` field mounts and steals `document.activeElement` — so Esc/close
  // returns focus to the trigger instead of dropping it to <body>.
  const openerRef = useRef<HTMLElement | null>(null);
  if (openerRef.current === null) {
    openerRef.current =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  }
  // UX-5: keep focus inside the dialog; preserves an inner autoFocus (see hook).
  useFocusTrap(cardRef, { restoreTo: openerRef });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4"
      style={{ background: 'rgba(15,23,42,.5)' }}
      data-testid={`${testid}-overlay`}
      onClick={
        onOverlayClick
          ? (e) => {
              if (e.target === e.currentTarget) onOverlayClick();
            }
          : undefined
      }
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testid}
        className={`card flex max-h-[90vh] w-full ${widthClass} flex-col p-0 shadow-lg`}
      >
        <header
          className="flex shrink-0 items-center justify-between border-b px-6 py-4"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <div className="flex items-center gap-3">
            {badge ? (
              <span
                className="badge"
                style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
                data-testid={`${testid}-badge`}
              >
                {badge}
              </span>
            ) : null}
            <h2 className="text-lg font-bold">{title}</h2>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            aria-label="Закрыть"
            data-testid={`${testid}-close`}
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto p-6">{children}</div>
        {footer ? (
          <footer
            className="flex shrink-0 justify-end gap-3 border-t px-6 py-4"
            style={{ borderColor: 'var(--color-border)' }}
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
