import type { Criticality } from '@po/core';

/** Display label for a criticality enum value (matches the mockups). */
export const CRITICALITY_LABEL: Record<Criticality, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

/** CSS custom property holding the dot color for each criticality level. */
export const CRITICALITY_COLOR_VAR: Record<Criticality, string> = {
  LOW: 'var(--crit-low)',
  MEDIUM: 'var(--crit-medium)',
  HIGH: 'var(--crit-high)',
  CRITICAL: 'var(--crit-critical)',
};
