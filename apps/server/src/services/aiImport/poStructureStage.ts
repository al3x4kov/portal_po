import {
  AI_IMPORT_PO_ASSIGN_BATCH,
  AI_IMPORT_PO_TAXONOMY_BATCH,
  nameKey,
  type AiExtractedRequirement,
  type AiModelPreset,
} from '@po/core';
import type { AiClient } from '../AiHubService.js';
import {
  buildPoAssignMessages,
  buildPoTaxonomyMessages,
  parsePoAssignResponse,
  parseStructureResponse,
  type ParsedPoAssign,
  type ParsedStructure,
  type StructureItem,
} from '../aiImportPrompt.js';
import { AI_IMPORT_JSON_ATTEMPTS } from './constants.js';
import {
  assignTaxonomyIds,
  emptyTaxonomy,
  materializeTaxonomy,
  mergeTaxonomyRound,
  resolveAssignments,
  type PoAssignStats,
} from './poTaxonomy.js';
import {
  ResponseFormatNegotiator,
  buildPoAssignResponseFormat,
  buildPoTaxonomyResponseFormat,
} from './structuredOutput.js';
import { sanitize } from './text.js';
import type { AiImportRuntime, ArchiveMap } from './types.js';

export interface PoStructureInput {
  extracted: AiExtractedRequirement[];
  archiveMap: ArchiveMap;
  client: AiClient;
  model: string;
  apiKey: string;
  preset: AiModelPreset;
  /** Test overrides; production uses the core constants. */
  taxonomyBatch?: number;
  assignBatch?: number;
}

export type PoStructureOutcome =
  | {
      ok: true;
      /** Synthetic group records to prepend to the extracted set. */
      groups: AiExtractedRequirement[];
      structureParentByKey: Map<string, string | null>;
    }
  | { ok: false };

/**
 * Opt-in замена этапа «structure» (buildTree, progress 65–80): логическое
 * дерево «навыка AI Product Owner». Два прохода:
 *
 * 1. **Таксономия** — map-reduce по батчам имён: модель-«PO» проектирует
 *    компактную бизнес-таксономию (домены → разделы, 2 уровня), каждый раунд
 *    видит и расширяет текущую; слияние детерминированно (первый ответ
 *    побеждает, капы ширины, глубина ≤ 2 — poTaxonomy.ts).
 * 2. **Раскладка** — каждому требованию один узел по короткому id («F1.2»);
 *    неизвестные id / чужой тип / посторонние имена отбрасываются с warn.
 *
 * Группирующие узлы возвращаются синтетическими записями — populate создаёт
 * их как обычные требования (origin AI_DOCS), поэтому весь существующий
 * механизм agregate/populate (дедуп, циклы, идемпотентность re-run)
 * переиспользуется без изменений. Best-effort: сбой раунда/батча никогда не
 * валит job — соответствующие требования остаются корневыми.
 */
export async function runPoStructureStage(
  rt: AiImportRuntime,
  input: PoStructureInput,
): Promise<PoStructureOutcome> {
  const { job } = rt;
  job.stage = 'structure';
  if (rt.cancelled()) return { ok: false };

  const seenKeys = new Set<string>();
  const items: StructureItem[] = [];
  for (const record of input.extracted) {
    const key = nameKey(record.type, record.name);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    items.push({ type: record.type, name: record.name, source: record.source });
  }
  if (items.length === 0) {
    rt.log('info', 'Логическое дерево (AI PO): структурировать нечего — требования не извлечены.');
    job.progress = 80;
    return { ok: true, groups: [], structureParentByKey: new Map() };
  }
  rt.log('info', 'Логическое дерево (AI PO): проектирование бизнес-таксономии…');

  // ── Проход 1: таксономия ──────────────────────────────────────────────────
  const taxonomyBatch = input.taxonomyBatch ?? AI_IMPORT_PO_TAXONOMY_BATCH;
  const rounds: StructureItem[][] = [];
  for (let i = 0; i < items.length; i += taxonomyBatch) {
    rounds.push(items.slice(i, i + taxonomyBatch));
  }
  const taxonomy = emptyTaxonomy();
  const taxonomyNegotiator = new ResponseFormatNegotiator(buildPoTaxonomyResponseFormat);
  for (let r = 0; r < rounds.length; r++) {
    if (r > 0 && rt.cancelled()) return { ok: false };
    const label = `Таксономия (раунд ${r + 1}/${rounds.length})`;
    rt.log('info', `${label}: запрос к модели…`);
    const current = assignTaxonomyIds(taxonomy).list;
    const outcome = await rt.chat<ParsedStructure>({
      client: input.client,
      model: input.model,
      preset: input.preset,
      messages: buildPoTaxonomyMessages(current, rounds[r]!, input.archiveMap, {
        index: r + 1,
        total: rounds.length,
      }),
      parse: (content) => parseStructureResponse(content),
      parseFinal: (content) => parseStructureResponse(content, 'lenient'),
      negotiator: taxonomyNegotiator,
      attemptWarn: (attempt) =>
        `${label}: ответ модели не распознан как JSON-массив узлов (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
      truncatedWarn: (attempt) =>
        `${label}: ответ модели обрезан по лимиту токенов (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
    });
    if (outcome.kind === 'cancelled') return { ok: false };
    if (outcome.kind === 'ok') {
      const { nodes, droppedInvalid, total } = outcome.value;
      if (droppedInvalid > 0) {
        rt.log('warn', `${label}: принято ${total - droppedInvalid} из ${total} узлов.`);
      }
      const stats = mergeTaxonomyRound(taxonomy, nodes);
      const capped = stats.rootsCapped + stats.childrenCapped;
      if (capped > 0 || stats.depthFlattened > 0) {
        rt.log(
          'warn',
          `${label}: узлов сверх лимитов ширины пропущено ${capped}, ` +
            `глубже двух уровней перевешено под домен: ${stats.depthFlattened}.`,
        );
      }
    } else {
      if (outcome.kind === 'upstream') {
        rt.log(
          'warn',
          sanitize(`${label}: ошибка обращения к AI Hub: ${outcome.error.message}.`, input.apiKey),
        );
      }
      rt.log('warn', `${label}: раунд пропущен — таксономия дополнится следующими раундами.`);
    }
    job.progress = Math.min(72, 65 + Math.round((7 * (r + 1)) / rounds.length));
  }

  const { list, byId } = assignTaxonomyIds(taxonomy);
  if (list.length === 0) {
    rt.log(
      'warn',
      'Логическое дерево (AI PO): таксономию построить не удалось — требования останутся корневыми.',
    );
    job.progress = 80;
    return { ok: true, groups: [], structureParentByKey: new Map() };
  }
  const fnRoots = list.filter((n) => n.type === 'FUNCTION' && n.parentKey === null).length;
  const fnSections = list.filter((n) => n.type === 'FUNCTION' && n.parentKey !== null).length;
  const nfrRoots = list.filter((n) => n.type === 'NFR' && n.parentKey === null).length;
  const nfrSections = list.filter((n) => n.type === 'NFR' && n.parentKey !== null).length;
  rt.log(
    'info',
    `Таксономия готова: ФТ — ${fnRoots} доменов, ${fnSections} разделов; ` +
      `НФТ — ${nfrRoots} доменов, ${nfrSections} разделов.`,
  );

  const { groups, parentNameByKey, collisions } = materializeTaxonomy(taxonomy, seenKeys);
  if (collisions.length > 0) {
    rt.log(
      'info',
      `Извлечённые требования, ставшие узлами дерева: ${collisions.map((n) => `«${n}»`).join(', ')}.`,
    );
  }

  // ── Проход 2: раскладка требований по узлам ──────────────────────────────
  rt.log('info', 'Логическое дерево (AI PO): раскладка требований по узлам…');
  const assignBatch = input.assignBatch ?? AI_IMPORT_PO_ASSIGN_BATCH;
  const batches: StructureItem[][] = [];
  for (let i = 0; i < items.length; i += assignBatch) {
    batches.push(items.slice(i, i + assignBatch));
  }
  const totals: PoAssignStats = {
    assigned: 0,
    explicitRoots: 0,
    foreign: 0,
    unknownNode: 0,
    typeMismatch: 0,
  };
  const assignNegotiator = new ResponseFormatNegotiator(buildPoAssignResponseFormat);
  for (let b = 0; b < batches.length; b++) {
    if (rt.cancelled()) return { ok: false };
    const label = `Раскладка (батч ${b + 1}/${batches.length})`;
    rt.log('info', `${label}: запрос к модели…`);
    const outcome = await rt.chat<ParsedPoAssign>({
      client: input.client,
      model: input.model,
      preset: input.preset,
      messages: buildPoAssignMessages(list, batches[b]!),
      parse: (content) => parsePoAssignResponse(content),
      parseFinal: (content) => parsePoAssignResponse(content, 'lenient'),
      negotiator: assignNegotiator,
      attemptWarn: (attempt) =>
        `${label}: ответ модели не распознан как JSON-массив назначений (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
      truncatedWarn: (attempt) =>
        `${label}: ответ модели обрезан по лимиту токенов (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
    });
    if (outcome.kind === 'cancelled') return { ok: false };
    if (outcome.kind === 'ok') {
      const { assignments, droppedInvalid, total } = outcome.value;
      if (droppedInvalid > 0) {
        rt.log('warn', `${label}: принято ${total - droppedInvalid} из ${total} назначений.`);
      }
      const batchKeys = new Set(batches[b]!.map((i) => nameKey(i.type, i.name)));
      const stats = resolveAssignments(assignments, byId, batchKeys, parentNameByKey);
      totals.assigned += stats.assigned;
      totals.explicitRoots += stats.explicitRoots;
      totals.foreign += stats.foreign;
      totals.unknownNode += stats.unknownNode;
      totals.typeMismatch += stats.typeMismatch;
      const dropped = stats.foreign + stats.unknownNode + stats.typeMismatch;
      if (dropped > 0) {
        rt.log(
          'warn',
          `${label}: отброшено ответов ${dropped} ` +
            `(посторонние: ${stats.foreign}, неизвестный узел: ${stats.unknownNode}, чужой тип: ${stats.typeMismatch}).`,
        );
      }
    } else {
      if (outcome.kind === 'upstream') {
        rt.log(
          'warn',
          sanitize(`${label}: ошибка обращения к AI Hub: ${outcome.error.message}.`, input.apiKey),
        );
      }
      rt.log('warn', `${label}: батч пропущен — его требования останутся корневыми.`);
    }
    job.progress = Math.min(80, 72 + Math.round((8 * (b + 1)) / batches.length));
  }

  const unassigned = items.filter(
    (item) => !parentNameByKey.has(nameKey(item.type, item.name)),
  ).length;
  rt.log(
    'info',
    `Логическое дерево (AI PO): разложено ${totals.assigned} требований, ` +
      `оставлено корневыми по решению модели: ${totals.explicitRoots}, без ответа: ${unassigned}; ` +
      `создаётся группирующих узлов: ${groups.length}.`,
  );
  job.progress = 80;
  return { ok: true, groups, structureParentByKey: parentNameByKey };
}
