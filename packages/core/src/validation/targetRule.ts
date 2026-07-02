import type { TargetQuarter } from '../domain/types.js';

/** The subset of a requirement the implemented ⟺ target rule depends on. */
export interface TargetFields {
  implemented: boolean;
  targetQuarter?: TargetQuarter;
  targetYear?: number;
}

/** A violation of the implemented ⟺ target biconditional (§2.4). */
export type TargetRuleViolation =
  | { kind: 'unexpected-target' }
  | { kind: 'missing-target'; fields: ('targetQuarter' | 'targetYear')[] };

/**
 * Single source of truth for the implemented ⟺ target rule (BE-2):
 *
 * - implemented === true  ⇒ must NOT carry a targetQuarter/targetYear.
 * - implemented === false ⇒ must carry BOTH targetQuarter and targetYear.
 *
 * Returns the violation (so each caller can raise its own error type / message)
 * or `null` when the requirement is consistent.
 */
export function checkTargetRule(req: TargetFields): TargetRuleViolation | null {
  if (req.implemented) {
    if (req.targetQuarter !== undefined || req.targetYear !== undefined) {
      return { kind: 'unexpected-target' };
    }
    return null;
  }
  const fields: ('targetQuarter' | 'targetYear')[] = [];
  if (!req.targetQuarter) fields.push('targetQuarter');
  if (req.targetYear === undefined) fields.push('targetYear');
  return fields.length > 0 ? { kind: 'missing-target', fields } : null;
}
