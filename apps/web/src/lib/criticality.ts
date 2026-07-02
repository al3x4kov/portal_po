import type { Criticality } from '@po/core';

// Display labels live in core (BE-3) so the UI and the Excel export share one
// source of truth; re-exported here for existing web imports.
export { CRITICALITY_LABEL } from '@po/core';

/** CSS custom property holding the dot color for each criticality level. */
export const CRITICALITY_COLOR_VAR: Record<Criticality, string> = {
  LOW: 'var(--crit-low)',
  MEDIUM: 'var(--crit-medium)',
  HIGH: 'var(--crit-high)',
  CRITICAL: 'var(--crit-critical)',
  BLOCKER: 'var(--crit-blocker)',
};
