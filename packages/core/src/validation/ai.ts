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

/*
 * ── todo_18 · per-model best-practice presets ──────────────────────────────
 * Each AI model has a best-practice set of request/response parameters (its
 * context window differs for input vs output). The presets ship as sensible
 * defaults keyed by the real model id and are editable in the AI settings UI:
 * the user stores only the OVERRIDES they change (defaults are NEVER
 * materialised on disk). The effective preset for a call is
 * {@link resolveModelPreset}: generic fallback ← default-by-id ← user override.
 */

/** How to treat a model's chain-of-thought «reasoning»: keep it or strip `<think>…</think>`. */
export const AI_MODEL_REASONING_MODES = ['none', 'strip'] as const;
export type AiModelReasoning = (typeof AI_MODEL_REASONING_MODES)[number];

/**
 * A full per-model preset. `temperature` (0..2), `maxOutputTokens` (≥1),
 * `chunkChars` (≥1000, input-side chunking for the import pipeline),
 * `reasoning` (`none` keeps the answer verbatim — Coder-Next compatibility;
 * `strip` removes `<think>…</think>` wrappers of thinking models), optional
 * `topP` (0..1, nucleus sampling — passed only when set).
 */
export const aiModelPresetSchema = z.object({
  temperature: z.number().min(0).max(2),
  maxOutputTokens: z.number().int().min(1),
  chunkChars: z.number().int().min(1000),
  reasoning: z.enum(AI_MODEL_REASONING_MODES),
  topP: z.number().min(0).max(1).optional(),
});
export type AiModelPreset = z.infer<typeof aiModelPresetSchema>;

/**
 * A partial preset: exactly the fields a user overrides for one model. Empty
 * `{}` means «use the defaults» (reset). This is the on-disk / API shape — full
 * defaults are never stored, only these overrides.
 */
export const aiModelPresetOverrideSchema = aiModelPresetSchema.partial();
export type AiModelPresetOverride = z.infer<typeof aiModelPresetOverrideSchema>;

/** Key of the generic fallback preset inside {@link AI_MODEL_PRESET_DEFAULTS}. */
export const AI_MODEL_PRESET_GENERIC_KEY = '__default__';

/**
 * Best-practice defaults per real model id (todo_18). Values follow each
 * model's published guidance (context window differs for send vs receive).
 * The generic {@link AI_MODEL_PRESET_GENERIC_KEY} fallback covers any model
 * without a dedicated entry.
 */
export const AI_MODEL_PRESET_DEFAULTS: Record<string, AiModelPreset> = {
  'Qwen/Qwen3-Coder-Next': {
    temperature: 0.2,
    maxOutputTokens: 4000,
    chunkChars: 12_000,
    reasoning: 'none',
  },
  'Qwen/Qwen3.5-397B-A17B': {
    temperature: 0.2,
    maxOutputTokens: 8000,
    chunkChars: 24_000,
    reasoning: 'strip',
  },
  'Qwen/Qwen3.6-27B': {
    temperature: 0.2,
    maxOutputTokens: 6000,
    chunkChars: 16_000,
    reasoning: 'strip',
  },
  [AI_MODEL_PRESET_GENERIC_KEY]: {
    temperature: 0.2,
    maxOutputTokens: 4000,
    chunkChars: 12_000,
    reasoning: 'strip',
  },
};

/** Drop `undefined`-valued keys so a partial override never blanks a resolved field. */
function definedOnly(override: AiModelPresetOverride | undefined): AiModelPresetOverride {
  if (!override) return {};
  const out: AiModelPresetOverride = {};
  for (const [k, v] of Object.entries(override)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Effective preset for a model: generic fallback ← default-by-id ← user
 * override (each layer overrides only the fields it defines). A model without a
 * dedicated default still gets a complete preset from the generic fallback.
 */
export function resolveModelPreset(
  modelId: string,
  overrides?: AiModelPresetOverride,
): AiModelPreset {
  const generic = AI_MODEL_PRESET_DEFAULTS[AI_MODEL_PRESET_GENERIC_KEY]!;
  const byId = AI_MODEL_PRESET_DEFAULTS[modelId];
  return { ...generic, ...(byId ?? {}), ...definedOnly(overrides) };
}

/**
 * Response of `GET /api/ai/config`. Deliberately omits `apiKey`; the presence of
 * a stored key is signalled by `hasApiKey`, `model` is the per-project model,
 * and `modelPresets` carries the stored per-model OVERRIDES (defaults are not
 * echoed — the client merges them via {@link resolveModelPreset}). The field is
 * present only when at least one override is stored.
 */
export const aiConfigViewSchema = z.object({
  baseURL: z.string(),
  hasApiKey: z.boolean(),
  model: z.string().optional(),
  modelPresets: z.record(z.string(), aiModelPresetOverrideSchema).optional(),
});
export type AiConfigView = z.infer<typeof aiConfigViewSchema>;

/**
 * Body of `PUT /api/ai/config`. Every field is optional (partial update). The
 * key is only persisted when passed non-empty; `''`/omitted keep the existing
 * key, while an explicit `null` deletes the stored key (Task 10). The model is
 * stored under `modelByProject[projectId]`, so `projectId` is required to set
 * a model. `modelPresets` merges per model id: a non-empty override object is
 * stored, an empty `{}` resets that model to its defaults (removes the override).
 */
export const aiConfigUpdateSchema = z.object({
  baseURL: z.string().url().optional(),
  apiKey: z.string().nullable().optional(),
  projectId: z.string().min(1).optional(),
  model: z.string().optional(),
  modelPresets: z.record(z.string(), aiModelPresetOverrideSchema).optional(),
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
/**
 * Token budget for one structure (tree-building) call — Task 14 B1. One answer
 * node `{"type":"FUNCTION","name":"…","parentName":"…"}` with Cyrillic names is
 * ~40–70 tokens, so a batch of {@link AI_IMPORT_STRUCTURE_BATCH} = 50 nodes
 * needs ~2000–3500 tokens; 4000 leaves head-room. The previous shared budget of
 * {@link AI_IMPORT_MAX_TOKENS} = 2000 truncated every large-batch answer, so
 * the tree silently degraded to a flat list on big projects.
 */
export const AI_IMPORT_STRUCTURE_MAX_TOKENS = 4000;
/**
 * Extracted records per structure-stage batch (Task 13 B2, Task 14 B1:
 * 100 → 50 so the JSON answer reliably fits the structure token budget).
 */
export const AI_IMPORT_STRUCTURE_BATCH = 50;
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
  /** CHILD_OF links created (hierarchy). Task 15: NOT renamed — see relatesLinks. */
  links: z.number().int().min(0),
  /** RELATES_TO links created from an NFR to the functions it constrains (Task 15). */
  relatesLinks: z.number().int().min(0),
});
export type AiImportResult = z.infer<typeof aiImportResultSchema>;

/*
 * ── todo_16 B2: optional «Проставление связей ФТ↔НФТ» (relate) step ────────
 * Opt-in via the `inferLinks` multipart field of the start request. The step
 * runs between `populate` and the final `done` transition, asks the hub for
 * meaningful NFR↔FUNCTION pairs over the ALREADY-created requirements and
 * creates RELATES_TO links only. It never creates or edits requirements, and
 * its failure never fails the import — the outcome is reported in the job
 * view under `relate` (this is the step's visibility contract; the stage
 * enum above is deliberately NOT extended).
 */

/**
 * Multipart text field `inferLinks` of `POST /api/projects/:id/ai-import`
 * (same style as the existing `model` text field). Default: absent = false.
 */
export const aiImportInferLinksFieldSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

/** Token budget for one relate call (pairs are short; mirrors the structure budget). */
export const AI_IMPORT_RELATE_MAX_TOKENS = 4000;

/**
 * Statuses of the relate step shown by the frontend: `running` while the step
 * executes, `done` when every accepted pair was created, `partial` when some
 * link creations failed, `skipped` when the AI call failed/was unparsable (the
 * import itself still succeeds).
 */
export const AI_IMPORT_RELATE_STATUSES = ['running', 'done', 'partial', 'skipped'] as const;
export type AiImportRelateStatus = (typeof AI_IMPORT_RELATE_STATUSES)[number];

/** Outcome of the optional relate step (present in the view only when requested). */
export const aiImportRelateViewSchema = z.object({
  status: z.enum(AI_IMPORT_RELATE_STATUSES),
  /** RELATES_TO links created by THIS step (not counted in `result.relatesLinks`). */
  created: z.number().int().min(0),
});
export type AiImportRelateView = z.infer<typeof aiImportRelateViewSchema>;

/**
 * One pair of the relate answer. Both ids are requirement slugs of the
 * project; fabricated ids, self-links and duplicates are dropped server-side.
 */
export const aiRelatePairSchema = z.object({
  nfr: z.string().min(1).max(300),
  function: z.string().min(1).max(300),
});
export type AiRelatePair = z.infer<typeof aiRelatePairSchema>;

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
  /** Outcome of the optional relate step (todo_16 B2); absent when not requested. */
  relate: aiImportRelateViewSchema.optional(),
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
  /**
   * Task 15: names of the FUNCTION requirements this NFR explicitly constrains
   * (extraction-stage evidence only — the model sees the chunk text). Meaningful
   * for `type='NFR'` only; the server ignores it on FUNCTION records with a warn
   * instead of failing validation. Resolved case-insensitively into RELATES_TO
   * links at populate time.
   */
  relatedFunctions: z.array(z.string().min(1).max(200)).max(20).optional(),
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
