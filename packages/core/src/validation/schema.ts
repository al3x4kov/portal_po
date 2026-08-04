import { z } from 'zod';
import {
  AI_ORIGINS,
  CRITICALITIES,
  LINK_TYPES,
  PRIORITY_COLORS,
  REQUIREMENT_TYPES,
  RICE_CONFIDENCE,
  RICE_EFFORT,
  RICE_IMPACT,
  RICE_REACH,
  SCENARIO_KEYWORDS,
  SOURCE_TYPES,
  TARGET_QUARTERS,
} from '../domain/types.js';
import { isValidIsoDate } from '../domain/dates.js';

export const infoItemSchema = z.object({
  type: z.string().min(1).max(50),
  value: z.string().min(1).max(100),
});
import { SLUG_RE } from '../domain/slug.js';

/** A RICE value constrained to one of the fixed PO scale steps. */
const riceValue = (scale: readonly number[]) =>
  z.number().refine((v) => scale.includes(v), {
    message: `must be one of ${scale.join(', ')}`,
  });

/** Structural schema for one source's RICE estimate (todo_19 §0.1). */
export const riceSchema = z.object({
  reach: riceValue(RICE_REACH),
  impact: riceValue(RICE_IMPACT),
  confidence: riceValue(RICE_CONFIDENCE),
  effort: riceValue(RICE_EFFORT),
});

/** ISO `yyyy-mm-dd` calendar date. */
export const isoDateSchema = z.string().refine(isValidIsoDate, 'must be an ISO date (yyyy-mm-dd)');

/** Structural schema for one requirement source (todo_19 §0.1). */
export const sourceEntrySchema = z.object({
  type: z.enum(SOURCE_TYPES),
  name: z.string().trim().min(1).max(100),
  priorityId: z.string().min(1),
  rice: riceSchema.optional(),
  targetQuarter: z.enum(TARGET_QUARTERS).optional(),
  targetYear: z.number().int().min(2020).max(2100).optional(),
  targetDate: isoDateSchema.optional(),
});

/** Structural schema for a project priority dictionary entry. */
export const sourcePrioritySchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(40),
  color: z.enum(PRIORITY_COLORS),
  order: z.number().int().min(0),
});

/** Structural schema for a project source dictionary entry. */
export const sourceRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  type: z.enum(SOURCE_TYPES),
  color: z.string().min(1).optional(),
});

/** Structural schema for the two per-project dictionaries. */
export const projectDictionariesSchema = z.object({
  priorities: z.array(sourcePrioritySchema).default([]),
  sources: z.array(sourceRefSchema).default([]),
});

/**
 * Return the first case-insensitive + trimmed duplicate name (normalized) in
 * `names`, or `undefined` when all names are unique. Single source of truth for
 * dictionary name-uniqueness (todo_19 §0.2), reused by the server services.
 */
export function findDuplicateName(names: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const raw of names) {
    const key = raw.trim().toLowerCase();
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return undefined;
}

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
  source: z.string().max(100).optional(),
  infoItems: z.array(infoItemSchema).optional(),
  sources: z.array(sourceEntrySchema).optional(),
  releaseDate: isoDateSchema.optional(),
  // task26 provenance: written by the server (AI import) / the review toggle.
  origin: z.enum(AI_ORIGINS).optional(),
  aiValidated: z.boolean().optional(),
});

export type RequirementInput = z.input<typeof requirementSchema>;
export type RequirementParsed = z.output<typeof requirementSchema>;

/** Format a ZodError into a single human-readable line. */
export function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}
