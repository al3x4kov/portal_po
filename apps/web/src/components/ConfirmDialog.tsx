import { useEffect } from 'react';

interface ConfirmDialogProps {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** Optional coloured note box (e.g. children-safety hint for delete). */
  note?: { tone: 'warning' | 'danger'; text: string };
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  testid?: string;
}

/** Generic confirmation dialog; destructive styling when `danger` (FR-9). */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Отменить',
  danger = false,
  busy = false,
  note,
  error,
  onConfirm,
  onCancel,
  testid = 'confirm-dialog',
}: ConfirmDialogProps): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const noteStyle =
    note?.tone === 'danger'
      ? { background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }
      : { background: 'var(--color-warning-bg)', color: 'var(--color-warning)' };

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center p-4"
      style={{ background: 'rgba(15,23,42,.5)' }}
      data-testid={`${testid}-overlay`}
    >
      <div role="alertdialog" aria-modal="true" aria-label={title} className="card w-full max-w-md p-6" data-testid={testid}>
        {danger ? (
          <div
            className="mb-4 grid h-11 w-11 place-items-center rounded-full text-xl"
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}
            aria-hidden="true"
          >
            🗑
          </div>
        ) : null}
        <h2 className="mb-1 text-lg font-bold">{title}</h2>
        <div className="mb-4 text-sm" style={{ color: 'var(--color-text-2)' }} data-testid={`${testid}-message`}>
          {message}
        </div>
        {note ? (
          <div className="mb-5 rounded-lg p-3 text-sm" style={noteStyle} data-testid={`${testid}-note`}>
            {note.text}
          </div>
        ) : null}
        {error ? (
          <div
            className="mb-5 rounded-lg p-3 text-sm"
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}
            role="alert"
            data-testid={`${testid}-error`}
          >
            {error}
          </div>
        ) : null}
        <div className="flex justify-end gap-3">
          <button type="button" className="btn btn-secondary" data-testid={`${testid}-cancel`} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            data-testid={`${testid}-confirm`}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
