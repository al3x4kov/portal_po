import type { Requirement } from '../domain/types.js';
import { ValidationError } from '../domain/errors.js';
import { formatZodError, requirementSchema } from './schema.js';

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
    // Implemented requirements never carry a target quarter/year.
    delete req.targetQuarter;
    delete req.targetYear;
  } else {
    const missing: string[] = [];
    if (!req.targetQuarter) missing.push('targetQuarter');
    if (req.targetYear === undefined) missing.push('targetYear');
    if (missing.length > 0) {
      throw new ValidationError(
        `When implemented=false the following fields are required: ${missing.join(', ')}`,
      );
    }
  }

  return req;
}
