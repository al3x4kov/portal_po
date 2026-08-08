import { z } from 'zod';
import {
  unionRelatedFunctions,
  type AiExtractedRequirement,
  type AiModelPreset,
  type Requirement,
} from '@po/core';
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

export type DedupeOutcome =
  | {
      ok: true;
      extracted: AiExtractedRequirement[];
      /**
       * Двухзонная выверка (zone 1): semantic-duplicate groups — every group is
       * ≥2 records of `extracted` the model (or the fuzzy pass) considers the
       * same requirement. Records are NOT merged anymore: the PO decides on the
       * review gate which of them to keep.
       */
      duplicateGroups: AiExtractedRequirement[][];
      /** Names dropped by the automatic exact normalized-name merge. */
      autoMerged: string[];
    }
  | { ok: false };

/**
 * Build connected components over confirmed duplicate pairs (a chain A~B, B~C
 * lands in one group). Group order and in-group order are deterministic:
 * first-seen order of `records`.
 */
export function groupDuplicatePairs(
  records: AiExtractedRequirement[],
  pairs: Array<{ kept: AiExtractedRequirement; candidate: AiExtractedRequirement }>,
): AiExtractedRequirement[][] {
  const groupOf = new Map<AiExtractedRequirement, Set<AiExtractedRequirement>>();
  for (const { kept, candidate } of pairs) {
    const a = groupOf.get(kept);
    const b = groupOf.get(candidate);
    if (a && b) {
      if (a !== b) {
        for (const rec of b) {
          a.add(rec);
          groupOf.set(rec, a);
        }
      }
    } else if (a) {
      a.add(candidate);
      groupOf.set(candidate, a);
    } else if (b) {
      b.add(kept);
      groupOf.set(kept, b);
    } else {
      const group = new Set([kept, candidate]);
      groupOf.set(kept, group);
      groupOf.set(candidate, group);
    }
  }
  const seen = new Set<Set<AiExtractedRequirement>>();
  const groups: AiExtractedRequirement[][] = [];
  for (const record of records) {
    const group = groupOf.get(record);
    if (!group || seen.has(group)) continue;
    seen.add(group);
    groups.push(records.filter((r) => group.has(r)));
  }
  return groups;
}

/** Zone-2 verdict for one generated record vs the existing project set. */
export interface ExistingDuplicate {
  /** Name of the existing project requirement. */
  name: string;
  /** Similarity in [0..1]; 1 = exact normalized-name match. */
  similarity: number;
}

/**
 * Двухзонная выверка (zone 2), deterministic: match generated records against
 * the EXISTING project requirements of the same type — exact normalized name
 * first (similarity 1), then fuzzy ≥ {@link AI_DEDUPE_SIMILARITY} (best match
 * wins). Pure; returns only the flagged records.
 */
export function detectExistingDuplicates(
  records: readonly AiExtractedRequirement[],
  existing: readonly Pick<Requirement, 'type' | 'name'>[],
): Map<AiExtractedRequirement, ExistingDuplicate> {
  const byType = new Map<string, Array<{ name: string; normalized: string }>>();
  for (const req of existing) {
    const list = byType.get(req.type) ?? [];
    list.push({ name: req.name, normalized: normalizeRequirementName(req.name) });
    byType.set(req.type, list);
  }
  const result = new Map<AiExtractedRequirement, ExistingDuplicate>();
  for (const record of records) {
    const candidates = byType.get(record.type);
    if (!candidates) continue;
    const normalized = normalizeRequirementName(record.name);
    let best: ExistingDuplicate | undefined;
    for (const candidate of candidates) {
      const sim =
        candidate.normalized === normalized ? 1 : nameSimilarity(candidate.normalized, normalized);
      if (sim >= AI_DEDUPE_SIMILARITY && (!best || sim > best.similarity)) {
        best = { name: candidate.name, similarity: sim };
        if (sim === 1) break;
      }
    }
    if (best) result.set(record, best);
  }
  return result;
}

/**
 * Deduplication step between analyze and structure. The exact normalized-name
 * merge stays automatic (identical names ARE the same requirement); ambiguous
 * near-pairs go to the model in batches with a binary answer, but a confirmed
 * pair is NO LONGER merged silently — it forms a duplicate GROUP handed to the
 * zone-1 manual review gate. Best-effort: any model failure keeps the pair
 * ungrouped-but-present (only cancel stops the run).
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
  if (ambiguous.length === 0) {
    return { ok: true, extracted: records, duplicateGroups: [], autoMerged };
  }

  rt.log(
    'info',
    `Дедупликация: спорных пар имён ${ambiguous.length} — уточняю у модели (батчами по ${AI_DEDUPE_PAIR_BATCH}).`,
  );
  const confirmed: AmbiguousPair[] = [];
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
      if (!pair || !answer.duplicate) continue;
      confirmed.push(pair);
      rt.log(
        'info',
        `Дедупликация: «${pair.candidate.name}» похоже дублирует «${pair.kept.name}» — пара уйдёт на ручную выверку (зона 1).`,
      );
    }
  }
  const duplicateGroups = groupDuplicatePairs(records, confirmed);
  if (duplicateGroups.length > 0) {
    rt.log(
      'info',
      `Дедупликация завершена: групп смысловых дублей ${duplicateGroups.length} — решение остаётся за вами на шаге выверки.`,
    );
  }
  return { ok: true, extracted: records, duplicateGroups, autoMerged };
}
