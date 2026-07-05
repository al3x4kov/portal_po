import { z } from 'zod';
import { CRITICALITIES, REQUIREMENT_TYPES, TARGET_QUARTERS } from '../domain/types.js';
import { requirementCreateShape } from './contracts.js';

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
 * key is only persisted when passed non-empty; `''`/omitted keep the existing
 * key, while an explicit `null` deletes the stored key (Task 10). The model is
 * stored under `modelByProject[projectId]`, so `projectId` is required to set
 * a model.
 */
export const aiConfigUpdateSchema = z.object({
  baseURL: z.string().url().optional(),
  apiKey: z.string().nullable().optional(),
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

/** Sampling temperature for the chat widget (PO decision, Task 9 §6.5). */
export const AI_CHAT_TEMPERATURE = 0.7;
/** Token budget for one chat reply (PO decision, Task 9 §6.5). */
export const AI_CHAT_MAX_TOKENS = 1000;
/** How many trailing messages of the conversation go into one request (§6.4). */
export const AI_CHAT_HISTORY_LIMIT = 20;

/**
 * One visible chat turn. The `system` role is deliberately NOT accepted from
 * clients — the server prepends its own system prompt.
 */
export const aiChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});
export type AiChatMessage = z.infer<typeof aiChatMessageSchema>;

/**
 * Body of `POST /api/ai/chat`. `model` is the widget override and wins over the
 * per-project model resolved via optional `projectId`; without either the
 * server answers 400.
 */
export const aiChatRequestSchema = z.object({
  projectId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  messages: z.array(aiChatMessageSchema).min(1).max(AI_CHAT_HISTORY_LIMIT),
});
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;

/** Response of `POST /api/ai/chat` — always a single assistant message. */
export const aiChatResponseSchema = z.object({
  message: aiChatMessageSchema,
});
export type AiChatResponse = z.infer<typeof aiChatResponseSchema>;

/*
 * ── Task 11: AI-import of ФТ/НФТ from a documentation archive ──────────────
 * Shared contract between `POST /api/projects/:id/ai-import`,
 * `GET /api/ai-import/:jobId`, `POST /api/ai-import/:jobId/cancel` and the
 * web modal. Constants are PO decisions (spec §3), schemas validate both the
 * job view sent to the client and each record extracted by the model.
 */

/** Sampling temperature for extraction (not generation) — PO decision §3.5. */
export const AI_IMPORT_TEMPERATURE = 0.2;
/** Token budget for one extraction call — PO decision §3.5. */
export const AI_IMPORT_MAX_TOKENS = 2000;
/** Chunk size in characters — fits a small context window (Qwen-Coder-Next). */
export const AI_IMPORT_CHUNK_CHARS = 12_000;
/** Upload limit for the documentation archive — PO decision §3.4. */
export const AI_IMPORT_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
/** Max number of documentation files inside one archive — PO decision §3.4. */
export const AI_IMPORT_MAX_DOC_FILES = 500;

/**
 * Job stages in execution order. Progress ranges (Task 13): unpack 0–5,
 * analyze 5–65, structure 65–80, aggregate 80–85, populate 85–100.
 */
export const AI_IMPORT_STAGES = [
  'unpack',
  'analyze',
  'structure',
  'aggregate',
  'populate',
  'done',
] as const;
export type AiImportStage = (typeof AI_IMPORT_STAGES)[number];

/** Job lifecycle statuses. */
export const AI_IMPORT_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const;
export type AiImportStatus = (typeof AI_IMPORT_STATUSES)[number];

/** One line of the automation log shown in the modal. */
export const aiImportLogEntrySchema = z.object({
  /** ISO timestamp. */
  ts: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
});
export type AiImportLogEntry = z.infer<typeof aiImportLogEntrySchema>;

/** Final counters of a finished (or cancelled — partial) job. */
export const aiImportResultSchema = z.object({
  createdFunctions: z.number().int().min(0),
  createdNfrs: z.number().int().min(0),
  skippedExisting: z.number().int().min(0),
  links: z.number().int().min(0),
});
export type AiImportResult = z.infer<typeof aiImportResultSchema>;

/** Response of `GET /api/ai-import/:jobId` (polled by the modal). */
export const aiImportJobViewSchema = z.object({
  jobId: z.string(),
  projectId: z.string(),
  status: z.enum(AI_IMPORT_STATUSES),
  stage: z.enum(AI_IMPORT_STAGES),
  progress: z.number().min(0).max(100),
  log: z.array(aiImportLogEntrySchema),
  /** Present when succeeded (and on cancelled — what managed to complete). */
  result: aiImportResultSchema.optional(),
  /** Present when failed: readable message + "what to do next" (spec §4). */
  error: z.object({ message: z.string(), hint: z.string() }).optional(),
});
export type AiImportJobView = z.infer<typeof aiImportJobViewSchema>;

/** Response of `POST /api/projects/:id/ai-import` (202). */
export const aiImportStartResponseSchema = z.object({ jobId: z.string() });
export type AiImportStartResponse = z.infer<typeof aiImportStartResponseSchema>;

/**
 * One requirement extracted by the model from a documentation chunk. `source`
 * (file + section provenance) is MANDATORY — a record without it is dropped
 * (golden rule of the extraction skill: no provenance → no requirement).
 * `targetYear` reuses the EXACT validator of the creation contract
 * ({@link requirementCreateShape}), so a record the contract would reject
 * (e.g. year 2019) is dropped at parsing time and never reaches populate.
 */
export const aiExtractedRequirementSchema = z.object({
  type: z.enum(REQUIREMENT_TYPES),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  source: z.string().min(1).max(300),
  criticality: z.enum(CRITICALITIES).optional(),
  implemented: z.boolean().optional(),
  targetQuarter: z.enum(TARGET_QUARTERS).optional(),
  targetYear: requirementCreateShape.targetYear,
  parentName: z.string().optional(),
});
export type AiExtractedRequirement = z.infer<typeof aiExtractedRequirementSchema>;

/**
 * One node of the structure-stage answer (Task 13 B2): the model receives the
 * FULL list of extracted requirements (type + name) plus the archive map and
 * returns exactly one node per requirement, assembling a tree that mirrors the
 * documentation structure. `parentName` is REQUIRED and must be an explicit
 * `null` for roots; hierarchy is only valid within one type (CHILD_OF rule).
 * Unknown keys are stripped, an invalid node invalidates the whole answer
 * (the caller retries the batch).
 */
export const aiStructureNodeSchema = z.object({
  type: z.enum(REQUIREMENT_TYPES),
  name: z.string().min(1).max(200),
  parentName: z.string().nullable(),
});
export type AiStructureNode = z.infer<typeof aiStructureNodeSchema>;
