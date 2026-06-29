import { z } from 'zod';
import { CRITICALITIES, LINK_TYPES, REQUIREMENT_TYPES, TARGET_QUARTERS } from '../domain/types.js';

export const linkSchema = z.object({
  type: z.enum(LINK_TYPES),
  targetId: z.string().min(1),
});

/**
 * Structural schema for a Requirement (field types, lengths, ranges).
 * Conditional rules (targetQuarter/Year vs implemented) live in validation/rules.ts.
 */
export const requirementSchema = z.object({
  id: z.string().min(1),
  type: z.enum(REQUIREMENT_TYPES),
  name: z.string().trim().min(1).max(200),
  criticality: z.enum(CRITICALITIES),
  description: z.string().max(5000).optional(),
  implemented: z.boolean(),
  targetQuarter: z.enum(TARGET_QUARTERS).optional(),
  targetYear: z.number().int().min(2020).max(2100).optional(),
  links: z.array(linkSchema).default([]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type RequirementInput = z.input<typeof requirementSchema>;
export type RequirementParsed = z.output<typeof requirementSchema>;

/** Format a ZodError into a single human-readable line. */
export function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}
