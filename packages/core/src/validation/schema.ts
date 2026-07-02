import { z } from 'zod';
import {
  CRITICALITIES,
  LINK_TYPES,
  REQUIREMENT_TYPES,
  SCENARIO_KEYWORDS,
  TARGET_QUARTERS,
} from '../domain/types.js';
import { SLUG_RE } from '../domain/slug.js';

export const linkSchema = z.object({
  type: z.enum(LINK_TYPES),
  targetSlug: z.string().regex(SLUG_RE, 'targetSlug must be a valid slug'),
});

export const scenarioStepSchema = z.object({
  keyword: z.enum(SCENARIO_KEYWORDS),
  text: z.string().min(1),
});

export const scenarioSchema = z.object({
  name: z.string().min(1),
  steps: z.array(scenarioStepSchema).default([]),
});

/**
 * Structural schema for a Requirement (field types, lengths, ranges).
 * Conditional rules (targetQuarter/Year vs implemented) live in validation/rules.ts.
 */
export const requirementSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'slug must be a valid slug'),
  type: z.enum(REQUIREMENT_TYPES),
  name: z.string().trim().min(1).max(200),
  criticality: z.enum(CRITICALITIES),
  description: z.string().max(5000).optional(),
  implemented: z.boolean(),
  targetQuarter: z.enum(TARGET_QUARTERS).optional(),
  targetYear: z.number().int().min(2020).max(2100).optional(),
  scenarios: z.array(scenarioSchema).optional(),
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
