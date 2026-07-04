import { aiExtractedRequirementSchema, type AiExtractedRequirement } from '@po/core';
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
  'Ответ верни СТРОГО как JSON-массив объектов вида',
  '{"type":"FUNCTION"|"NFR","name":string,"description":string,"source":string,',
  '"criticality"?,"implemented"?,"targetQuarter"?,"targetYear"?,"parentName"?}.',
  'Без markdown, без преамбул и пояснений. Если требований во фрагменте нет —',
  'верни пустой массив [].',
].join(' ');

/** Build the two-message conversation for one documentation chunk. */
export function buildExtractionMessages(
  chunk: string,
  fileName: string,
  chunkInfo: ChunkInfo,
): AiChatMessage[] {
  const user = [
    `Файл: ${fileName} (фрагмент ${chunkInfo.index} из ${chunkInfo.total})`,
    '',
    chunk,
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
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
