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

/*
 * ── todo_20 · run-control preset fields (T-201) ────────────────────────────
 * Four new per-model knobs drive the IMPORT pipeline: parallel call pool,
 * per-call timeout, run token budget and the estimate confirmation threshold.
 * They resolve through {@link resolveModelPreset} like every other field, so
 * OLD stored overrides (without them) stay valid and simply inherit defaults.
 */

/** Default pool of simultaneous AI calls for independent chunks (C2). */
export const AI_MODEL_PARALLELISM_DEFAULT = 2;
/** Default per-call timeout, seconds — with head-room for thinking models (C3). */
export const AI_MODEL_PER_CALL_TIMEOUT_SEC_DEFAULT = 120;
/** Default run token budget: `null` = no limit (B6). */
export const AI_MODEL_RUN_BUDGET_TOKENS_DEFAULT = null;
/**
 * Default estimate confirmation threshold, tokens (PO decision №2):
 * over it the job waits for explicit confirmation; `0` = always confirm,
 * `null` = never ask.
 */
export const AI_MODEL_ESTIMATE_THRESHOLD_TOKENS_DEFAULT = 2_000_000;

/** Shared run-control defaults merged into every preset entry below. */
const AI_MODEL_PRESET_RUN_DEFAULTS = {
  parallelism: AI_MODEL_PARALLELISM_DEFAULT,
  perCallTimeoutSec: AI_MODEL_PER_CALL_TIMEOUT_SEC_DEFAULT,
  runBudgetTokens: AI_MODEL_RUN_BUDGET_TOKENS_DEFAULT,
  estimateThresholdTokens: AI_MODEL_ESTIMATE_THRESHOLD_TOKENS_DEFAULT,
} as const;

/**
 * A full per-model preset. `temperature` (0..2), `maxOutputTokens` (≥1),
 * `chunkChars` (≥1000, input-side chunking for the import pipeline),
 * `reasoning` (`none` keeps the answer verbatim — Coder-Next compatibility;
 * `strip` removes `<think>…</think>` wrappers of thinking models), optional
 * `topP` (0..1, nucleus sampling — passed only when set).
 *
 * todo_18: `maxOutputTokens` is the FULL generation budget of one IMPORT call
 * (`max_tokens` sent as-is), i.e. it must cover the JSON answer AND, for
 * thinking models, the `<think>…</think>` reasoning that precedes it — set it
 * too low and the reply is truncated («ответ обрезан по лимиту токенов»). For
 * the chat widget and description generation it is only an UPPER bound (those
 * calls clamp their own small budget against it).
 */
export const aiModelPresetSchema = z.object({
  temperature: z.number().min(0).max(2),
  maxOutputTokens: z.number().int().min(1),
  chunkChars: z.number().int().min(1000),
  reasoning: z.enum(AI_MODEL_REASONING_MODES),
  topP: z.number().min(0).max(1).optional(),
  /** todo_20: pool of simultaneous AI calls (1..8). */
  parallelism: z.number().int().min(1).max(8),
  /** todo_20: per-call timeout, seconds (≥10). */
  perCallTimeoutSec: z.number().int().min(10),
  /** todo_20: run token budget; `null` = no limit. */
  runBudgetTokens: z.number().int().min(0).nullable(),
  /** todo_20: estimate threshold; `0` = always confirm, `null` = never ask. */
  estimateThresholdTokens: z.number().int().min(0).nullable(),
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
    ...AI_MODEL_PRESET_RUN_DEFAULTS,
  },
  'Qwen/Qwen3.5-397B-A17B': {
    temperature: 0.2,
    // todo_18: full IMPORT generation budget — a thinking model spends part of
    // it on `<think>…</think>` reasoning before the JSON answer, so it must be
    // large enough for reasoning + answer or the reply is truncated.
    maxOutputTokens: 16_000,
    chunkChars: 24_000,
    reasoning: 'strip',
    ...AI_MODEL_PRESET_RUN_DEFAULTS,
  },
  'Qwen/Qwen3.6-27B': {
    temperature: 0.2,
    // todo_18: full IMPORT generation budget — see Qwen3.5 note above.
    maxOutputTokens: 12_000,
    chunkChars: 16_000,
    reasoning: 'strip',
    ...AI_MODEL_PRESET_RUN_DEFAULTS,
  },
  [AI_MODEL_PRESET_GENERIC_KEY]: {
    temperature: 0.2,
    maxOutputTokens: 4000,
    chunkChars: 12_000,
    reasoning: 'strip',
    ...AI_MODEL_PRESET_RUN_DEFAULTS,
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
/** Upload limit for the documentation archive — 200 МБ (todo_20, PO decision №1). */
export const AI_IMPORT_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
/** Max number of text (documentation) files inside one archive — todo_20 Н1. */
export const AI_IMPORT_MAX_TEXT_FILES = 2000;
/**
 * Historical alias of {@link AI_IMPORT_MAX_TEXT_FILES} — kept so existing
 * consumers (lib/unpack) keep compiling; the value is the todo_20 limit.
 */
export const AI_IMPORT_MAX_DOC_FILES = AI_IMPORT_MAX_TEXT_FILES;

/*
 * ── todo_20 · T-201: source classes, inventory, estimate, usage, report ────
 */

/**
 * Content classes of documentation sources (П1). Assigned by CONTENT (sniffing
 * + optional LLM triage), never by file/dir names; `other` is still processed
 * with base priority — nothing is silently dropped.
 */
export const AI_IMPORT_SOURCE_CLASSES = [
  'release-notes',
  'user-guide',
  'admin-guide',
  'security',
  'api-spec',
  'config',
  'other',
] as const;
export type AiImportSourceClass = (typeof AI_IMPORT_SOURCE_CLASSES)[number];

/** One aggregated exclusion line of the inventory — ALWAYS carries a reason. */
export const aiImportExcludedEntrySchema = z.object({
  /** A concrete relative path or an aggregation pattern («*.png»). */
  path: z.string().min(1),
  reason: z.string().min(1),
  count: z.number().int().min(1),
});
export type AiImportExcludedEntry = z.infer<typeof aiImportExcludedEntrySchema>;

/** Aggregated inventory of the unpacked archive (П1) shown in the job view. */
export const aiImportInventoryViewSchema = z.object({
  totalFiles: z.number().int().min(0),
  /** Files queued for processing, per source class (absent class = 0). */
  processed: z.partialRecord(z.enum(AI_IMPORT_SOURCE_CLASSES), z.number().int().min(0)),
  excluded: z.array(aiImportExcludedEntrySchema),
});
export type AiImportInventoryView = z.infer<typeof aiImportInventoryViewSchema>;

/** Pre-run estimate (П2): volumes + threshold verdict. */
export const aiImportEstimateViewSchema = z.object({
  files: z.number().int().min(0),
  chunks: z.number().int().min(0),
  calls: z.number().int().min(0),
  tokens: z.number().int().min(0),
  /** Effective preset threshold; `null` = confirmation disabled. */
  thresholdTokens: z.number().int().min(0).nullable(),
  overThreshold: z.boolean(),
});
export type AiImportEstimateView = z.infer<typeof aiImportEstimateViewSchema>;

/** Accumulated token usage of a run (C4). */
export const aiImportUsageViewSchema = z.object({
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
});
export type AiImportUsageView = z.infer<typeof aiImportUsageViewSchema>;

/** Per-class coverage line of the final quality report (E4). */
export const aiImportReportCoverageSchema = z.object({
  sourceClass: z.enum(AI_IMPORT_SOURCE_CLASSES),
  files: z.number().int().min(0),
  processedFiles: z.number().int().min(0),
  extractedFunctions: z.number().int().min(0),
  extractedNfrs: z.number().int().min(0),
  retriedChunks: z.number().int().min(0),
});
export type AiImportReportCoverage = z.infer<typeof aiImportReportCoverageSchema>;

/** One visible blind spot of the run (skipped/truncated/excluded content). */
export const aiImportBlindSpotSchema = z.object({
  kind: z.enum(['skipped-file', 'truncated', 'excluded']),
  message: z.string().min(1),
  count: z.number().int().min(1),
});
export type AiImportBlindSpot = z.infer<typeof aiImportBlindSpotSchema>;

/** Final quality report (present also for cancelled/failed jobs — partial). */
export const aiImportReportViewSchema = z.object({
  coverage: z.array(aiImportReportCoverageSchema),
  blindSpots: z.array(aiImportBlindSpotSchema),
});
export type AiImportReportView = z.infer<typeof aiImportReportViewSchema>;

/*
 * ── todo_20 · T-201: error taxonomy (E1) ───────────────────────────────────
 * Every fail carries a registry code with a Russian, jargon-free message, a
 * concrete next action, a category and a resumable flag. Raw technical detail
 * (HTTP code, response body) belongs to the LOG, never to `message`.
 */

export const AI_IMPORT_ERROR_CATEGORIES = [
  'data',
  'model',
  'network',
  'config',
  'budget',
  /** todo_20 T-213: internal automation bugs — still coded, still explained. */
  'internal',
] as const;
export type AiImportErrorCategory = (typeof AI_IMPORT_ERROR_CATEGORIES)[number];

/** Registry entry: everything the UI needs to explain one failure class. */
export interface AiImportErrorInfo {
  category: AiImportErrorCategory;
  message: string;
  action: string;
  resumable: boolean;
}

/** The single error-code registry of the AI import (T-201 §12). */
export const AI_IMPORT_ERROR_CODES = {
  'CFG-01': {
    category: 'config',
    message: 'AI Hub не настроен: нет API-ключа или не выбрана модель.',
    action: 'Откройте экран AI, задайте API-ключ и выберите модель, затем повторите анализ.',
    resumable: false,
  },
  'CFG-02': {
    category: 'config',
    message: 'AI Hub отклонил доступ: ключ недействителен или не имеет прав.',
    action: 'Проверьте API-ключ на экране AI и сохраните его заново.',
    resumable: true,
  },
  'CFG-03': {
    category: 'config',
    message: 'Выбранная модель не найдена на сервере AI Hub.',
    action: 'Выберите другую модель на экране AI (список доступных — в логе).',
    resumable: true,
  },
  'DATA-01': {
    category: 'data',
    message: 'В архиве нет текстовых файлов документации.',
    action: 'Добавьте в архив документацию (.md/.txt/.json/.yaml) и повторите.',
    resumable: false,
  },
  'DATA-02': {
    category: 'data',
    message: 'Архив превышает лимит: до 200 МБ и до 2000 текстовых файлов.',
    action: 'Уменьшите архив (разбейте на части или исключите лишние файлы) и повторите.',
    resumable: false,
  },
  'DATA-03': {
    category: 'data',
    message: 'Не удалось распаковать архив: файл повреждён или это не zip/tar.gz.',
    action: 'Соберите архив заново (zip или tar.gz) и повторите загрузку.',
    resumable: false,
  },
  'NET-01': {
    category: 'network',
    message: 'Сервис AI ограничивает частоту запросов (429): повторы не помогли.',
    action: 'Подождите несколько минут и продолжите прогон — прогресс сохранён.',
    resumable: true,
  },
  'NET-02': {
    category: 'network',
    message: 'Сервис AI недоступен или отвечает ошибкой сервера: повторы не помогли.',
    action: 'Проверьте доступность AI Hub и продолжите прогон — прогресс сохранён.',
    resumable: true,
  },
  'NET-03': {
    category: 'network',
    message: 'Сервис AI не отвечает: запросы превышают тайм-аут, повторы не помогли.',
    action:
      'Увеличьте тайм-аут вызова в настройках модели или повторите позже — прогресс сохранён.',
    resumable: true,
  },
  'MODEL-01': {
    category: 'model',
    message: 'Модель так и не вернула структурированный ответ после всех попыток и делений.',
    action: 'Попробуйте другую модель или уменьшите размер фрагмента в настройках.',
    resumable: true,
  },
  'MODEL-02': {
    category: 'model',
    message: 'Даже минимальный фрагмент не помещается в контекстное окно модели.',
    action: 'Выберите модель с бо́льшим контекстным окном или уменьшите документы.',
    resumable: false,
  },
  'BUDGET-01': {
    category: 'budget',
    message: 'Бюджет прогона исчерпан — анализ мягко остановлен, результат сохранён.',
    action: 'Увеличьте бюджет в настройках модели и продолжите прогон с места остановки.',
    resumable: true,
  },
  'INT-01': {
    category: 'internal',
    message: 'Внутренняя ошибка автоматизации — прогон остановлен, прогресс сохранён.',
    action:
      'Продолжите прогон с места остановки; если ошибка повторяется — обратитесь к администратору.',
    resumable: true,
  },
} as const satisfies Record<string, AiImportErrorInfo>;
export type AiImportErrorCode = keyof typeof AI_IMPORT_ERROR_CODES;

/** Codes as a non-empty tuple for z.enum. */
export const AI_IMPORT_ERROR_CODE_VALUES = Object.keys(AI_IMPORT_ERROR_CODES) as [
  AiImportErrorCode,
  ...AiImportErrorCode[],
];

/**
 * Job error (extension of the historical `{message, hint}` — both stay for
 * old clients). `code/category/action/resumable` are filled by the registry;
 * they are schema-optional for backward compatibility, and become mandatory
 * on every fail path with T-213 (волна 1.2).
 */
export const aiImportJobErrorSchema = z.object({
  message: z.string(),
  hint: z.string(),
  code: z.enum(AI_IMPORT_ERROR_CODE_VALUES).optional(),
  category: z.enum(AI_IMPORT_ERROR_CATEGORIES).optional(),
  action: z.string().optional(),
  resumable: z.boolean().optional(),
});
export type AiImportJobError = z.infer<typeof aiImportJobErrorSchema>;

/**
 * Build the full job-error object for a registry code. `hint` mirrors
 * `action` so pre-todo_20 clients render the actionable text unchanged.
 * `overrides` refine the user-facing texts (e.g. CFG-03 with the model list);
 * technical details still belong to the log, not here.
 */
export function aiImportErrorFromCode(
  code: AiImportErrorCode,
  overrides: Partial<Pick<AiImportJobError, 'message' | 'hint' | 'resumable'>> = {},
): AiImportJobError {
  const info = AI_IMPORT_ERROR_CODES[code];
  return {
    message: overrides.message ?? info.message,
    hint: overrides.hint ?? info.action,
    code,
    category: info.category,
    action: info.action,
    resumable: overrides.resumable ?? info.resumable,
  };
}

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

/**
 * Job lifecycle statuses. todo_20 adds `awaiting-confirmation` (estimate over
 * the threshold — LLM extraction does not start until confirmed) and
 * `interrupted` (an unfinished job discovered after a server restart).
 * The historical four are NOT renamed.
 */
export const AI_IMPORT_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'awaiting-confirmation',
  'interrupted',
] as const;
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
  /**
   * Present when failed: readable message + "what to do next" (spec §4).
   * todo_20 extends it with the taxonomy fields ({@link aiImportJobErrorSchema}).
   */
  error: aiImportJobErrorSchema.optional(),
  /** Outcome of the optional relate step (todo_16 B2); absent when not requested. */
  relate: aiImportRelateViewSchema.optional(),
  /* ── todo_20 progress-with-content fields (all optional — old views stay valid) ── */
  /** File currently being processed (relative archive path). */
  currentFile: z.string().optional(),
  /** Source class of the current file. */
  currentClass: z.enum(AI_IMPORT_SOURCE_CLASSES).optional(),
  /** 1-based index of the chunk in flight. */
  chunkIndex: z.number().int().min(0).optional(),
  chunkTotal: z.number().int().min(0).optional(),
  /** Estimated remaining seconds; `null` = «оценивается…» (PO decision №6). */
  etaSeconds: z.number().min(0).nullable().optional(),
  usage: aiImportUsageViewSchema.optional(),
  inventory: aiImportInventoryViewSchema.optional(),
  estimate: aiImportEstimateViewSchema.optional(),
  report: aiImportReportViewSchema.optional(),
});
export type AiImportJobView = z.infer<typeof aiImportJobViewSchema>;

/*
 * ── todo_20 · T-201: job history (PO decision №4) ──────────────────────────
 */

/** One line of `GET /api/projects/:id/ai-import/jobs` — the run history. */
export const aiImportJobSummarySchema = z.object({
  jobId: z.string(),
  projectId: z.string(),
  status: z.enum(AI_IMPORT_STATUSES),
  /** ISO timestamp of the run start. */
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  result: aiImportResultSchema.optional(),
  /** True when the job can be continued from its checkpoint. */
  resumable: z.boolean(),
});
export type AiImportJobSummary = z.infer<typeof aiImportJobSummarySchema>;

/** Response of `GET /api/projects/:id/ai-import/jobs`. */
export const aiImportJobListSchema = z.object({
  jobs: z.array(aiImportJobSummarySchema),
});
export type AiImportJobList = z.infer<typeof aiImportJobListSchema>;

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
