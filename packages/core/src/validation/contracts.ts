import { z } from 'zod';
import { CRITICALITIES, LINK_TYPES, REQUIREMENT_TYPES, TARGET_QUARTERS } from '../domain/types.js';
import { infoItemSchema, isoDateSchema, sourceEntrySchema } from './schema.js';

/**
 * Canonical input contracts shared by the REST routes and the MCP tools
 * (ARCH-4). Both transports import these exact schema/field objects so the
 * accepted input can never drift between them: a single source of truth for
 * "what a client may send when creating/updating a requirement or a link".
 *
 * The shapes ({@link requirementCreateShape} etc.) are exported as raw
 * `z.ZodRawShape` because the MCP SDK registers tools with a raw shape, while
 * the object schemas ({@link requirementCreateSchema} etc.) are what the REST
 * routes and the OpenAPI generator consume. The object schemas are built from
 * the very same field validators, so they stay structurally identical by
 * construction (the individual field validators are shared by reference).
 */

/** Editable fields accepted when creating a requirement (type included). */
export const requirementCreateShape = {
  type: z.enum(REQUIREMENT_TYPES),
  name: z.string().trim().min(1).max(200),
  criticality: z.enum(CRITICALITIES),
  description: z.string().max(5000).optional(),
  implemented: z.boolean(),
  targetQuarter: z.enum(TARGET_QUARTERS).optional(),
  targetYear: z.number().int().min(2020).max(2100).optional(),
  source: z.string().max(100).optional(),
  infoItems: z.array(infoItemSchema).optional(),
  sources: z.array(sourceEntrySchema).optional(),
  releaseDate: isoDateSchema.optional(),
} as const;

/** Object schema for requirement creation (REST body + OpenAPI component). */
export const requirementCreateSchema = z.object(requirementCreateShape);

/**
 * Editable fields accepted when updating a requirement. `type` is immutable
 * (ADR-001) and therefore omitted; every other field reuses the exact same
 * validator instance as {@link requirementCreateShape}.
 */
export const requirementUpdateShape = {
  /**
   * task26: the human-review toggle of an AI-created requirement. Optional and
   * PRESERVING — an update that omits it keeps the stored value, so a client
   * that knows nothing about task26 can never silently re-raise the highlight.
   * `origin` is deliberately absent from both shapes: provenance is written by
   * the server only, and a client-sent `origin` is stripped (Zod strips unknown
   * keys) rather than honoured.
   */
  aiValidated: z.boolean().optional(),
  name: requirementCreateShape.name,
  criticality: requirementCreateShape.criticality,
  description: requirementCreateShape.description,
  implemented: requirementCreateShape.implemented,
  targetQuarter: requirementCreateShape.targetQuarter,
  targetYear: requirementCreateShape.targetYear,
  source: requirementCreateShape.source,
  infoItems: requirementCreateShape.infoItems,
  sources: requirementCreateShape.sources,
  releaseDate: requirementCreateShape.releaseDate,
} as const;

/** Object schema for requirement update (REST body + OpenAPI component). */
export const requirementUpdateSchema = z.object(requirementUpdateShape);

/** Editable fields accepted when creating/removing a link. */
export const linkInputShape = {
  sourceSlug: z.string().min(1),
  type: z.enum(LINK_TYPES),
  targetSlug: z.string().min(1),
} as const;

/** Object schema for link create/delete (REST body + OpenAPI component). */
export const linkInputSchema = z.object(linkInputShape);

/**
 * Body of «move a row in the tree»: replace the single CHILD_OF link.
 *
 * `parentSlug: null` lifts the requirement to the root of its type.
 * `expectedParentSlug` is the parent the client believed was current — the
 * server rejects the move when the file on disk says otherwise (someone else,
 * or an AI import, re-parented the requirement meanwhile) instead of silently
 * overwriting that change. Omitting it skips the check.
 */
export const moveRequirementShape = {
  parentSlug: z.string().min(1).nullable(),
  expectedParentSlug: z.string().min(1).nullable().optional(),
} as const;

/** Object schema for the move endpoint (REST body + OpenAPI component). */
export const moveRequirementSchema = z.object(moveRequirementShape);

export type RequirementCreateInput = z.infer<typeof requirementCreateSchema>;
export type RequirementUpdateInput = z.infer<typeof requirementUpdateSchema>;
export type LinkInputContract = z.infer<typeof linkInputSchema>;
export type MoveRequirementInput = z.infer<typeof moveRequirementSchema>;
