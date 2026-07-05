interface BusyButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** True while the request is in flight: disables the button, shows spinner + gerund. */
  busy?: boolean;
  /** Gerund label shown while busy, e.g. «Сохраняем…», «Создаём…». Falls back to children. */
  busyLabel?: React.ReactNode;
}

/**
 * Button with a busy state (design pattern «спиннер + герундий»):
 * while `busy` it is disabled, gets `aria-busy` and renders a `.spinner`
 * followed by `busyLabel` («Сохраняем…») instead of its normal children.
 *
 * Styling comes from the shared `.btn .btn-*` classes — pass them via
 * `className` (default: `btn btn-primary`).
 */
export function BusyButton({
  busy = false,
  busyLabel,
  children,
  disabled,
  className = 'btn btn-primary',
  type = 'button',
  ...rest
}: BusyButtonProps): React.ReactElement {
  return (
    <button
      type={type}
      className={className}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? (
        <>
          <span className="spinner" aria-hidden="true" />
          {busyLabel ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}
