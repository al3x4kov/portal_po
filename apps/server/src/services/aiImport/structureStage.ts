import {
  AI_IMPORT_STRUCTURE_BATCH,
  nameKey,
  type AiExtractedRequirement,
  type AiModelPreset,
} from '@po/core';
import type { AiClient } from '../AiHubService.js';
import {
  buildStructureMessages,
  parseStructureResponse,
  type ParsedStructure,
  type StructureItem,
} from '../aiImportPrompt.js';
import { AI_IMPORT_JSON_ATTEMPTS } from './constants.js';
import { sanitize } from './text.js';
import type { AiImportRuntime, ArchiveMap } from './types.js';

export interface StructureInput {
  extracted: AiExtractedRequirement[];
  archiveMap: ArchiveMap;
  client: AiClient;
  model: string;
  apiKey: string;
  preset: AiModelPreset;
  structureBatch: number;
}

export type StructureOutcome =
  { ok: true; structureParentByKey: Map<string, string | null> } | { ok: false };

/**
 * Stage «structure» (progress 65–80). One extra AI pass over the FULL extracted
 * set (batched) that assembles the FUNCTION/NFR tree. The answer is
 * authoritative for parents; records missing from it stay roots. Best-effort: a
 * batch failure never fails the job — only a cancel stops the run.
 */
export async function runStructureStage(
  rt: AiImportRuntime,
  input: StructureInput,
): Promise<StructureOutcome> {
  const { job } = rt;
  job.stage = 'structure';
  if (rt.cancelled()) return { ok: false };
  // First answer per (type, name): null = explicit root, string = parent.
  const structureParentByKey = new Map<string, string | null>();
  const seenKeys = new Set<string>();
  const structureItems: StructureItem[] = [];
  for (const record of input.extracted) {
    const key = nameKey(record.type, record.name);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    structureItems.push({ type: record.type, name: record.name, source: record.source });
  }
  if (structureItems.length === 0) {
    // Task 14 B9: nothing extracted → no hub calls, no empty batch.
    rt.log('info', 'Структурировать нечего — требования не извлечены.');
  } else {
    rt.log('info', 'Построение древовидной структуры ФТ/НФТ через AI hub…');
  }
  const batchSize = input.structureBatch ?? AI_IMPORT_STRUCTURE_BATCH;
  const batches: StructureItem[][] = [];
  for (let i = 0; i < structureItems.length; i += batchSize) {
    batches.push(structureItems.slice(i, i + batchSize));
  }
  for (let b = 0; b < batches.length; b++) {
    if (b > 0 && rt.cancelled()) return { ok: false };
    const batchLabel = `Структуризация (батч ${b + 1}/${batches.length})`;
    // todo_16 Ф3: pre-call line before each structure batch request.
    rt.log('info', `Структура: батч ${b + 1}/${batches.length} — запрос к модели…`);
    const outcome = await rt.chat<ParsedStructure>({
      client: input.client,
      model: input.model,
      preset: input.preset,
      messages: buildStructureMessages(batches[b]!, input.archiveMap, structureItems),
      parse: (content) => parseStructureResponse(content),
      // Task 14 B7: the LAST attempt keeps valid nodes instead of losing the batch.
      parseFinal: (content) => parseStructureResponse(content, 'lenient'),
      attemptWarn: (attempt) =>
        `${batchLabel}: ответ модели не распознан как JSON-массив структуры (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
      truncatedWarn: (attempt) =>
        `${batchLabel}: ответ модели обрезан по лимиту токенов (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
    });
    if (outcome.kind === 'cancelled') return { ok: false };
    if (outcome.kind === 'ok') {
      const { nodes, droppedInvalid, total } = outcome.value;
      if (droppedInvalid > 0) {
        rt.log(
          'warn',
          `${batchLabel}: принято ${total - droppedInvalid} из ${total} узлов, невалидных отброшено ${droppedInvalid}.`,
        );
      }
      // Task 14 B5: coverage report for the batch answer.
      const answered = new Set<string>();
      let foreign = 0;
      for (const node of nodes) {
        const key = nameKey(node.type, node.name);
        if (!seenKeys.has(key)) {
          foreign += 1; // never becomes a parent mapping
          continue;
        }
        const parent =
          node.parentName !== null && node.parentName.trim().length > 0 ? node.parentName : null;
        if (structureParentByKey.has(key)) {
          if (structureParentByKey.get(key) !== parent) {
            rt.log(
              'warn',
              `${batchLabel}: конфликт узлов для «${node.name}» (${node.type}) — разные parentName, используется первый.`,
            );
          }
        } else {
          structureParentByKey.set(key, parent);
        }
        answered.add(key);
      }
      if (foreign > 0) {
        rt.log('warn', `${batchLabel}: посторонних узлов проигнорировано: ${foreign}.`);
      }
      const missing = batches[b]!.filter(
        (item) => !answered.has(nameKey(item.type, item.name)),
      ).length;
      if (missing > 0) {
        rt.log(
          'warn',
          `${batchLabel}: требований без узла в ответе: ${missing} (останутся корневыми).`,
        );
      }
    } else {
      if (outcome.kind === 'upstream') {
        rt.log(
          'warn',
          sanitize(
            `${batchLabel}: ошибка обращения к AI Hub: ${outcome.error.message}.`,
            input.apiKey,
          ),
        );
      }
      rt.log('warn', 'Структура для батча не получена — записи останутся корневыми.');
    }
    job.progress = Math.min(80, 65 + Math.round((15 * (b + 1)) / batches.length));
  }
  job.progress = 80;
  return { ok: true, structureParentByKey };
}
