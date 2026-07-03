import { z } from 'zod';
import { CRITICALITIES, REQUIREMENT_TYPES } from '../domain/types.js';

/**
 * Shared AI Hub contract (Task 8). These Zod schemas + types are the single
 * source of truth for the REST endpoints (`/api/ai/*`) and are consumed by the
 * web forms so the shape can never drift between server and client.
 *
 * SECURITY: the API key is NEVER part of an outbound view — {@link AiConfigView}
 * only exposes `hasApiKey`. The key lives plaintext in a gitignored on-disk
 * config and must never be logged or returned.
 */

/** Default OpenAI-compatible AI Hub endpoint (PO decision §7). */
export const AI_DEFAULT_BASE_URL = 'https://api.ai.sbt/openai/v1';
/** Sampling temperature for description generation (PO decision §7). */
export const AI_GEN_TEMPERATURE = 0.4;
/** Token budget for description generation (PO decision §7). */
export const AI_GEN_MAX_TOKENS = 700;

/**
 * Response of `GET /api/ai/config`. Deliberately omits `apiKey`; the presence of
 * a stored key is signalled by `hasApiKey`, and `model` is the per-project model.
 */
export const aiConfigViewSchema = z.object({
  baseURL: z.string(),
  hasApiKey: z.boolean(),
  model: z.string().optional(),
});
export type AiConfigView = z.infer<typeof aiConfigViewSchema>;

/**
 * Body of `PUT /api/ai/config`. Every field is optional (partial update). The
 * key is only persisted when passed non-empty; the model is stored under
 * `modelByProject[projectId]`, so `projectId` is required to set a model.
 */
export const aiConfigUpdateSchema = z.object({
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
  projectId: z.string().min(1).optional(),
  model: z.string().optional(),
});
export type AiConfigUpdate = z.infer<typeof aiConfigUpdateSchema>;

/** Response of `GET /api/ai/models`. */
export const aiModelsViewSchema = z.object({
  models: z.array(z.string()),
});
export type AiModelsView = z.infer<typeof aiModelsViewSchema>;

/** Requirement context used to build the generation prompt. */
export const generateDescriptionRequirementSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(REQUIREMENT_TYPES),
  criticality: z.enum(CRITICALITIES),
  description: z.string().max(5000).optional(),
});

/** Body of `POST /api/ai/generate-description`. */
export const generateDescriptionRequestSchema = z.object({
  projectId: z.string().min(1),
  requirement: generateDescriptionRequirementSchema,
  projectName: z.string().optional(),
  projectDescription: z.string().optional(),
  userHint: z.string().optional(),
});
export type GenerateDescriptionRequest = z.infer<typeof generateDescriptionRequestSchema>;

/** Response of `POST /api/ai/generate-description`. */
export const generateDescriptionResponseSchema = z.object({
  description: z.string(),
});
export type GenerateDescriptionResponse = z.infer<typeof generateDescriptionResponseSchema>;
