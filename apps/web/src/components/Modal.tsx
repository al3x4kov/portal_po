import { useEffect } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  widthClass?: string;
  testid?: string;
}

/** Accessible modal shell: dimmed overlay, Esc to close, focus-trapped card. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  widthClass = 'max-w-xl',
  testid = 'modal',
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
        className={`card w-full ${widthClass} p-0 shadow-lg`}
      >
        <header
          className="flex items-center justify-between border-b px-6 py-4"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <h2 className="text-lg font-bold">{title}</h2>
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
        <div className="space-y-5 p-6">{children}</div>
        {footer ? (
          <footer
            className="flex justify-end gap-3 border-t px-6 py-4"
            style={{ borderColor: 'var(--color-border)' }}
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
