import type { AiModelsNotice } from '../api/hooks';

/**
 * A3 (todo_16): shared bits of the «Обновить список моделей» UX used next to
 * every model select (AI screen, chat widget, AI-import modal). The refetch /
 * selection-reconciliation logic lives in `useAiModelsRefresh` (api/hooks.ts);
 * these components only render the button and the inline notice.
 */

const REFRESH_LABEL = 'Обновить список моделей';

function RefreshIcon({ spinning }: { spinning: boolean }): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={spinning ? 'animate-spin' : undefined}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export interface ModelRefreshButtonProps {
  /** data-testid, e.g. `ai-models-refresh` / `ai-models-refresh-chat`. */
  testid: string;
  refreshing: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export function ModelRefreshButton({
  testid,
  refreshing,
  disabled = false,
  onClick,
  className = 'btn btn-secondary',
  style,
}: ModelRefreshButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      className={className}
      style={style}
      title={REFRESH_LABEL}
      aria-label={REFRESH_LABEL}
      aria-busy={refreshing}
      data-testid={testid}
      disabled={disabled || refreshing}
      onClick={onClick}
    >
      <RefreshIcon spinning={refreshing} />
    </button>
  );
}

export interface ModelListNoticeProps {
  /** data-testid, e.g. `ai-models-notice` / `ai-models-notice-chat`. */
  testid: string;
  notice: AiModelsNotice | null;
  className?: string;
}

/** Inline (non-toast) message: selection was reset or the refresh failed. */
export function ModelListNotice({
  testid,
  notice,
  className = 'mt-1 text-xs',
}: ModelListNoticeProps): React.ReactElement | null {
  if (!notice) return null;
  const isError = notice.kind === 'error';
  return (
    <p
      className={className}
      role={isError ? 'alert' : 'status'}
      style={{ color: isError ? 'var(--color-danger-fg)' : 'var(--color-warning-fg)' }}
      data-testid={testid}
    >
      {notice.text}
    </p>
  );
}
