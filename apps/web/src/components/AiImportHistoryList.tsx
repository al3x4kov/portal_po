import type { AiImportJobSummary, AiImportStatus } from '@po/core';
import { aiImportApi } from '../api/endpoints';

/**
 * todo_20 PO №4 → todo_22 (T-306): the shared run-history list of a project.
 * Extracted from AiImportModal so the backlog modal shows the same history;
 * todo_22 adds the job-kind badge («Документация» / «Бэклог») — both docs and
 * backlog runs live in ONE history. The docs `data-testid` contract is kept
 * (`ai-import-history*`); the backlog modal passes its own prefix.
 */

/** todo_20 PO №4 (+ todo_22 «awaiting-review»): Russian status labels. */
export const AI_IMPORT_STATUS_LABELS: Record<AiImportStatus, string> = {
  running: 'Выполняется',
  succeeded: 'Завершён',
  failed: 'Ошибка',
  cancelled: 'Остановлен',
  'awaiting-confirmation': 'Ждёт подтверждения',
  interrupted: 'Прерван рестартом',
  'awaiting-review': 'Ждёт выверки',
};

/** todo_22: human label of the job kind (absent in old summaries ⇒ docs). */
export function jobKindLabel(kind: AiImportJobSummary['kind']): string {
  return kind === 'backlog' ? 'Бэклог' : 'Документация';
}

/** ISO → «12.05.2026, 18:42» for history rows. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface AiImportHistoryListProps {
  /** Testid prefix: `ai-import` (docs modal) or `ai-backlog` (backlog modal). */
  testidPrefix: string;
  jobs: AiImportJobSummary[];
  resumePending: boolean;
  onResume: (jobId: string) => void;
  onOpen: (jobId: string) => void;
}

export function AiImportHistoryList({
  testidPrefix,
  jobs,
  resumePending,
  onResume,
  onOpen,
}: AiImportHistoryListProps): React.ReactElement | null {
  if (jobs.length === 0) return null;
  return (
    <details data-testid={`${testidPrefix}-history`}>
      <summary
        className="cursor-pointer select-none text-sm font-semibold"
        style={{ color: 'var(--color-text-2)' }}
      >
        Прошлые прогоны — {jobs.length}
      </summary>
      <ul
        className="mt-2 divide-y overflow-hidden rounded-lg border"
        style={{ borderColor: 'var(--color-border)' }}
      >
        {jobs.map((h) => (
          <li
            key={h.jobId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
            style={{ borderColor: 'var(--color-border)' }}
            data-testid={`${testidPrefix}-history-row`}
            data-status={h.status}
            data-kind={h.kind ?? 'docs'}
          >
            <span
              className="badge"
              style={
                h.status === 'succeeded'
                  ? {
                      background: 'var(--color-success-bg)',
                      color: 'var(--color-success-fg)',
                    }
                  : h.status === 'failed'
                    ? {
                        background: 'var(--color-danger-bg)',
                        color: 'var(--color-danger-fg)',
                      }
                    : {
                        background: 'var(--color-warning-bg)',
                        color: 'var(--color-warning-fg)',
                      }
              }
            >
              {AI_IMPORT_STATUS_LABELS[h.status]}
            </span>
            {/* todo_22 T-306: one history, two kinds — the badge tells them apart. */}
            <span
              className="badge"
              style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
              data-testid={`${testidPrefix}-history-kind`}
            >
              {jobKindLabel(h.kind)}
            </span>
            <span style={{ color: 'var(--color-text-3)' }}>{formatDateTime(h.startedAt)}</span>
            {h.result ? (
              <span style={{ color: 'var(--color-text-2)' }}>
                {h.result.createdFunctions} ФТ · {h.result.createdNfrs} НФТ
              </span>
            ) : null}
            <span className="ml-auto flex items-center gap-2">
              {h.resumable ? (
                <button
                  type="button"
                  className="font-semibold"
                  style={{ color: 'var(--color-primary)' }}
                  data-testid={`${testidPrefix}-history-resume`}
                  disabled={resumePending}
                  onClick={() => onResume(h.jobId)}
                >
                  Продолжить
                </button>
              ) : null}
              <button
                type="button"
                className="font-semibold"
                style={{ color: 'var(--color-primary)' }}
                data-testid={`${testidPrefix}-history-open`}
                onClick={() => onOpen(h.jobId)}
              >
                Открыть
              </button>
              <a
                href={aiImportApi.logUrl(h.jobId)}
                download
                className="underline"
                style={{ color: 'var(--color-text-3)' }}
                data-testid={`${testidPrefix}-history-log`}
              >
                Лог
              </a>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
