import path from 'node:path';
import {
  aiExtractedRequirementSchema,
  aiPoAssignmentSchema,
  aiRelatePairSchema,
  aiStructureNodeSchema,
  sanitizeAiName,
  sanitizeAiParentName,
  type AiExtractedRequirement,
  type AiPoAssignment,
  type AiRelatePair,
  type AiStructureNode,
  type RequirementType,
} from '@po/core';
import type { AiChatMessage } from './aiPrompt.js';

/** Position of a chunk inside its file (1-based), for the user message. */
export interface ChunkInfo {
  index: number;
  total: number;
}

/**
 * System prompt (RU) for the extraction call. Encodes the rules of the
 * `project-po-extract` skill: extract ONLY from the given text (golden rule —
 * no invention), every item carries a non-empty `source` (file + section),
 * optional fields only when explicit in the text, `parentName` only when the
 * hierarchy explicitly follows from the document structure, and the answer is
 * STRICTLY a JSON array (no markdown, no preamble; `[]` when nothing found).
 */
const SYSTEM_PROMPT = [
  'Ты — экстрактор требований для портала управления требованиями Product Owner.',
  'Тебе дают фрагмент документации. Вычлени из него функциональные (FUNCTION) и',
  'нефункциональные (NFR) требования.',
  'Золотое правило: используй ТОЛЬКО переданный текст фрагмента, ничего не домысливай.',
  'Никаких «типичных для таких систем» требований, никакого знания о продукте извне.',
  'Каждый пункт обязан иметь непустое поле source: имя файла и раздел/заголовок,',
  'откуда взято требование (например «auth.md § Вход»). Нет источника — нет требования.',
  'Поле description — краткий пересказ формулировки из текста (1–2 предложения),',
  'без добавления фактов, чисел и «и т.п.», которых в тексте не было.',
  'Поля criticality (LOW|MEDIUM|HIGH|CRITICAL|BLOCKER), implemented (true|false),',
  'targetQuarter (Q1|Q2|Q3|Q4) и targetYear указывай ТОЛЬКО если они явно названы в тексте;',
  'иначе опускай их полностью.',
  'Поле parentName указывай ТОЛЬКО если иерархия явно следует из структуры текста',
  '(раздел → подраздел, «модуль X включает Y»); иначе опускай.',
  'Если НФТ явно ограничивает конкретные функциональные требования из ЭТОГО фрагмента или',
  'прямо называет функцию/раздел (например «поиск должен отвечать за 200 мс»), укажи их имена',
  'в поле relatedFunctions (массив имён ФТ ровно в той формулировке, в какой ты их извлёк).',
  'Только явные упоминания в тексте — не выводи связь из общих соображений.',
  'Если явной привязки нет — не добавляй поле вовсе.',
  'Структуру архива (список файлов документации) можно использовать для поля source и для',
  'parentName, когда иерархия следует из директорий (например, файлы одного модуля лежат',
  'в одной поддиректории), но сами требования извлекай ТОЛЬКО из текста фрагмента.',
  'Ответ верни СТРОГО как JSON-массив объектов вида',
  '{"type":"FUNCTION"|"NFR","name":string,"description":string,"source":string,',
  '"criticality"?,"implemented"?,"targetQuarter"?,"targetYear"?,"parentName"?,"relatedFunctions"?}.',
  'Без markdown, без преамбул и пояснений. Если требований во фрагменте нет —',
  'верни пустой массив [].',
].join(' ');

/**
 * Character budget for the archive map included in EVERY extraction call.
 * 1500 chars is a deliberately small, flat add-on: with the production chunk
 * size of 12 000 chars (AI_IMPORT_CHUNK_CHARS) it costs at most ~12% extra
 * tokens per call — cheap enough to always give the model the full-archive
 * context (relative paths → better `source`/`parentName`), while capping the
 * worst case for archives with many files.
 */
export const AI_IMPORT_TREE_CHARS = 1500;

/**
 * Compact archive map: the sorted list of relative doc-file paths, one per
 * line. When the joined list exceeds `maxChars`, it is truncated at a line
 * boundary and terminated with «…и ещё N файлов» so the model still knows the
 * total scope. The tail line is accounted for inside the budget.
 */
export function buildArchiveMap(files: string[], maxChars: number = AI_IMPORT_TREE_CHARS): string {
  const sorted = [...files].sort((a, b) => a.localeCompare(b));
  return truncateLines(sorted, maxChars, (omitted) => `…и ещё ${omitted} файлов`);
}

/**
 * Join `lines` with `\n` under a character budget: when the full text exceeds
 * `maxChars`, cut at a line boundary and terminate with `tailOf(omitted)` so
 * the model still knows the total scope. The tail line is accounted for inside
 * the budget.
 */
function truncateLines(
  lines: string[],
  maxChars: number,
  tailOf: (omitted: number) => string,
): string {
  const full = lines.join('\n');
  if (full.length <= maxChars) return full;

  const kept: string[] = [];
  let length = 0; // length of kept.join('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const candidate = kept.length === 0 ? line.length : length + 1 + line.length;
    const tail = tailOf(lines.length - (i + 1));
    if (candidate + 1 + tail.length > maxChars) break;
    kept.push(line);
    length = candidate;
  }
  const tail = tailOf(lines.length - kept.length);
  return kept.length === 0 ? tail : `${kept.join('\n')}\n${tail}`;
}

/** Directory of a relative file path for the user message («корень архива» at root). */
function dirLabel(fileName: string): string {
  const dir = path.dirname(fileName.split(path.sep).join('/'));
  return dir === '.' ? 'корень архива' : dir;
}

/** Build the two-message conversation for one documentation chunk. */
export function buildExtractionMessages(
  chunk: string,
  fileName: string,
  chunkInfo: ChunkInfo,
  archiveMap: string,
): AiChatMessage[] {
  const user = [
    `Файл: ${fileName} (фрагмент ${chunkInfo.index} из ${chunkInfo.total})`,
    `Директория текущего файла: ${dirLabel(fileName)}`,
    'Структура архива (файлы документации):',
    archiveMap,
    '',
    chunk,
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/**
 * todo_23 · M1: separator line marking one file's start inside a BATCHED
 * fragment (several small files of one source class packed into one call).
 */
export function batchFileSeparator(file: string): string {
  return `=== Файл: ${file} ===`;
}

/**
 * todo_23 · M1: conversation for one batched fragment. The chunk holds several
 * small files of ONE source class, delimited by {@link batchFileSeparator}
 * lines; the model is told to take `source` from the nearest separator above a
 * record, so provenance stays per-file.
 */
export function buildBatchExtractionMessages(
  chunk: string,
  files: string[],
  chunkInfo: ChunkInfo,
  archiveMap: string,
): AiChatMessage[] {
  const user = [
    `Пакет из ${files.length} файлов одного класса (фрагмент ${chunkInfo.index} из ${chunkInfo.total}).`,
    'Границы файлов отмечены строками вида «=== Файл: путь ===».',
    'В поле source каждой записи указывай путь файла из ближайшего разделителя выше записи (и раздел, если он виден).',
    'Структура архива (файлы документации):',
    archiveMap,
    '',
    chunk,
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** One requirement passed into the structure call: type + name + provenance. */
export interface StructureItem {
  type: RequirementType;
  name: string;
  /** Extraction-time provenance «файл § раздел» — the main tree-quality signal (Task 14 B4). */
  source: string;
}

/**
 * Character budget for the full parents list included in EVERY structure batch
 * (Task 14 B3). Without it a batch only sees its own ~50 names, so a parent
 * living in another batch is impossible and the tree fragments. 4000 chars
 * (~1000–2000 tokens) is a flat, affordable add-on per structure call.
 */
export const AI_IMPORT_PARENTS_CHARS = 4000;

/**
 * Compact full list of requirements («допустимые родители») for one structure
 * batch: one `TYPE\tname` line per requirement, FUNCTION lines first, then
 * NFR. Truncated at a line boundary within `maxChars` with a
 * «…и ещё N требований» tail (Task 14 B3).
 */
export function buildParentsList(
  items: StructureItem[],
  maxChars: number = AI_IMPORT_PARENTS_CHARS,
): string {
  const lines = [
    ...items.filter((i) => i.type === 'FUNCTION'),
    ...items.filter((i) => i.type !== 'FUNCTION'),
  ].map((i) => `${i.type}\t${i.name}`);
  return truncateLines(lines, maxChars, (omitted) => `…и ещё ${omitted} требований`);
}

/**
 * System prompt (RU) for the structure (tree-building) call (Task 13 B2,
 * Task 14 B3/B4). Each batch call carries the archive map, the FULL list of
 * requirements (allowed parents) and the batch itself with provenance
 * («файл § раздел»). The model must return exactly one node per BATCH
 * requirement, assembling a tree that mirrors the documentation structure
 * (root section groups with children, reference: the Jenkins sample project).
 * Hierarchy is only allowed within one type — the CHILD_OF rule of the link
 * graph. Roots carry an explicit null.
 */
const STRUCTURE_SYSTEM_PROMPT = [
  'Ты — архитектор дерева требований для портала управления требованиями Product Owner.',
  'Тебе дают структуру архива документации, полный список уже извлечённых требований',
  'и батч требований (тип, имя и источник «файл § раздел»).',
  'Собери древовидную структуру, максимально похожую на структуру документации:',
  'корневые группы-разделы и их дети под ними.',
  'Группируй по файлам и разделам из поля источника: требования одного файла/раздела —',
  'под общим корнем-разделом; структура дерева должна повторять структуру документации.',
  'Иерархия допустима ТОЛЬКО внутри одного типа: FUNCTION под FUNCTION, NFR под NFR.',
  'parentName выбирай из секции «Полный список требований (допустимые родители)»;',
  'узлы верни только для требований из секции «Батч».',
  'Используй ТОЛЬКО переданные имена требований: ничего не выдумывай, не переименовывай,',
  'не добавляй и не удаляй элементы.',
  'Ответ верни СТРОГО как JSON-массив объектов вида',
  '{"type":"FUNCTION"|"NFR","name":string,"parentName":string|null} —',
  'ровно по одному элементу на КАЖДОЕ требование из секции «Батч».',
  'Для корневых элементов parentName обязан быть null; не опускай это поле.',
  'Без markdown, без преамбул и пояснений.',
].join(' ');

/**
 * Build the two-message conversation for one structure batch. `allItems` is
 * the FULL extracted set: every batch sees all allowed parents (Task 14 B3),
 * while nodes are only expected for `items` (the batch itself).
 */
export function buildStructureMessages(
  items: StructureItem[],
  archiveMap: string,
  allItems: StructureItem[],
): AiChatMessage[] {
  const user = [
    'Структура архива (файлы документации):',
    archiveMap,
    '',
    'Полный список требований (допустимые родители):',
    buildParentsList(allItems),
    '',
    `Батч (${items.length} шт., формат: тип, имя и источник через табуляцию):`,
    ...items.map((item) => `${item.type}\t${item.name}\t${item.source}`),
  ].join('\n');
  return [
    { role: 'system', content: STRUCTURE_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/*
 * ── buildTree: логическое дерево «навык AI Product Owner» ──────────────────
 * Два вида вызовов opt-in-этапа poStructure: проектирование таксономии
 * бизнес-доменов (map-reduce по батчам имён — модель каждый раунд видит и
 * расширяет текущую таксономию) и раскладка требований по узлам таксономии
 * (по коротким id «F1.2»). В отличие от легаси-этапа structure, модели
 * РАЗРЕШЕНО придумывать группирующие узлы — портал создаст их как требования.
 */

/**
 * System prompt (RU) таксономического раунда. Персона — опытный PO: группирует
 * по бизнес-смыслу (домены/способности продукта), а не по файлам документации;
 * технические свалки («Прочее», «Разное», «Бэклог») запрещены; 2 уровня.
 * Ответ — ПОЛНАЯ обновлённая таксономия (существующие узлы + новые), формат
 * узла совпадает со structure-этапом: {"type","name","parentName"|null}.
 */
const PO_TAXONOMY_SYSTEM_PROMPT = [
  'Ты — опытный senior Product Owner. Твоя задача — спроектировать логическое дерево',
  'требований продукта: компактную бизнес-таксономию, по которой будут разложены',
  'функциональные (FUNCTION) и нефункциональные (NFR) требования.',
  'Тебе дают текущую таксономию (возможно пустую) и очередной батч имён требований.',
  'Верни ПОЛНУЮ обновлённую таксономию: сохрани существующие узлы (не переименовывай',
  'и не перевешивай их) и добавь новые, только если батч не укладывается в имеющиеся.',
  'Группируй по бизнес-смыслу — домены и способности продукта (например «Управление',
  'доступом», «Отчётность», «Интеграции»), а НЕ по именам файлов или разделов документации.',
  'Запрещены технические и бессодержательные группы: «Прочее», «Разное», «Общее»,',
  '«Бэклог», «Требования», названия файлов.',
  'Ровно два уровня: корневые домены (parentName: null) и их разделы (parentName = имя',
  'корневого домена). Доменов на каждый тип — не больше 12, разделов у домена — не больше 15.',
  'Иерархия только внутри типа: FUNCTION-раздел под FUNCTION-доменом, NFR под NFR.',
  'Для NFR используй качественные категории (производительность, надёжность, безопасность,',
  'совместимость, удобство…), если они соответствуют переданным именам.',
  'Имена узлов — короткие (до 60 символов), деловые, по-русски (или на языке требований).',
  'Ответ верни СТРОГО как JSON-массив объектов вида',
  '{"type":"FUNCTION"|"NFR","name":string,"parentName":string|null}.',
  'Без markdown, без преамбул и пояснений.',
].join(' ');

/** Compact taxonomy rendering shared by both PO calls: `id\tTYPE\tname[\t→ parent]`. */
export function renderTaxonomy(
  nodes: ReadonlyArray<{
    id: string;
    type: RequirementType;
    name: string;
    parentKey: string | null;
  }>,
): string {
  if (nodes.length === 0) return '(таксономия пока пуста)';
  const nameById = new Map(nodes.map((n) => [n.id, n.name]));
  return nodes
    .map((n) => {
      const rootId = n.id.includes('.') ? n.id.slice(0, n.id.indexOf('.')) : null;
      const parent = rootId ? (nameById.get(rootId) ?? '') : '';
      return rootId
        ? `${n.id}\t${n.type}\t${n.name}\t→ ${parent}`
        : `${n.id}\t${n.type}\t${n.name}`;
    })
    .join('\n');
}

/** Build the two-message conversation of one taxonomy-design round. */
export function buildPoTaxonomyMessages(
  taxonomy: ReadonlyArray<{
    id: string;
    type: RequirementType;
    name: string;
    parentKey: string | null;
  }>,
  batch: StructureItem[],
  archiveMap: string,
  round: { index: number; total: number },
): AiChatMessage[] {
  const user = [
    `Раунд проектирования ${round.index} из ${round.total}.`,
    'Структура архива (файлы документации, для контекста):',
    archiveMap,
    '',
    'Текущая таксономия (id, тип, имя, родитель):',
    renderTaxonomy(taxonomy),
    '',
    `Батч имён требований (${batch.length} шт., формат: тип, имя и источник через табуляцию):`,
    ...batch.map((item) => `${item.type}\t${item.name}\t${item.source}`),
  ].join('\n');
  return [
    { role: 'system', content: PO_TAXONOMY_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/**
 * System prompt (RU) вызова раскладки: каждому требованию батча — ровно один
 * узел таксономии по короткому id (или null, если ничего не подходит по
 * смыслу). Модель не создаёт узлы и не меняет имена — только распределяет.
 */
const PO_ASSIGN_SYSTEM_PROMPT = [
  'Ты — опытный senior Product Owner. Тебе дают готовую таксономию требований продукта',
  '(узлы с короткими id вида «F1», «F1.2», «N3») и батч требований (тип, имя, источник).',
  'Для КАЖДОГО требования батча выбери ровно один узел таксономии, к которому оно',
  'относится по бизнес-смыслу, и верни его id в поле node.',
  'Выбирай самый конкретный подходящий узел (раздел, а не домен, когда раздел подходит).',
  'Тип узла обязан совпадать с типом требования: FUNCTION — в F-узлы, NFR — в N-узлы.',
  'Если по смыслу не подходит ни один узел — верни node: null (требование останется корневым);',
  'не подгоняй насильно.',
  'Используй ТОЛЬКО переданные id узлов и имена требований: ничего не выдумывай,',
  'не переименовывай, не добавляй и не удаляй элементы.',
  'Ответ верни СТРОГО как JSON-массив объектов вида',
  '{"type":"FUNCTION"|"NFR","name":string,"node":string|null} —',
  'ровно по одному элементу на каждое требование батча.',
  'Без markdown, без преамбул и пояснений.',
].join(' ');

/** Build the two-message conversation for one assignment batch. */
export function buildPoAssignMessages(
  taxonomy: ReadonlyArray<{
    id: string;
    type: RequirementType;
    name: string;
    parentKey: string | null;
  }>,
  batch: StructureItem[],
): AiChatMessage[] {
  const user = [
    'Таксономия (id, тип, имя, родитель):',
    renderTaxonomy(taxonomy),
    '',
    `Батч требований (${batch.length} шт., формат: тип, имя и источник через табуляцию):`,
    ...batch.map((item) => `${item.type}\t${item.name}\t${item.source}`),
  ].join('\n');
  return [
    { role: 'system', content: PO_ASSIGN_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Outcome of parsing one assignment answer (mirrors {@link ParsedStructure}). */
export interface ParsedPoAssign {
  /** Elements that passed {@link aiPoAssignmentSchema}. */
  assignments: AiPoAssignment[];
  /** Elements dropped by the lenient mode (always 0 in strict mode). */
  droppedInvalid: number;
  /** Total number of elements in the answer array. */
  total: number;
}

/**
 * Parse one assignment answer: locate the JSON array (bare, fenced, embedded,
 * object-root `{"answers":[…]}` or salvaged), then validate every element
 * against {@link aiPoAssignmentSchema}. `strict` (default) invalidates the
 * whole answer on any bad element (retried); `lenient` (last attempt) keeps
 * the valid ones. `null` when no array found.
 */
export function parsePoAssignResponse(
  content: string,
  mode: 'strict' | 'lenient' = 'strict',
): ParsedPoAssign | null {
  const array = extractJsonArray(content);
  if (array === null) return null;
  const assignments: AiPoAssignment[] = [];
  let droppedInvalid = 0;
  for (const element of array) {
    const parsed = aiPoAssignmentSchema.safeParse(element);
    if (parsed.success) {
      assignments.push(parsed.data);
    } else if (mode === 'strict') {
      return null;
    } else {
      droppedInvalid += 1;
    }
  }
  return { assignments, droppedInvalid, total: array.length };
}

/*
 * ── todo_16 B2: relate step («Проставление связей ФТ↔НФТ») ─────────────────
 */

/** One requirement passed into the relate call: id (slug) + name + short description. */
export interface RelateItem {
  slug: string;
  name: string;
  description?: string;
}

/** Character budget for one requirement list (ФТ or НФТ) of the relate call. */
export const AI_IMPORT_RELATE_LIST_CHARS = 6000;

/** Per-item description budget in the relate call (short summary is enough). */
export const AI_IMPORT_RELATE_DESC_CHARS = 160;

/**
 * System prompt (RU) for the relate call (todo_16 B2). The model receives the
 * ALREADY-created requirements of the project (id + name + short description)
 * and returns meaningful NFR↔FUNCTION pairs for RELATES_TO. It must never
 * invent ids or requirements — the server drops everything unknown anyway.
 */
const RELATE_SYSTEM_PROMPT = [
  'Ты — аналитик связей требований для портала управления требованиями Product Owner.',
  'Тебе дают два списка уже созданных требований проекта: функциональные (ФТ) и',
  'нефункциональные (НФТ) — id, имя и краткое описание.',
  'Определи, какие НФТ по смыслу ограничивают или характеризуют какие ФТ,',
  'и верни пары для связи RELATES_TO.',
  'Используй ТОЛЬКО переданные id: не выдумывай новые id, не переименовывай,',
  'не добавляй и не изменяй требования. Пара валидна ТОЛЬКО между НФТ и ФТ.',
  'Связывай при явном или достаточно очевидном смысловом соответствии: не пропускай',
  'явные соответствия, но и не связывай наугад без смысловой связи.',
  'Ответ верни СТРОГО как JSON-массив объектов вида {"nfr":"<id НФТ>","function":"<id ФТ>"}.',
  'Без markdown, без преамбул и пояснений. Если уверенных пар нет — верни пустой массив [].',
].join(' ');

/** One `id\tname\tdescription` line (description single-line, truncated). */
function relateLine(item: RelateItem): string {
  const desc = (item.description ?? '').replace(/\s+/g, ' ').trim();
  const short =
    desc.length > AI_IMPORT_RELATE_DESC_CHARS
      ? `${desc.slice(0, AI_IMPORT_RELATE_DESC_CHARS - 1)}…`
      : desc;
  return `${item.slug}\t${item.name}\t${short}`;
}

/** Compact list of one requirement type for the relate call, under a char budget. */
function buildRelateList(items: RelateItem[], maxChars = AI_IMPORT_RELATE_LIST_CHARS): string {
  return truncateLines(
    items.map(relateLine),
    maxChars,
    (omitted) => `…и ещё ${omitted} требований`,
  );
}

/**
 * Build the two-message conversation for the relate call (todo_16 B2):
 * both lists as `id\tимя\tкраткое описание` lines.
 */
export function buildRelateMessages(functions: RelateItem[], nfrs: RelateItem[]): AiChatMessage[] {
  const user = [
    `Функциональные требования (ФТ), формат: id, имя, краткое описание через табуляцию (${functions.length} шт.):`,
    buildRelateList(functions),
    '',
    `Нефункциональные требования (НФТ), формат: id, имя, краткое описание через табуляцию (${nfrs.length} шт.):`,
    buildRelateList(nfrs),
  ].join('\n');
  return [
    { role: 'system', content: RELATE_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Outcome of parsing one relate answer (mirrors {@link ParsedStructure}). */
export interface ParsedRelate {
  /** Pairs that passed {@link aiRelatePairSchema}. */
  pairs: AiRelatePair[];
  /** Pairs dropped by the lenient mode (always 0 in strict mode). */
  droppedInvalid: number;
  /** Total number of elements in the answer array. */
  total: number;
}

/**
 * Parse one relate answer: locate the JSON array (bare, fenced, embedded or
 * salvaged), then validate every pair against {@link aiRelatePairSchema}.
 * `strict` (default) invalidates the whole answer on any bad pair (retried);
 * `lenient` (last attempt) keeps the valid pairs. `null` when no array found.
 */
export function parseRelateResponse(
  content: string,
  mode: 'strict' | 'lenient' = 'strict',
): ParsedRelate | null {
  const array = extractJsonArray(content);
  if (array === null) return null;
  const pairs: AiRelatePair[] = [];
  let droppedInvalid = 0;
  for (const pair of array) {
    const parsed = aiRelatePairSchema.safeParse(pair);
    if (parsed.success) {
      pairs.push(parsed.data);
    } else if (mode === 'strict') {
      return null;
    } else {
      droppedInvalid += 1;
    }
  }
  return { pairs, droppedInvalid, total: array.length };
}

/** Outcome of parsing one structure answer (Task 14 B7). */
export interface ParsedStructure {
  /** Nodes that passed {@link aiStructureNodeSchema}. */
  nodes: AiStructureNode[];
  /** Nodes dropped by the lenient mode (always 0 in strict mode). */
  droppedInvalid: number;
  /** Total number of elements in the answer array. */
  total: number;
}

/**
 * Parse one structure answer: locate the JSON array (bare, fenced, embedded or
 * salvaged from a truncated answer), then validate every node against
 * {@link aiStructureNodeSchema}.
 *
 * - `strict` (default): any invalid node invalidates the whole answer (`null`)
 *   — it is retried exactly like a non-JSON one (Task 13 B2).
 * - `lenient` (used on the LAST attempt, Task 14 B7): valid nodes are kept,
 *   invalid ones are counted in `droppedInvalid` instead of losing the batch.
 *
 * Returns `null` when no JSON array can be located at all.
 */
export function parseStructureResponse(
  content: string,
  mode: 'strict' | 'lenient' = 'strict',
): ParsedStructure | null {
  const array = extractJsonArray(content);
  if (array === null) return null;
  const nodes: AiStructureNode[] = [];
  let droppedInvalid = 0;
  for (const node of array) {
    const parsed = aiStructureNodeSchema.safeParse(node);
    if (parsed.success) {
      nodes.push(parsed.data);
    } else if (mode === 'strict') {
      return null;
    } else {
      droppedInvalid += 1;
    }
  }
  return { nodes, droppedInvalid, total: array.length };
}

/** Outcome of parsing one model answer. */
export interface ParsedExtraction {
  /** Records that passed {@link aiExtractedRequirementSchema}. */
  items: AiExtractedRequirement[];
  /** Records dropped because `source` was missing/empty (skill golden rule). */
  droppedNoSource: number;
  /** Records dropped for any other schema violation. */
  droppedInvalid: number;
}

/**
 * Try to locate a JSON array in the model answer (bare, fenced, or embedded).
 * As the LAST resort (Task 14 B2) it salvages an array truncated mid-object —
 * e.g. an answer cut by the token limit: text from the first `[` to the last
 * COMPLETE `}` is closed with `]` and parsed, so every fully-written element
 * survives. Returns `null` when nothing parses.
 */
export function extractJsonArray(content: string): unknown[] | null {
  const trimmed = content.trim();
  const candidates: string[] = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = trimmed.indexOf('[');
  const last = trimmed.lastIndexOf(']');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  // Task 14 B2: salvage a truncated array (kept last — only used when the
  // straightforward candidates fail).
  const lastBrace = trimmed.lastIndexOf('}');
  if (first >= 0 && lastBrace > first) {
    candidates.push(`${trimmed.slice(first, lastBrace + 1)}]`);
  }
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (Array.isArray(value)) return value;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Parse one model answer: locate the JSON array (including inside a ```json
 * fence), then safeParse every record. Returns `null` when no array can be
 * found at all (a chunk-level failure the caller logs as a warning).
 */
export function parseExtractionResponse(content: string): ParsedExtraction | null {
  const array = extractJsonArray(content);
  if (array === null) return null;

  const result: ParsedExtraction = { items: [], droppedNoSource: 0, droppedInvalid: 0 };
  for (const record of array) {
    const parsed = aiExtractedRequirementSchema.safeParse(record);
    if (parsed.success) {
      // Zod пропускает строковый «null» и имя с приклеенным хвостом ответа
      // модели — это непустые строки. Чистим детерминированно; запись без
      // осмысленного имени отбраковываем, а не создаём требование «null».
      const name = sanitizeAiName(parsed.data.name);
      if (name === null) {
        result.droppedInvalid += 1;
        continue;
      }
      const parentName = sanitizeAiParentName(parsed.data.parentName);
      result.items.push({
        ...parsed.data,
        name,
        ...(parentName === null ? { parentName: undefined } : { parentName }),
      });
      continue;
    }
    const isObject = typeof record === 'object' && record !== null;
    const source = isObject ? (record as { source?: unknown }).source : undefined;
    if (isObject && (typeof source !== 'string' || source.trim().length === 0)) {
      result.droppedNoSource += 1;
    } else {
      result.droppedInvalid += 1;
    }
  }
  return result;
}

/**
 * Split a document into chunks of at most `maxChars` characters, cutting at
 * line boundaries (a single overlong line is hard-split). Joining the chunks
 * back with `\n` restores the original text, so nothing is lost or duplicated.
 */
export function chunkText(text: string, maxChars: number): string[] {
  if (text.trim().length === 0) return [];
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let current = '';
  const push = (): void => {
    chunks.push(current);
    current = '';
  };

  for (const line of text.split('\n')) {
    if (line.length > maxChars) {
      // Flush what we have, then hard-split the overlong line.
      if (current.length > 0) push();
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(line.slice(i, i + maxChars));
      }
      continue;
    }
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length > maxChars) {
      push();
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) push();
  return chunks;
}
