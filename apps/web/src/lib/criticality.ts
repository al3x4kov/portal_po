import type { Criticality } from '@po/core';

/**
 * Russian display labels for the web UI (T4 / new_design: «все тексты UI на
 * русском», русские бейджи критичности в модалках и дереве). The English
 * labels in core (`CRITICALITY_LABEL`) stay untouched for the Excel export.
 */
export const CRITICALITY_LABEL: Record<Criticality, string> = {
  LOW: 'Низкая',
  MEDIUM: 'Средняя',
  HIGH: 'Высокая',
  CRITICAL: 'Критическая',
  BLOCKER: 'Блокер',
};

/** CSS custom property holding the dot color for each criticality level. */
export const CRITICALITY_COLOR_VAR: Record<Criticality, string> = {
  LOW: 'var(--crit-low)',
  MEDIUM: 'var(--crit-medium)',
  HIGH: 'var(--crit-high)',
  CRITICAL: 'var(--crit-critical)',
  BLOCKER: 'var(--crit-blocker)',
};
