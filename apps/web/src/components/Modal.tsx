import { useRef } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

/**
 * task24: modal size variant.
 * - `default` — content-sized card capped by `widthClass` (unchanged behaviour).
 * - `large` — on ≥768px the card takes ~70% of the viewport in BOTH dimensions
 *   (70vw × ~70vh, rising to the 80vh ceiling (max 640px) on short screens)
 *   and the body becomes a flex column, so a child with
 *   `flex-1` (e.g. the AI-import log) stretches into the extra height.
 *   Below 768px it behaves exactly like `default` (near-full width, auto height).
 * - `xl` — like `large`, but ~90% of the viewport on ≥768px. For steps built
 *   around a long scrollable table (backlog review gate), where 70vh showed
 *   only ~3 rows at a time. Below 768px identical to `default`.
 */
export type ModalSize = 'default' | 'large' | 'xl';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  widthClass?: string;
  /** Size variant; keep `default` for every existing form dialog. */
  size?: ModalSize;
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
  size = 'default',
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

  // Esc closes only the TOP overlay (shared stack with ConfirmDialog): a
  // stacked dialog — LinkModal over the requirement card, a confirm over any
  // modal — never fires the close/cancel guard of the layer beneath it.
  useEscapeToClose(onClose);

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
        className={`card flex max-h-[90vh] w-full ${widthClass} flex-col p-0 shadow-lg ${
          // task24: `large` — ~70% of the viewport on desktop; the responsive
          // md:* classes override `widthClass` there, mobile stays as-is.
          // Height: ~70vh, but on short screens (e.g. 800px) rise to the 80vh
          // ceiling (capped at 640px) so the stretching log gets real room.
          size === 'large'
            ? 'md:h-[max(70vh,min(640px,80vh))] md:max-h-[80vh] md:w-[70vw] md:max-w-[70vw]'
            : size === 'xl'
              ? 'md:h-[90vh] md:max-h-[90vh] md:w-[92vw] md:max-w-[92vw]'
              : ''
        }`}
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
        <div
          data-testid={`${testid}-body`}
          className={
            size === 'large' || size === 'xl'
              ? // task24: flex column (gap-5 ≙ space-y-5) so a `flex-1` child
                // (the analysis log, the review table) soaks up the free height.
                'flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6'
              : 'flex-1 space-y-5 overflow-y-auto p-6'
          }
        >
          {children}
        </div>
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
