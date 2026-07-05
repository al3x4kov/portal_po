import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { BusyButton } from './BusyButton';

/**
 * Friction level 2 (confirm-dialog mockup, §2.4-1): the destructive button
 * stays disabled until the user types the exact expected name.
 */
export interface TypeToConfirm {
  /** The exact string the user must type (e.g. the project name). */
  expected: string;
  /** Label above the input. */
  label: string;
  placeholder?: string;
  /** data-testid of the input (kept configurable for the e2e contract). */
  inputTestid?: string;
  /** Micro-hint under the buttons explaining when the button activates. */
  hint?: string;
}

interface ConfirmDialogProps {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** Gerund shown on the confirm button while busy, e.g. «Удаляем…». */
  busyLabel?: React.ReactNode;
  /**
   * Disable the confirm button (UX-3): e.g. a requirement that still has
   * children cannot be deleted, so we prevent the click that would fail
   * server-side rather than surfacing the error after.
   */
  confirmDisabled?: boolean;
  /**
   * §2.13-2: the reason for `confirmDisabled`, rendered as a micro-hint right
   * under the buttons and wired to the button via aria-describedby/title —
   * never a silent dead button.
   */
  confirmDisabledReason?: string;
  /**
   * Icon shown in the tinted circle next to the title. `undefined` (default)
   * renders a Lucide trash can when `danger` (delete confirmations), nothing
   * otherwise. Pass a node for other destructive confirmations, or `null`
   * to hide the icon.
   */
  icon?: React.ReactNode | null;
  /** Tint of the icon circle; defaults to danger when `danger`, warning otherwise. */
  iconTone?: 'danger' | 'warning';
  /** Optional coloured note box (e.g. «детей нет — удаление безопасно»). */
  note?: { tone: 'success' | 'warning' | 'danger'; text: string };
  error?: string | null;
  /** data-testid of the error box (configurable for the e2e contract). */
  errorTestid?: string;
  /** Friction level 2: require typing `expected` before confirm activates. */
  typeToConfirm?: TypeToConfirm;
  onConfirm: () => void;
  onCancel: () => void;
  testid?: string;
}

const NOTE_STYLE: Record<'success' | 'warning' | 'danger', React.CSSProperties> = {
  success: { background: 'var(--color-success-bg)', color: 'var(--color-success-fg)' },
  warning: { background: 'var(--color-warning-bg)', color: 'var(--color-warning-fg)' },
  danger: { background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' },
};

/**
 * Generic confirmation dialog (FR-9) with friction levels proportional to risk
 * (confirm-dialog mockup): level 1 — plain confirm; level 2 — `typeToConfirm`
 * (retype the name). Level 0 (routine action, no confirm + toast) is a flow
 * convention of the callers, not a mode of this dialog.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Отменить',
  danger = false,
  busy = false,
  busyLabel,
  confirmDisabled = false,
  confirmDisabledReason,
  icon,
  iconTone,
  note,
  error,
  errorTestid,
  typeToConfirm,
  onConfirm,
  onCancel,
  testid = 'confirm-dialog',
}: ConfirmDialogProps): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  // UX-5: trap focus; default to the safe (Cancel) button. With a level-2
  // name input the input itself is the safe initial target — the destructive
  // button is guarded by the name check.
  useFocusTrap(dialogRef, { initialFocus: typeToConfirm ? inputRef : cancelRef });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // `undefined` = default (Lucide trash can for delete-style danger dialogs);
  // `null` = explicitly no icon; anything else renders as-is.
  const resolvedIcon =
    icon === undefined ? danger ? <Trash2 className="icon-sm" aria-hidden="true" /> : null : icon;
  const resolvedIconTone = iconTone ?? (danger ? 'danger' : 'warning');

  const nameMismatch = typeToConfirm ? typed.trim() !== typeToConfirm.expected : false;
  const disabled = confirmDisabled || nameMismatch;
  const reasonId = confirmDisabledReason ? `${testid}-disabled-reason` : undefined;

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
        aria-busy={busy || undefined}
        className="card w-full max-w-md p-5"
        data-testid={testid}
      >
        <div className="flex items-start gap-3">
          {resolvedIcon != null ? (
            <span
              className="grid h-9 w-9 flex-none place-items-center rounded-full"
              style={
                resolvedIconTone === 'danger'
                  ? { background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }
                  : { background: 'var(--color-warning-bg)', color: 'var(--color-warning-fg)' }
              }
              aria-hidden="true"
              data-testid={`${testid}-icon`}
            >
              {resolvedIcon}
            </span>
          ) : null}
          <div className="min-w-0">
            <h2 className="font-bold">{title}</h2>
            <div
              className="mt-1 text-sm"
              style={{ color: 'var(--color-text-2)' }}
              data-testid={`${testid}-message`}
            >
              {message}
            </div>
          </div>
        </div>

        {note ? (
          <div
            className="mt-3 rounded-lg px-3 py-2 text-xs"
            style={NOTE_STYLE[note.tone]}
            data-testid={`${testid}-note`}
          >
            {note.text}
          </div>
        ) : null}

        {typeToConfirm ? (
          <div className="mt-4">
            <label className="label" htmlFor={`${testid}-name-input`}>
              {typeToConfirm.label}
            </label>
            <input
              id={`${testid}-name-input`}
              ref={inputRef}
              className="input"
              placeholder={typeToConfirm.placeholder ?? typeToConfirm.expected}
              autoComplete="off"
              data-testid={typeToConfirm.inputTestid ?? `${testid}-input`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
            />
          </div>
        ) : null}

        {error ? (
          <div
            className="mt-3 rounded-lg p-3 text-sm"
            style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
            role="alert"
            data-testid={errorTestid ?? `${testid}-error`}
          >
            {error}
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-secondary"
            data-testid={`${testid}-cancel`}
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <BusyButton
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            busy={busy}
            busyLabel={busyLabel ?? confirmLabel}
            disabled={disabled}
            aria-describedby={reasonId}
            title={confirmDisabled ? confirmDisabledReason : undefined}
            data-testid={`${testid}-confirm`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </BusyButton>
        </div>

        {confirmDisabledReason ? (
          <p className="hint mt-2 text-right" id={reasonId} data-testid={reasonId}>
            {confirmDisabledReason}
          </p>
        ) : null}
        {typeToConfirm?.hint ? <p className="hint mt-2 text-right">{typeToConfirm.hint}</p> : null}
      </div>
    </div>
  );
}
