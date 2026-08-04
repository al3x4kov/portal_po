import type { Requirement } from './types.js';

/**
 * task26 — «создано ИИ, не проверено».
 *
 * THE single source of the highlight rule: a requirement is pending review iff
 * an AI import created it (`origin` is set) and a human has not yet confirmed
 * it (`aiValidated !== true`). Every consumer — server, REST/MCP adapters and
 * the web tree/filter/counter — must call this helper instead of re-deriving
 * the condition, so the rule can never drift between layers.
 *
 * Accepts any object carrying the two provenance fields (a full
 * {@link Requirement}, a row view-model, or a bare `{ origin, aiValidated }`).
 */
export function isAiPendingReview(
  req: Pick<Requirement, 'origin' | 'aiValidated'> | undefined | null,
): boolean {
  if (!req) return false;
  return req.origin !== undefined && req.aiValidated !== true;
}

/** Count of requirements awaiting review (tree counter «Не проверено: N»). */
export function countAiPendingReview(
  reqs: readonly Pick<Requirement, 'origin' | 'aiValidated'>[],
): number {
  return reqs.reduce((n, r) => (isAiPendingReview(r) ? n + 1 : n), 0);
}
