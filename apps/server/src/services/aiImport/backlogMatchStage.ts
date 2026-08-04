import {
  AI_BACKLOG_MATCH_BATCH,
  aiBacklogMatchAnswerSchema,
  type AiBacklogMapping,
  type AiBacklogMatchAnswer,
  type AiBacklogReview,
  type AiImportErrorCode,
  type AiModelPreset,
  type Requirement,
  type RequirementType,
  type TargetQuarter,
} from '@po/core';
import type { AiClient } from '../AiHubService.js';
import type { AiChatMessage } from '../aiPrompt.js';
import { extractJsonArray } from '../aiImportPrompt.js';
import { AI_IMPORT_JSON_ATTEMPTS } from './constants.js';
import { normalizeRequirementName } from './dedupe.js';
import { sanitize, shortenText } from './text.js';
import type { AiCallErrorClass } from './aiCall.js';
import type { AiImportRuntime } from './types.js';
import type { BacklogRow } from './backlogXlsx.js';
import type { ResponseFormatNegotiator } from './structuredOutput.js';

/**
 * todo_22 · T-303: AI-соотнесение строк бэклога с деревом проекта (П3, PO №1/№5).
 *
 * The model receives a compact map of the EXISTING FUNCTION/NFR tree and a
 * batch of ≤{@link AI_BACKLOG_MATCH_BATCH} rows; for every row it returns a
 * business name, a type, a parent (existing node or a NEW business node — the
 * prompt forbids technical dump groups with explicit good/bad examples) and an
 * optional duplicate. Everything is then re-validated DETERMINISTICALLY
 * against the real tree: a hallucinated existing parent becomes a new root
 * node, a hallucinated duplicate becomes null (both logged). New-node names
 * are deduplicated across batches with the todo_20 normalization. A batch the
 * model cannot answer is split in half (adaptive-chunker pattern); a single
 * row that still fails → MODEL-01 (resumable — paid batches live in the
 * checkpoint written after EVERY batch).
 */

/** Character budget of the tree map handed to every match call. */
export const AI_BACKLOG_TREE_CHARS = 6000;

const MATCH_SYSTEM_PROMPT = [
  'Ты — продуктовый аналитик портала управления требованиями Product Owner.',
  'Тебе дают карту существующего дерева требований проекта (ФТ и НФТ с родителями)',
  'и батч строк бэклога (rowId, ключ и исходная формулировка).',
  'Для КАЖДОЙ строки батча определи, куда она встраивается в дерево, и верни объект',
  '{"rowId":string,"businessName":string,"type":"FUNCTION"|"NFR",',
  '"parentExisting":string|null,"parentNew":{"name":string,"parentName":string|null}|null,',
  '"duplicateOf":string|null}.',
  'businessName — конструктивное бизнес-имя требования на русском языке',
  '(что получает пользователь), а не техническая формулировка задачи.',
  'type: FUNCTION по умолчанию; NFR — только если формулировка явно нефункциональная',
  '(производительность, надёжность, безопасность и т.п.).',
  'parentExisting — ТОЧНОЕ имя подходящего узла из карты дерева, или null.',
  'parentNew — НОВЫЙ узел, если подходящего в дереве нет: только БИЗНЕС-ФУНКЦИЯ продукта,',
  'его parentName — точное имя существующего узла или null для нового корневого узла.',
  'Ровно одно из parentExisting/parentNew должно быть непустым.',
  'ЗАПРЕЩЕНО предлагать технические и служебные группировки — узлы без бизнесового смысла.',
  'Хорошие новые узлы: «Просмотр истории изменений», «Управление правами доступа»,',
  '«Статистика репозитория». Плохие (запрещены): «Бэклог», «Импортированные задачи»,',
  '«Прочее», «Разное», «Технические доработки», «Задачи из Jira».',
  'duplicateOf — точное имя существующего требования из карты, если строка описывает',
  'ТО ЖЕ САМОЕ требование; иначе null.',
  'Используй ТОЛЬКО имена из карты дерева, ничего не выдумывай.',
  'Ответ верни СТРОГО как JSON-массив — ровно по одному объекту на каждую строку батча.',
  'Без markdown, без преамбул и пояснений.',
].join(' ');

/** Compact tree map: one `TYPE\tимя\tродитель: <имя|—>` line per requirement. */
export function buildBacklogTreeMap(
  existing: readonly Requirement[],
  maxChars: number = AI_BACKLOG_TREE_CHARS,
): string {
  if (existing.length === 0) return '(дерево пусто — проект пока без требований)';
  const bySlug = new Map(existing.map((r) => [r.slug, r]));
  const lines = [...existing]
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
    .map((req) => {
      const parentSlug = req.links.find((l) => l.type === 'CHILD_OF')?.targetSlug;
      const parent = parentSlug ? bySlug.get(parentSlug)?.name : undefined;
      return `${req.type}\t${req.name}\tродитель: ${parent ?? '—'}`;
    });
  const full = lines.join('\n');
  if (full.length <= maxChars) return full;
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const candidate = kept.length === 0 ? line.length : length + 1 + line.length;
    if (candidate > maxChars - 40) break;
    kept.push(line);
    length = candidate;
  }
  return `${kept.join('\n')}\n…и ещё ${lines.length - kept.length} требований`;
}

/** Build the two-message conversation for one match batch. */
export function buildBacklogMatchMessages(
  batch: readonly BacklogRow[],
  treeMap: string,
): AiChatMessage[] {
  const rows = batch
    .map((row) => `${row.rowId}\t${row.key ?? '—'}\t${row.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  const user = [
    'Карта дерева требований проекта (тип, имя, родитель):',
    treeMap,
    '',
    `Батч строк бэклога (${batch.length} шт., формат: rowId, ключ, формулировка через табуляцию):`,
    rows,
  ].join('\n');
  return [
    { role: 'system', content: MATCH_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/**
 * Parse one match answer: locate the JSON array, validate each element and
 * keep only answers for rows of THIS batch. `strict` invalidates the whole
 * answer on any bad/foreign element (retried); `lenient` keeps the valid part.
 */
export function parseMatchResponse(
  content: string,
  batchRowIds: ReadonlySet<string>,
  mode: 'strict' | 'lenient' = 'strict',
): AiBacklogMatchAnswer[] | null {
  const array = extractJsonArray(content);
  if (array === null) return null;
  const answers: AiBacklogMatchAnswer[] = [];
  for (const element of array) {
    const parsed = aiBacklogMatchAnswerSchema.safeParse(element);
    if (!parsed.success || !batchRowIds.has(parsed.data.rowId)) {
      if (mode === 'strict') return null;
      continue;
    }
    answers.push(parsed.data);
  }
  if (answers.length === 0 && mode === 'strict') return null;
  return answers;
}

/** Registry code for an exhausted/fatal upstream failure of one match call. */
function upstreamCode(errorClass: AiCallErrorClass): AiImportErrorCode {
  switch (errorClass) {
    case 'rate-limit':
      return 'NET-01';
    case 'timeout':
      return 'NET-03';
    case 'auth':
      return 'CFG-02';
    case 'model-not-found':
      return 'CFG-03';
    case 'server':
    case 'network':
      return 'NET-02';
    default:
      return 'MODEL-01';
  }
}

export interface BacklogMatchInput {
  rows: readonly BacklogRow[];
  /** Shared target for rows without a file-provided one (confirm/default). */
  target: { quarter: TargetQuarter; year: number };
  existing: readonly Requirement[];
  client: AiClient;
  model: string;
  apiKey: string;
  preset: AiModelPreset;
  negotiator?: ResponseFormatNegotiator;
  /** Batch size override for tests; production uses the core constant (20). */
  batchSize?: number;
  /** Already-matched mappings from the checkpoint (resume — never re-paid). */
  resume?: { mappings: readonly AiBacklogMapping[] };
}

export type BacklogMatchOutcome = { ok: true; review: AiBacklogReview } | { ok: false };

interface NewNode {
  name: string;
  parentName: string | null;
  rowCount: number;
}

/**
 * The match stage. Mutates nothing outside the runtime: the ONLY writes are
 * checkpoints (paid mappings after every batch). Returns the review payload
 * for the `awaiting-review` gate; the caller owns the status transition.
 */
export async function runBacklogMatchStage(
  rt: AiImportRuntime,
  input: BacklogMatchInput,
): Promise<BacklogMatchOutcome> {
  const { job } = rt;
  job.stage = 'analyze';
  if (rt.cancelled()) return { ok: false };

  const treeMap = buildBacklogTreeMap(input.existing);
  // Canonical existing names per type + a flat map for duplicate validation.
  const existingByTypeKey = new Map<string, string>();
  for (const req of input.existing) {
    existingByTypeKey.set(`${req.type}:${normalizeRequirementName(req.name)}`, req.name);
  }
  const findExisting = (type: RequirementType, name: string): string | undefined =>
    existingByTypeKey.get(`${type}:${normalizeRequirementName(name)}`);
  const findExistingAnyType = (name: string): string | undefined => {
    const key = normalizeRequirementName(name);
    return (
      existingByTypeKey.get(`FUNCTION:${key}`) ?? existingByTypeKey.get(`NFR:${key}`) ?? undefined
    );
  };

  const mappingByRowId = new Map<string, AiBacklogMapping>();
  // New nodes deduplicated across batches by normalized name (todo_20 rule).
  const newNodes = new Map<string, NewNode>();
  const registerNewNode = (name: string, parentName: string | null): string => {
    const key = normalizeRequirementName(name);
    let node = newNodes.get(key);
    if (!node) {
      node = { name: name.trim(), parentName, rowCount: 0 };
      newNodes.set(key, node);
    }
    return node.name;
  };
  // Seed the resume state (paid batches are NEVER re-sent, T-212 semantics).
  for (const mapping of input.resume?.mappings ?? []) {
    mappingByRowId.set(mapping.rowId, structuredClone(mapping) as AiBacklogMapping);
    if (mapping.parent.kind === 'new') {
      registerNewNode(mapping.parent.name, mapping.parent.parentName ?? null);
    }
  }

  const rowById = new Map(input.rows.map((row) => [row.rowId, row]));
  const pending = input.rows.filter((row) => !mappingByRowId.has(row.rowId));
  const batchSize = input.batchSize ?? AI_BACKLOG_MATCH_BATCH;
  const queue: BacklogRow[][] = [];
  for (let i = 0; i < pending.length; i += batchSize) {
    queue.push(pending.slice(i, i + batchSize));
  }
  const totalBatches = queue.length;
  if (input.resume && pending.length > 0) {
    rt.log(
      'info',
      `Продолжаю разметку: размечено строк ${mappingByRowId.size}, осталось ${pending.length}.`,
    );
  }

  /** Human row reference for log lines: the backlog key when present, else rowId. */
  const rowRef = (row: BacklogRow): string => row.key ?? row.rowId;

  /**
   * One human-readable per-row log line «исходное → преобразованное» (запрос
   * PO по пилоту): source formulation, business name, where the row lands in
   * the tree, the effective target and the duplicate verdict — one line each.
   */
  const describeMapping = (row: BacklogRow, mapping: AiBacklogMapping): string => {
    const typeLabel = mapping.type === 'FUNCTION' ? 'ФТ' : 'НФТ';
    const parent =
      mapping.parent.kind === 'existing'
        ? `узел: «${mapping.parent.name}» (существующий)`
        : mapping.parent.parentName != null
          ? `новый узел: «${mapping.parent.name}» (под «${mapping.parent.parentName}»)`
          : `новый корневой узел: «${mapping.parent.name}»`;
    const target = `срок: ${mapping.targetQuarter} ${mapping.targetYear}${mapping.targetFromFile ? ' (из файла)' : ''}`;
    const duplicate =
      mapping.duplicateOf !== undefined
        ? ` · дубль существующего «${mapping.duplicateOf}» — при записи будет пропущена`
        : '';
    return (
      `Строка ${rowRef(row)}: «${shortenText(row.text)}» → ${typeLabel} «${mapping.businessName}» · ` +
      `${parent} · ${target}${duplicate}`
    );
  };

  /** Accept one validated answer into the mapping (deterministic post-check). */
  const accept = (answer: AiBacklogMatchAnswer): 'accepted' | 'rejected' | 'repeat' => {
    const row = rowById.get(answer.rowId);
    if (!row) return 'rejected';
    // Повторный ответ модели по уже размеченной строке (дважды в одном ответе
    // или в другом батче того же прогона): первый ответ побеждает — молчаливая
    // перезапись выглядела в логе «дублирующей операцией» над строкой.
    if (mappingByRowId.has(answer.rowId)) return 'repeat';
    const businessName = answer.businessName.trim();
    if (businessName.length === 0) return 'rejected';

    let parent: AiBacklogMapping['parent'] | undefined;
    const wantsExisting = answer.parentExisting != null && answer.parentExisting.trim().length > 0;
    if (wantsExisting) {
      const canonical = findExisting(answer.type, answer.parentExisting!.trim());
      if (canonical !== undefined) {
        parent = { kind: 'existing', name: canonical };
      } else {
        // Hallucinated existing parent → a NEW root business node (допущение T-303).
        rt.log(
          'warn',
          `Строка ${rowRef(row)}: узел «${answer.parentExisting!.trim()}» не найден в дереве — будет создан новым корневым узлом.`,
        );
        parent = {
          kind: 'new',
          name: registerNewNode(answer.parentExisting!.trim(), null),
          parentName: null,
        };
      }
    } else if (answer.parentNew != null) {
      const rawParent = answer.parentNew.parentName?.trim() ?? '';
      let nodeParent: string | null = null;
      if (rawParent.length > 0) {
        const canonical =
          findExisting(answer.type, rawParent) ??
          newNodes.get(normalizeRequirementName(rawParent))?.name;
        if (canonical !== undefined) {
          nodeParent = canonical;
        } else {
          rt.log(
            'warn',
            `Строка ${rowRef(row)}: родитель нового узла «${rawParent}» не найден — узел станет корневым.`,
          );
        }
      }
      parent = {
        kind: 'new',
        name: registerNewNode(answer.parentNew.name, nodeParent),
        parentName: newNodes.get(normalizeRequirementName(answer.parentNew.name))!.parentName,
      };
    } else {
      return 'rejected'; // no parent proposed — the row goes back to the queue
    }

    let duplicateOf: string | undefined;
    if (answer.duplicateOf != null && answer.duplicateOf.trim().length > 0) {
      const canonical = findExistingAnyType(answer.duplicateOf.trim());
      if (canonical !== undefined) {
        duplicateOf = canonical;
      } else {
        rt.log(
          'warn',
          `Строка ${rowRef(row)}: дубль «${answer.duplicateOf.trim()}» не найден среди требований — пометка снята.`,
        );
      }
    }

    const mapping: AiBacklogMapping = {
      rowId: row.rowId,
      ...(row.key !== undefined ? { key: row.key } : {}),
      sourceText: row.text,
      businessName: businessName.slice(0, 200),
      type: answer.type,
      parent,
      ...(duplicateOf !== undefined ? { duplicateOf } : {}),
      targetQuarter: row.target?.quarter ?? input.target.quarter,
      targetYear: row.target?.year ?? input.target.year,
      targetFromFile: row.target !== undefined,
    };
    mappingByRowId.set(row.rowId, mapping);
    rt.log('info', describeMapping(row, mapping));
    return 'accepted';
  };

  // Честная нумерация: sentBatches растёт с КАЖДОЙ отправкой. Повторы и
  // дробления получают явную пометку — прежняя метка застревала на
  // «батч N/N+», и в логе пилота повторные отправки выглядели дублирующими
  // операциями над одними и теми же строками.
  let sentBatches = 0;
  while (queue.length > 0) {
    if (rt.cancelled()) return { ok: false };
    const batch = queue.shift()!;
    const batchRowIds = new Set(batch.map((row) => row.rowId));
    sentBatches += 1;
    const label =
      sentBatches <= totalBatches
        ? `Разметка бэклога (батч ${sentBatches}/${totalBatches})`
        : `Разметка бэклога (доп. батч ${sentBatches} — повторная отправка)`;
    rt.log(
      'info',
      `${label}: строк ${batch.length} (${batch
        .slice(0, 8)
        .map((row) => rowRef(row))
        .join(', ')}${batch.length > 8 ? ', …' : ''}) — запрос к модели…`,
    );

    const outcome = await rt.chat<AiBacklogMatchAnswer[]>({
      client: input.client,
      model: input.model,
      preset: input.preset,
      messages: buildBacklogMatchMessages(batch, treeMap),
      negotiator: input.negotiator,
      parse: (content) => parseMatchResponse(content, batchRowIds),
      parseFinal: (content) => parseMatchResponse(content, batchRowIds, 'lenient'),
      attemptWarn: (attempt) =>
        `${label}: ответ модели не распознан (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
      truncatedWarn: () => `${label}: ответ модели обрезан по лимиту токенов.`,
    });
    if (outcome.kind === 'cancelled') return { ok: false };
    if (outcome.kind === 'upstream') {
      if (outcome.errorClass === 'context-length' && batch.length > 1) {
        // The batch does not fit — halve it (adaptive pattern) and retry.
        rt.log('warn', `${label}: батч не помещается в контекст — делю пополам.`);
        queue.unshift(
          batch.slice(0, Math.ceil(batch.length / 2)),
          batch.slice(Math.ceil(batch.length / 2)),
        );
        continue;
      }
      rt.log(
        'error',
        sanitize(`${label}: ошибка обращения к AI Hub: ${outcome.error.message}`, input.apiKey),
      );
      rt.failCode(upstreamCode(outcome.errorClass));
      return { ok: false };
    }

    let accepted = 0;
    let repeats = 0;
    if (outcome.kind === 'ok') {
      for (const answer of outcome.value) {
        const verdict = accept(answer);
        if (verdict === 'accepted') accepted += 1;
        else if (verdict === 'repeat') repeats += 1;
      }
    }
    if (repeats > 0) {
      rt.log(
        'warn',
        `${label}: повторных ответов по уже размеченным строкам: ${repeats} — использован первый ответ, повторы проигнорированы.`,
      );
    }
    const unanswered = batch.filter((row) => !mappingByRowId.has(row.rowId));
    if (unanswered.length > 0) {
      if (accepted === 0 && unanswered.length === 1) {
        rt.failCode('MODEL-01', {
          message: `Модель не смогла разметить строку бэклога ${rowRef(unanswered[0]!)} даже отдельным запросом.`,
        });
        return { ok: false };
      }
      if (accepted === 0) {
        // No progress on the whole batch — halve it (invalid JSON / refusal).
        rt.log('warn', `${label}: батч не размечен — делю пополам и повторяю.`);
        const mid = Math.ceil(unanswered.length / 2);
        queue.unshift(unanswered.slice(0, mid), unanswered.slice(mid));
        continue;
      }
      rt.log(
        'warn',
        `${label}: модель не ответила по строкам: ${unanswered
          .slice(0, 8)
          .map((row) => rowRef(row))
          .join(
            ', ',
          )}${unanswered.length > 8 ? ` и ещё ${unanswered.length - 8}` : ''} — отправлю их повторно.`,
      );
      queue.push(unanswered);
    }

    rt.log('info', `Размечено строк: ${mappingByRowId.size} из ${input.rows.length}.`);
    job.progress = Math.min(
      80,
      10 + Math.round((70 * mappingByRowId.size) / Math.max(1, input.rows.length)),
    );
    // Checkpoint after EVERY batch: paid mappings survive a crash (Н3).
    rt.checkpoint((state) => {
      if (state.backlog) {
        state.backlog.match = { mappings: [...mappingByRowId.values()] };
      }
    });
  }

  // Assemble the review in the sheet order; count rows under every new node.
  const mappings = input.rows
    .map((row) => mappingByRowId.get(row.rowId))
    .filter((m): m is AiBacklogMapping => m !== undefined);
  for (const mapping of mappings) {
    if (mapping.parent.kind !== 'new') continue;
    const node = newNodes.get(normalizeRequirementName(mapping.parent.name));
    if (node) node.rowCount += 1;
  }
  const review: AiBacklogReview = {
    mappings,
    newNodes: [...newNodes.values()].map((n) => ({
      name: n.name,
      parentName: n.parentName,
      rowCount: n.rowCount,
    })),
    duplicates: mappings.filter((m) => m.duplicateOf !== undefined).length,
  };
  job.progress = 80;
  return { ok: true, review };
}
