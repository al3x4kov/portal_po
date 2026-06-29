import type { Criticality, Requirement } from '@po/core';
import { CRITICALITY_COLOR_VAR, CRITICALITY_LABEL } from '../lib/criticality';

export function CriticalityBadge({
  criticality,
}: {
  criticality: Criticality;
}): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold" data-testid="criticality-badge">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: CRITICALITY_COLOR_VAR[criticality] }}
        aria-hidden="true"
      />
      {CRITICALITY_LABEL[criticality]}
    </span>
  );
}

/** "Реализовано" (success) or "Q3 2026" (warning) per FR-6 conditional fields. */
export function ImplementationBadge({ req }: { req: Requirement }): React.ReactElement {
  if (req.implemented) {
    return (
      <span
        className="badge"
        style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)' }}
        data-testid="implementation-badge"
      >
        Реализовано
      </span>
    );
  }
  const label = `${req.targetQuarter ?? ''} ${req.targetYear ?? ''}`.trim() || 'Не реализовано';
  return (
    <span
      className="badge"
      style={{ background: 'var(--color-warning-bg)', color: 'var(--color-warning)' }}
      data-testid="implementation-badge"
    >
      {label}
    </span>
  );
}
