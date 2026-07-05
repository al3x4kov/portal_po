import path from 'node:path';
import {
  aiExtractedRequirementSchema,
  aiStructureNodeSchema,
  type AiExtractedRequirement,
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
  'Структуру архива (список файлов документации) можно использовать для поля source и для',
  'parentName, когда иерархия следует из директорий (например, файлы одного модуля лежат',
  'в одной поддиректории), но сами требования извлекай ТОЛЬКО из текста фрагмента.',
  'Ответ верни СТРОГО как JSON-массив объектов вида',
  '{"type":"FUNCTION"|"NFR","name":string,"description":string,"source":string,',
  '"criticality"?,"implemented"?,"targetQuarter"?,"targetYear"?,"parentName"?}.',
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
  const full = sorted.join('\n');
  if (full.length <= maxChars) return full;

  const kept: string[] = [];
  let length = 0; // length of kept.join('\n')
  for (let i = 0; i < sorted.length; i++) {
    const line = sorted[i]!;
    const candidate = kept.length === 0 ? line.length : length + 1 + line.length;
    const tail = `…и ещё ${sorted.length - (i + 1)} файлов`;
    if (candidate + 1 + tail.length > maxChars) break;
    kept.push(line);
    length = candidate;
  }
  const tail = `…и ещё ${sorted.length - kept.length} файлов`;
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

/** One requirement passed into the structure call: type + name only. */
export interface StructureItem {
  type: RequirementType;
  name: string;
}

/**
 * System prompt (RU) for the structure (tree-building) call (Task 13 B2).
 * The model sees the FULL list of extracted requirements plus the archive map
 * and must return exactly one node per requirement, assembling a tree that
 * mirrors the documentation structure (root section groups with children,
 * reference: the Jenkins sample project). Hierarchy is only allowed within one
 * type — the CHILD_OF rule of the link graph. Roots carry an explicit null.
 */
const STRUCTURE_SYSTEM_PROMPT = [
  'Ты — архитектор дерева требований для портала управления требованиями Product Owner.',
  'Тебе дают полный список уже извлечённых требований (тип и имя) и структуру архива',
  'документации. Собери из них древовидную структуру, максимально похожую на структуру',
  'документации: корневые группы-разделы и их дети под ними (например, требования одного',
  'раздела или файла — под общим корневым требованием-разделом).',
  'Иерархия допустима ТОЛЬКО внутри одного типа: FUNCTION под FUNCTION, NFR под NFR.',
  'Используй ТОЛЬКО переданные имена требований: ничего не выдумывай, не переименовывай,',
  'не добавляй и не удаляй элементы.',
  'Ответ верни СТРОГО как JSON-массив объектов вида',
  '{"type":"FUNCTION"|"NFR","name":string,"parentName":string|null} —',
  'ровно по одному элементу на КАЖДОЕ переданное требование.',
  'Для корневых элементов parentName обязан быть null; не опускай это поле.',
  'Без markdown, без преамбул и пояснений.',
].join(' ');

/** Build the two-message conversation for one structure batch. */
export function buildStructureMessages(
  items: StructureItem[],
  archiveMap: string,
): AiChatMessage[] {
  const user = [
    'Структура архива (файлы документации):',
    archiveMap,
    '',
    `Требования (${items.length} шт., формат: тип и имя через табуляцию):`,
    ...items.map((item) => `${item.type}\t${item.name}`),
  ].join('\n');
  return [
    { role: 'system', content: STRUCTURE_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/**
 * Parse one structure answer: locate the JSON array (bare, fenced or
 * embedded), then validate EVERY node against {@link aiStructureNodeSchema}.
 * Returns `null` when no array is found OR any node is invalid — an invalid
 * answer is retried as a whole, exactly like a non-JSON one (Task 13 B2).
 */
export function parseStructureResponse(content: string): AiStructureNode[] | null {
  const array = extractJsonArray(content);
  if (array === null) return null;
  const nodes: AiStructureNode[] = [];
  for (const node of array) {
    const parsed = aiStructureNodeSchema.safeParse(node);
    if (!parsed.success) return null;
    nodes.push(parsed.data);
  }
  return nodes;
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

/** Try to locate a JSON array in the model answer (bare, fenced, or embedded). */
function extractJsonArray(content: string): unknown[] | null {
  const trimmed = content.trim();
  const candidates: string[] = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = trimmed.indexOf('[');
  const last = trimmed.lastIndexOf(']');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
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
      result.items.push(parsed.data);
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
