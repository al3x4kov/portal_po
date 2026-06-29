import { z } from 'zod';
import { formatZodError, ValidationError } from '@po/core';

/**
 * Validate untrusted request data against a Zod schema, converting any failure
 * into a domain {@link ValidationError} (mapped to HTTP 422 by the error handler).
 */
export function parseInput<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(formatZodError(result.error));
  }
  return result.data;
}
