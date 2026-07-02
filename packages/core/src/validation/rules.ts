import type { Requirement } from '../domain/types.js';
import { ValidationError } from '../domain/errors.js';
import { formatZodError, requirementSchema } from './schema.js';
import { checkTargetRule } from './targetRule.js';

/**
 * Validate + normalize a requirement candidate.
 *
 * - Enforces structural schema (lengths 1..200 / <=5000, year 2020..2100, enums).
 * - When implemented === false: targetQuarter AND targetYear are required.
 * - When implemented === true: targetQuarter/targetYear are cleared (ignored).
 *
 * @throws {ValidationError} on any violation.
 */
export function validateRequirement(input: unknown): Requirement {
  const parsed = requirementSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(formatZodError(parsed.error));
  }

  const req = parsed.data;

  if (req.implemented) {
    // Implemented requirements never carry a target quarter/year — normalize
    // by clearing rather than rejecting.
    delete req.targetQuarter;
    delete req.targetYear;
  }

  // Shared implemented ⟺ target rule (BE-2). After the clearing above only the
  // not-implemented "missing-target" case can remain.
  const violation = checkTargetRule(req);
  if (violation?.kind === 'missing-target') {
    throw new ValidationError(
      `When implemented=false the following fields are required: ${violation.fields.join(', ')}`,
    );
  }

  return req;
}
