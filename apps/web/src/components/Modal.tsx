import { useEffect } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  widthClass?: string;
  testid?: string;
  /** Optional pill shown before the title (e.g. requirement type). */
  badge?: string;
}

/** Accessible modal shell: dimmed overlay, Esc to close, focus-trapped card. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  widthClass = 'max-w-xl',
  testid = 'modal',
  badge,
}: ModalProps): React.ReactElement {
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
    >
      <div
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
                style={{ background: 'var(--color-info-bg)', color: 'var(--color-info)' }}
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
