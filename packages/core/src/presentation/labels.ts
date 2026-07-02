import type { Criticality, LinkType } from '../domain/types.js';

/**
 * Single source of truth for presentation labels shared across the web UI and
 * the Excel export (BE-3). Keeping them in core prevents the "mirror" copies
 * from drifting apart.
 */

/** Display label for a criticality enum value (matches the mockups). */
export const CRITICALITY_LABEL: Record<Criticality, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
  BLOCKER: 'Blocker',
};

/** Short readable label for a link type (select options, table cells, export). */
export const LINK_TYPE_LABEL: Record<LinkType, string> = {
  CHILD_OF: 'является дочерней',
  PARENT_OF: 'является родителем',
  RELATES_TO: 'связана с',
  DEPENDS_ON: 'зависит от',
  BLOCKED_BY: 'блокируется',
};
