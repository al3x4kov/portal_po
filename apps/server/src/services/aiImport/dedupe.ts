import { z } from 'zod';
import { unionRelatedFunctions, type AiExtractedRequirement, type AiModelPreset } from '@po/core';
import type { AiClient } from '../AiHubService.js';
import { extractJsonArray } from '../aiImportPrompt.js';
import type { AiChatMessage } from '../aiPrompt.js';
import { AI_IMPORT_JSON_ATTEMPTS } from './constants.js';
import type { AiImportRuntime } from './types.js';

/**
 * todo_20 · T-207: deterministic map-reduce deduplication (spec П3.4, B4).
 *
 * Chunk results are merged by CODE first: names are normalized (case,
 * punctuation, whitespace) and records whose normalized names are identical are
 * merged automatically. Near-matches (similarity ≥ {@link AI_DEDUPE_SIMILARITY}
 * by Levenshtein over normalized names) are «спорные пары»: the model is asked
 * in batches of ≤{@link AI_DEDUPE_PAIR_BATCH} pairs with a BINARY answer per
 * pair. A model failure never fails the job — ambiguous pairs are then kept as
 * separate requirements (the safe default).
 */

/** Similarity threshold for an ambiguous pair (архитектурное допущение T-207). */
export const AI_DEDUPE_SIMILARITY = 0.85;
/** Max pairs per one model call (spec П3.4). */
export const AI_DEDUPE_PAIR_BATCH = 20;

/** Normalize a requirement name for comparison: case, punctuation, spacing, ё→е. */
export function normalizeRequirementName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`“”‘’.,;:!?()[\]{}<>|/\\_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance with a classic two-row DP (names are short). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Similarity in [0..1] of two ALREADY-normalized names. */
export function nameSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  // Cheap lower-bound cut: the distance is at least the length difference.
  if (1 - Math.abs(a.length - b.length) / max < AI_DEDUPE_SIMILARITY) return 0;
  return 1 - levenshtein(a, b) / max;
}

/** Merge a duplicate into the kept record (deterministic: first wins the name). */
function mergeRecords(kept: AiExtractedRequirement, dup: AiExtractedRequirement): void {
  if (dup.description.length > kept.description.length) kept.description = dup.description;
  const union = unionRelatedFunctions(kept.relatedFunctions, dup.relatedFunctions);
  if (union !== kept.relatedFunctions) kept.relatedFunctions = union;
}

/** An ambiguous near-duplicate pair (both records are still in `records`). */
export interface AmbiguousPair {
  kept: AiExtractedRequirement;
  candidate: AiExtractedRequirement;
}

export interface DedupeResult {
  /** Records after automatic merging, in first-seen order (deterministic). */
  records: AiExtractedRequirement[];
  /** Names dropped by the automatic normalized-name merge. */
  autoMerged: string[];
  /** Near-matches to confirm with the model. */
  ambiguous: AmbiguousPair[];
}

/**
 * Pure pass: merge exact normalized duplicates, collect ambiguous near-pairs.
 * Records are cloned — the input array is never mutated.
 */
export function dedupeExtracted(extracted: AiExtractedRequirement[]): DedupeResult {
  const records: AiExtractedRequirement[] = [];
  const autoMerged: string[] = [];
  const ambiguous: AmbiguousPair[] = [];
  const byNormalized = new Map<string, AiExtractedRequirement>();
  const normalizedOf = new Map<AiExtractedRequirement, string>();

  for (const source of extracted) {
    const normalized = normalizeRequirementName(source.name);
    const exactKey = `${source.type}:${normalized}`;
    const exact = byNormalized.get(exactKey);
    if (exact) {
      autoMerged.push(source.name);
      mergeRecords(exact, source);
      continue;
    }
    const record: AiExtractedRequirement = { ...source };
    for (const kept of records) {
      if (kept.type !== record.type) continue;
      const sim = nameSimilarity(normalizedOf.get(kept)!, normalized);
      if (sim >= AI_DEDUPE_SIMILARITY) {
        ambiguous.push({ kept, candidate: record });
        break; // one confirmation per candidate is enough
      }
    }
    records.push(record);
    byNormalized.set(exactKey, record);
    normalizedOf.set(record, normalized);
  }
  return { records, autoMerged, ambiguous };
}

const pairAnswerSchema = z.object({
  pair: z.number().int().min(1),
  duplicate: z.boolean(),
});

function buildPairMessages(batch: AmbiguousPair[]): AiChatMessage[] {
  const lines = batch
    .map(
      (p, i) =>
        `${i + 1}. А: «${p.kept.name}» (${p.kept.description.slice(0, 160)})\n` +
        `   Б: «${p.candidate.name}» (${p.candidate.description.slice(0, 160)})`,
    )
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'Ты дедуплицируешь требования к ПО. Для каждой пары ответь, описывают ли А и Б ОДНО и то же требование. ' +
        'Ответ верни СТРОГО как JSON-массив объектов {"pair":номер,"duplicate":true|false} — по одному на каждую пару, без пояснений.',
    },
    { role: 'user', content: `Пары для проверки:\n${lines}` },
  ];
}

export interface DedupeStageInput {
  extracted: AiExtractedRequirement[];
  client: AiClient;
  model: string;
  preset: AiModelPreset;
}

export type DedupeOutcome = { ok: true; extracted: AiExtractedRequirement[] } | { ok: false };

/**
 * Deduplication step between analyze and structure. Deterministic merging is
 * code-only; ambiguous pairs go to the model in batches with a binary answer.
 * Best-effort: any model failure keeps both records (only cancel stops the run).
 */
export async function runDedupeStage(
  rt: AiImportRuntime,
  input: DedupeStageInput,
): Promise<DedupeOutcome> {
  const { records, autoMerged, ambiguous } = dedupeExtracted(input.extracted);
  if (autoMerged.length > 0) {
    rt.log(
      'warn',
      `Дедупликация: автоматически слито ${autoMerged.length} повторов ` +
        `(${autoMerged.map((n) => `«${n}»`).join(', ')}).`,
    );
  }
  if (ambiguous.length === 0) return { ok: true, extracted: records };

  rt.log(
    'info',
    `Дедупликация: спорных пар имён ${ambiguous.length} — уточняю у модели (батчами по ${AI_DEDUPE_PAIR_BATCH}).`,
  );
  const drop = new Set<AiExtractedRequirement>();
  for (let i = 0; i < ambiguous.length; i += AI_DEDUPE_PAIR_BATCH) {
    if (rt.cancelled()) return { ok: false };
    const batch = ambiguous.slice(i, i + AI_DEDUPE_PAIR_BATCH);
    const outcome = await rt.chat<Array<z.infer<typeof pairAnswerSchema>>>({
      client: input.client,
      model: input.model,
      preset: input.preset,
      messages: buildPairMessages(batch),
      parse: (content) => {
        const array = extractJsonArray(content);
        if (array === null) return null;
        const valid = array
          .map((x) => pairAnswerSchema.safeParse(x))
          .filter((r) => r.success)
          .map((r) => r.data);
        return valid.length > 0 ? valid : null;
      },
      attemptWarn: (attempt) =>
        `Дедупликация: ответ модели не распознан (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
      truncatedWarn: () => 'Дедупликация: ответ модели обрезан по лимиту токенов.',
    });
    if (outcome.kind === 'cancelled') return { ok: false };
    if (outcome.kind !== 'ok') {
      rt.log(
        'warn',
        'Дедупликация: подтверждение пар у модели не получено — спорные записи сохранены как отдельные требования.',
      );
      continue;
    }
    for (const answer of outcome.value) {
      const pair = batch[answer.pair - 1];
      if (!pair || !answer.duplicate || drop.has(pair.kept)) continue;
      drop.add(pair.candidate);
      mergeRecords(pair.kept, pair.candidate);
      rt.log(
        'info',
        `Дедупликация: «${pair.candidate.name}» слито с «${pair.kept.name}» (подтверждено моделью).`,
      );
    }
  }
  const final = records.filter((r) => !drop.has(r));
  if (drop.size > 0) {
    rt.log('info', `Дедупликация завершена: слито ${drop.size}, осталось ${final.length}.`);
  }
  return { ok: true, extracted: final };
}
