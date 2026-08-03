import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  AI_IMPORT_SOURCE_CLASSES,
  type AiImportExcludedEntry,
  type AiImportInventoryView,
  type AiImportSourceClass,
  type AiModelPreset,
} from '@po/core';
import type { AiClientFactory } from '../AiHubService.js';
import { extractJsonArray } from '../aiImportPrompt.js';
import type { AiChatMessage } from '../aiPrompt.js';
import type { AiImportRuntime } from './types.js';

/**
 * todo_20 · T-202: стадия «inventory» — контентный триаж (spec П1, A1/A3).
 *
 * Every documentation file is classified by its CONTENT (head sniffing —
 * file/dir names are never a signal): cheap heuristics first, then ONE batched
 * LLM call for the substantial-but-unrecognised files (≤30 файлов/вызов), and
 * `other` as the final fallback — an `other` file is still processed with base
 * priority, never dropped. Binary heads are excluded WITH a reason; nothing is
 * excluded silently. The output queue is ordered by class priority so the most
 * valuable sources (release notes, api) are extracted first (A3).
 *
 * Streaming (Н1): only a bounded HEAD of each file is read here (the analyze
 * stage later reads each file once, one at a time) — the archive is never
 * loaded into memory wholesale.
 */

/** Head bytes read for sniffing/classification. */
export const AI_INVENTORY_HEAD_BYTES = 64 * 1024;
/** Files with a smaller head are classified `other` without an LLM call. */
export const AI_INVENTORY_LLM_MIN_CHARS = 400;
/** Max files per one LLM classification call (spec П1.2). */
export const AI_INVENTORY_LLM_BATCH = 30;
/** First lines of a file handed to the LLM classifier. */
export const AI_INVENTORY_LLM_HEAD_LINES = 30;

/** Processing priority per class (lower = earlier; A3). */
const CLASS_PRIORITY: Record<AiImportSourceClass, number> = {
  'release-notes': 0,
  'api-spec': 1,
  'user-guide': 2,
  'admin-guide': 3,
  security: 4,
  config: 5,
  other: 6,
};

/** One file queued for extraction. */
export interface InventoryFileEntry {
  /** Relative archive path. */
  path: string;
  sourceClass: AiImportSourceClass;
  /** File size, bytes (drives the estimate). */
  size: number;
}

export interface InventoryInput {
  docsDir: string;
  /** Relative doc-file paths from the unpack stage. */
  files: string[];
  /** Total file entries of the archive (for the inventory view). */
  totalEntries: number;
  /** Extension → count over ALL extracted files (excluded reporting). */
  extensionCounts: Record<string, number>;
  model: string;
  apiKey: string;
  baseURL: string;
  preset: AiModelPreset;
  makeAiClient: AiClientFactory;
}

export type InventoryOutcome =
  { ok: true; files: InventoryFileEntry[]; inventory: AiImportInventoryView } | { ok: false };

/* ── Контентные эвристики (RU/EN, любой регистр) ─────────────────────────── */

const RE_RELEASE =
  /(what'?s new|release ?notes?|changelog|что нового|история изменений|список изменений|^#{0,3}\s*версия \d|\bversion \d+\.\d+.{0,20}(released|выпущен))/im;
const RE_USER_GUIDE =
  /(user ?guide|user ?manual|руководство пользователя|инструкция пользователя|how ?to|как (выполнить|настроить|создать))/im;
const RE_ADMIN_GUIDE =
  /(admin(istrator|istration)? ?guide|руководство администратора|installation|deployment|установка (сервера|системы)|развёртывание|развертывание)/im;
const RE_SECURITY =
  /(security|безопасност|уязвим|vulnerab|cve-\d{4}|аутентификац.{0,40}политик|шифрован)/im;
const RE_API =
  /(openapi|swagger|api ?(reference|specification|спецификаци)|^paths:|endpoint|\b(GET|POST|PUT|DELETE|PATCH)\s+\/\w*)/im;
const RE_CONFIG =
  /(configuration ?(file|reference)|конфигурационн|параметры конфигурации|настройки по умолчанию|^\s*\[\w+\]\s*$[\s\S]*^\s*\w+\s*=)/im;

/**
 * Cheap content classification. Returns `null` when nothing matched — the
 * caller may then try the LLM batch or fall back to `other`.
 */
export function classifyHeuristically(head: string): AiImportSourceClass | null {
  if (RE_RELEASE.test(head)) return 'release-notes';
  if (RE_API.test(head)) return 'api-spec';
  if (RE_ADMIN_GUIDE.test(head)) return 'admin-guide';
  if (RE_USER_GUIDE.test(head)) return 'user-guide';
  if (RE_SECURITY.test(head)) return 'security';
  if (RE_CONFIG.test(head)) return 'config';
  return null;
}

/** True when the head looks binary (NUL bytes — never a text document). */
function isBinaryHead(head: Buffer): boolean {
  return head.includes(0);
}

/** Read a bounded head of one file (single bounded read — Н1). */
async function readHead(abs: string): Promise<Buffer> {
  const handle = await fs.open(abs, 'r');
  try {
    const buf = Buffer.alloc(AI_INVENTORY_HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const llmAnswerSchema = z.array(
  z.object({ path: z.string().min(1), class: z.enum(AI_IMPORT_SOURCE_CLASSES) }),
);

const CLASSIFY_SYSTEM_PROMPT = [
  'Ты — классификатор документации. Тебе дают список файлов с первыми строками содержимого.',
  'Определи класс КАЖДОГО файла ТОЛЬКО по содержимому (имена файлов — слабый сигнал):',
  `один из: ${AI_IMPORT_SOURCE_CLASSES.join(', ')}.`,
  'Ответ верни СТРОГО как JSON-массив объектов {"path":string,"class":string} —',
  'ровно по одному элементу на каждый файл из списка. Без markdown и пояснений.',
].join(' ');

function buildClassifyMessages(batch: Array<{ path: string; head: string }>): AiChatMessage[] {
  const user = batch
    .map((f, i) => {
      const lines = f.head.split('\n').slice(0, AI_INVENTORY_LLM_HEAD_LINES).join('\n');
      return `### Файл ${i + 1}: ${f.path}\n${lines}`;
    })
    .join('\n\n');
  return [
    { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Human label of an excluded non-text extension. */
function extensionPattern(ext: string): string {
  return ext === '' ? '(без расширения)' : `*${ext}`;
}

/**
 * Stage «inventory» (progress 5–8, job stage stays `unpack` in the enum — the
 * visibility contract mirrors the relate step: the outcome lives in
 * `job.inventory`). Never fails the job: classification degradation always
 * ends in `other` with a warn.
 */
export async function runInventoryStage(
  rt: AiImportRuntime,
  input: InventoryInput,
): Promise<InventoryOutcome> {
  rt.log('info', 'Опись документации: определение классов источников по содержимому…');

  const entries: InventoryFileEntry[] = [];
  const heads = new Map<string, string>();
  const excludedBinary: AiImportExcludedEntry[] = [];
  const unresolved: string[] = [];

  for (const rel of input.files) {
    if (rt.cancelled()) return { ok: false };
    const abs = path.join(input.docsDir, rel);
    const stat = await fs.stat(abs);
    const head = await readHead(abs);
    if (isBinaryHead(head)) {
      excludedBinary.push({
        path: rel,
        reason: 'бинарное содержимое (не текстовый документ)',
        count: 1,
      });
      continue;
    }
    const headText = head.toString('utf8');
    heads.set(rel, headText);
    const cls = classifyHeuristically(headText);
    if (cls) {
      entries.push({ path: rel, sourceClass: cls, size: stat.size });
    } else {
      unresolved.push(rel);
      entries.push({ path: rel, sourceClass: 'other', size: stat.size });
    }
  }

  // Batched LLM classification for substantial unrecognised files (П1.2).
  const candidates = unresolved.filter(
    (rel) => (heads.get(rel) ?? '').length >= AI_INVENTORY_LLM_MIN_CHARS,
  );
  if (candidates.length > 0) {
    const client = input.makeAiClient(input.apiKey, input.baseURL);
    const byPath = new Map(entries.map((e) => [e.path, e]));
    for (let i = 0; i < candidates.length; i += AI_INVENTORY_LLM_BATCH) {
      const batch = candidates
        .slice(i, i + AI_INVENTORY_LLM_BATCH)
        .map((rel) => ({ path: rel, head: heads.get(rel) ?? '' }));
      const outcome = await rt.chat<Array<{ path: string; class: AiImportSourceClass }>>({
        client,
        model: input.model,
        preset: input.preset,
        messages: buildClassifyMessages(batch),
        parse: (content) => {
          const array = extractJsonArray(content);
          if (array === null) return null;
          const valid = array.filter((x) => llmAnswerSchema.element.safeParse(x).success);
          return valid.length > 0 ? llmAnswerSchema.parse(valid) : null;
        },
        attemptWarn: (attempt) =>
          `Классификация файлов: ответ модели не распознан (попытка ${attempt}).`,
        truncatedWarn: () => 'Классификация файлов: ответ модели обрезан по лимиту токенов.',
      });
      if (outcome.kind === 'cancelled') return { ok: false };
      if (outcome.kind === 'ok') {
        for (const { path: rel, class: cls } of outcome.value) {
          const entry = byPath.get(rel);
          if (entry) entry.sourceClass = cls;
        }
      } else {
        // Degradation (П1.2в): the model is unavailable/unparsable — every
        // unrecognised file stays `other` and the run continues.
        rt.log(
          'warn',
          'LLM-классификация недоступна — неопознанные файлы обрабатываются с классом «other».',
        );
        break;
      }
    }
  }

  // Priority queue: the most valuable classes first (A3); stable by path.
  entries.sort(
    (a, b) =>
      CLASS_PRIORITY[a.sourceClass] - CLASS_PRIORITY[b.sourceClass] || a.path.localeCompare(b.path),
  );

  // Aggregated exclusions: binary heads + non-text archive entries.
  const excluded: AiImportExcludedEntry[] = [...excludedBinary];
  const textCount = input.files.length;
  const nonTextTotal = Math.max(0, input.totalEntries - textCount);
  if (nonTextTotal > 0) {
    const docExts = new Set(input.files.map((f) => path.extname(f).toLowerCase()));
    for (const [ext, count] of Object.entries(input.extensionCounts).sort()) {
      if (docExts.has(ext)) continue;
      excluded.push({
        path: extensionPattern(ext),
        reason: 'не текстовый формат документации',
        count,
      });
    }
  }

  const processed: Partial<Record<AiImportSourceClass, number>> = {};
  for (const entry of entries) {
    processed[entry.sourceClass] = (processed[entry.sourceClass] ?? 0) + 1;
  }
  const inventory: AiImportInventoryView = {
    totalFiles: input.totalEntries,
    processed,
    excluded,
  };
  rt.job.inventory = inventory;

  const classSummary = Object.entries(processed)
    .map(([cls, count]) => `${cls} — ${count}`)
    .join(', ');
  rt.log(
    'info',
    `Опись готова: к обработке ${entries.length} файлов (${classSummary}); исключено: ${excluded.reduce((n, e) => n + e.count, 0)}.`,
  );
  rt.job.progress = Math.max(rt.job.progress, 8);
  return { ok: true, files: entries, inventory };
}
