import type { AiImportJobError } from '@po/core';

/**
 * todo_22 (T-305): the todo_20 taxonomy-error blocks, extracted VERBATIM from
 * AiImportModal so the backlog modal reuses them instead of copy-pasting.
 * Markup, styles and the `data-testid` contract of the docs modal are kept
 * byte-identical (`ai-import-error`, `ai-import-error-code`,
 * `ai-import-error-details`); the backlog modal passes its own prefix.
 */

interface TaxonomyErrorCardProps {
  /** Base testid of the card; the code badge gets `${testid}-code`. */
  testid: string;
  error: AiImportJobError;
}

/** todo_20 П6 (mockup 04): message first, then the concrete action. */
export function TaxonomyErrorCard({ testid, error }: TaxonomyErrorCardProps): React.ReactElement {
  return (
    <div
      className="rounded-lg p-4"
      style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' }}
      role="alert"
      data-testid={testid}
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <h4 className="text-sm font-bold">{error.message}</h4>
        <span
          className="badge shrink-0"
          style={{
            background: 'var(--color-danger)',
            color: '#fff',
          }}
          data-testid={`${testid}-code`}
        >
          Ошибка · {error.code}
        </span>
      </div>
      <p className="text-sm font-semibold">Что сделать: {error.action ?? error.hint}</p>
    </div>
  );
}

interface TaxonomyErrorDetailsProps {
  testid: string;
  error: AiImportJobError;
  /** Second technical line (stage / fragment / batch context of the caller). */
  contextLine: string;
}

/** Collapsible raw technical detail (never in the first line). */
export function TaxonomyErrorDetails({
  testid,
  error,
  contextLine,
}: TaxonomyErrorDetailsProps): React.ReactElement {
  return (
    <details
      className="rounded-lg border"
      style={{ borderColor: 'var(--color-border)' }}
      data-testid={testid}
    >
      <summary
        className="cursor-pointer select-none px-4 py-2.5 text-sm"
        style={{ color: 'var(--color-text-2)' }}
      >
        Технические детали
      </summary>
      <div
        className="space-y-1 px-4 pb-3 font-mono text-xs"
        style={{ color: 'var(--color-text-3)' }}
      >
        <div>
          code: {error.code} · category: {error.category ?? '—'} · resumable:{' '}
          {error.resumable ? 'true' : 'false'}
        </div>
        <div>{contextLine}</div>
        {error.hint && error.hint !== error.action ? <div>hint: {error.hint}</div> : null}
      </div>
    </details>
  );
}
