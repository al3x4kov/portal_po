import { useEffect, useRef } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface ConfirmDialogProps {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /**
   * Disable the confirm button with the reason shown in `note` (UX-3): e.g. a
   * requirement that still has children cannot be deleted, so we prevent the
   * click that would fail server-side rather than surfacing the error after.
   */
  confirmDisabled?: boolean;
  /**
   * Icon shown in the tinted circle above the title. `undefined` (default)
   * keeps the legacy behaviour — 🗑 when `danger` (delete confirmations),
   * nothing otherwise. Pass a node (e.g. '⏹' for "stop the job") for
   * non-delete destructive confirmations, or `null` to hide the icon.
   */
  icon?: React.ReactNode | null;
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
  confirmDisabled = false,
  icon,
  note,
  error,
  onConfirm,
  onCancel,
  testid = 'confirm-dialog',
}: ConfirmDialogProps): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // UX-5: trap focus and default to the safe (Cancel) button.
  useFocusTrap(dialogRef, { initialFocus: cancelRef });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // `undefined` = legacy default (trash can for delete-style danger dialogs);
  // `null` = explicitly no icon; anything else renders as-is.
  const resolvedIcon = icon === undefined ? (danger ? '🗑' : null) : icon;

  const noteStyle =
    note?.tone === 'danger'
      ? { background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }
      : { background: 'var(--color-warning-bg)', color: 'var(--color-warning-fg)' };

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center p-4"
      style={{ background: 'rgba(15,23,42,.5)' }}
      data-testid={`${testid}-overlay`}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="card w-full max-w-md p-6"
        data-testid={testid}
      >
        {resolvedIcon != null ? (
          <div
            className="mb-4 grid h-11 w-11 place-items-center rounded-full text-xl"
            style={
              danger
                ? { background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }
                : { background: 'var(--color-warning-bg)', color: 'var(--color-warning-fg)' }
            }
            aria-hidden="true"
            data-testid={`${testid}-icon`}
          >
            {resolvedIcon}
          </div>
        ) : null}
        <h2 className="mb-1 text-lg font-bold">{title}</h2>
        <div
          className="mb-4 text-sm"
          style={{ color: 'var(--color-text-2)' }}
          data-testid={`${testid}-message`}
        >
          {message}
        </div>
        {note ? (
          <div
            className="mb-5 rounded-lg p-3 text-sm"
            style={noteStyle}
            data-testid={`${testid}-note`}
          >
            {note.text}
          </div>
        ) : null}
        {error ? (
          <div
            className="mb-5 rounded-lg p-3 text-sm"
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
            role="alert"
            data-testid={`${testid}-error`}
          >
            {error}
          </div>
        ) : null}
        <div className="flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-secondary"
            data-testid={`${testid}-cancel`}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            data-testid={`${testid}-confirm`}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
