import { z } from 'zod';
import { formatZodError, ValidationError } from '@po/core';

/**
 * Validate untrusted request input (body / query / params) against a Zod schema.
 *
 * This is the SINGLE, canonical input-validation helper for every route family
 * (projects / requirements / links / archive / ai / ai-import). On failure it
 * throws a domain {@link ValidationError}, which the error handler maps to the
 * one agreed status for invalid input — **HTTP 422 Unprocessable Entity** (BE-4).
 *
 * Note: a structurally malformed request that never reaches schema validation
 * (e.g. an unparseable multipart upload, a missing file part) is a different
 * failure and is still reported as `BadRequestError` → 400.
 */
export function parseInput<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(formatZodError(result.error));
  }
  return result.data;
}
