import type { AiImportEstimateView } from '@po/core';
import type { AiImportRuntime } from './types.js';
import type { InventoryFileEntry } from './inventoryStage.js';

/**
 * todo_20 · T-204: смета прогона (spec П2, A4).
 *
 * The estimate is computed from the inventory BEFORE any extraction call:
 * chunks from file sizes and the effective chunk size, ~4 chars/token
 * (архитектурное допущение T-204) plus a flat per-call prompt overhead.
 *
 * The stage publishes the estimate in the job view and the log;
 * `estimate.overThreshold` drives the `awaiting-confirmation` gate in
 * AiImportService (no extraction call happens until `POST /confirm`).
 */

/** ~4 characters per token (архитектурное допущение). */
export const AI_ESTIMATE_CHARS_PER_TOKEN = 4;
/** Flat prompt overhead per extraction call (system prompt + archive map), tokens. */
export const AI_ESTIMATE_CALL_OVERHEAD_TOKENS = 900;

export interface EstimateInput {
  files: InventoryFileEntry[];
  /** Effective chunk size, chars (`preset.chunkChars` or the test override). */
  chunkChars: number;
  /** `preset.estimateThresholdTokens`: 0 = always confirm, null = never. */
  thresholdTokens: number | null;
}

/**
 * Pure computation — unit-testable without a runtime.
 *
 * todo_23 M1: the estimate mirrors the batched analyze stage — small files
 * (< chunkChars) of one source class share fragments, so 200 мелких файлов
 * cost десятки вызовов, not сотни; large files keep per-file chunking.
 */
export function computeEstimate(input: EstimateInput): AiImportEstimateView {
  let chunks = 0;
  let totalChars = 0;
  const smallByClass = new Map<string, number>();
  for (const file of input.files) {
    if (file.size <= 0) continue;
    totalChars += file.size;
    if (file.size >= input.chunkChars) {
      chunks += Math.ceil(file.size / input.chunkChars);
    } else {
      smallByClass.set(file.sourceClass, (smallByClass.get(file.sourceClass) ?? 0) + file.size);
    }
  }
  for (const total of smallByClass.values()) {
    chunks += Math.max(1, Math.ceil(total / input.chunkChars));
  }
  const calls = chunks;
  const tokens =
    Math.ceil(totalChars / AI_ESTIMATE_CHARS_PER_TOKEN) + calls * AI_ESTIMATE_CALL_OVERHEAD_TOKENS;
  const overThreshold =
    input.thresholdTokens !== null &&
    (input.thresholdTokens === 0 || tokens > input.thresholdTokens);
  return {
    files: input.files.length,
    chunks,
    calls,
    tokens,
    thresholdTokens: input.thresholdTokens,
    overThreshold,
  };
}

export type EstimateOutcome = { ok: true; estimate: AiImportEstimateView };

/** Stage «estimate» (progress 8–10): publish the plan in the view + log. */
export async function runEstimateStage(
  rt: AiImportRuntime,
  input: EstimateInput,
): Promise<EstimateOutcome> {
  const estimate = computeEstimate(input);
  rt.job.estimate = estimate;
  rt.log(
    'info',
    `Смета прогона: файлов ${estimate.files}, фрагментов ~${estimate.chunks}, ` +
      `AI-вызовов ~${estimate.calls}, токенов ~${estimate.tokens}.` +
      (estimate.overThreshold
        ? ' Оценка выше порога подтверждения — извлечение начнётся только после подтверждения.'
        : ''),
  );
  rt.job.progress = Math.max(rt.job.progress, 10);
  return { ok: true, estimate };
}
