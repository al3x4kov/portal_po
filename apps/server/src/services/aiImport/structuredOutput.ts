import type { AiImportSourceClass } from '@po/core';
import type { AiChatMessage } from '../aiPrompt.js';

/**
 * todo_20 · T-206: structured output with graceful fallback (spec П3.2, Н5).
 *
 * The first call of a run asks for `response_format: json_schema` (a FLAT
 * analyze record — hierarchy is built by the existing structure stage). A
 * backend that rejects the parameter (vLLM/Ollama/proxies differ) downgrades
 * the mode `json_schema → json_object → none`; the decision is remembered for
 * the WHOLE run, so a non-supporting backend pays exactly 1–2 extra calls and
 * then works exactly like today («текст + парсер», приёмка №6).
 */

export type ResponseFormatMode = 'json_schema' | 'json_object' | 'none';

const FORMAT_REJECTION_RE = /response_format|json_schema|json_object|structured.?output/i;

/** True when the upstream 4xx complains about the response_format parameter. */
export function isResponseFormatRejection(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number' && (status === 429 || status >= 500)) return false;
  const message = err instanceof Error ? err.message : String(err);
  return FORMAT_REJECTION_RE.test(message);
}

/**
 * The FLAT analyze answer schema (B3): one record = {type,name,description,
 * source}. `source` stays mandatory — no provenance, no requirement (golden
 * rule). Optional enrichments (criticality, parentName…) are deliberately NOT
 * in the structured schema: weak models fill them badly, and the lenient text
 * parser still accepts them when a strong model volunteers them.
 */
export function buildAnalyzeResponseFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'extracted_requirements',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'name', 'description', 'source'],
              properties: {
                type: { type: 'string', enum: ['FUNCTION', 'NFR'] },
                name: { type: 'string' },
                description: { type: 'string' },
                source: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * Backlog-match answer schema (todo_22 hotfix). MUST mirror the strict parser
 * contract `aiBacklogMatchAnswerSchema` — a model honouring json_schema
 * returns exactly what `parseMatchResponse` accepts. Before this builder the
 * match calls went out with the ANALYZE schema (items without rowId), so a
 * schema-honouring backend produced 100% unparseable answers → MODEL-01.
 * Root is an object (`{"answers":[...]}`) — strict json_schema requires an
 * object root; `extractJsonArray` unwraps the inner array. strict:true keeps
 * every key in `required`, optionality is expressed with nullable types.
 */
export function buildBacklogMatchResponseFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'backlog_match_answers',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['answers'],
        properties: {
          answers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'rowId',
                'businessName',
                'type',
                'parentExisting',
                'parentNew',
                'duplicateOf',
              ],
              properties: {
                rowId: { type: 'string' },
                businessName: { type: 'string' },
                type: { type: 'string', enum: ['FUNCTION', 'NFR'] },
                parentExisting: { type: ['string', 'null'] },
                parentNew: {
                  anyOf: [
                    {
                      type: 'object',
                      additionalProperties: false,
                      required: ['name', 'parentName'],
                      properties: {
                        name: { type: 'string' },
                        parentName: { type: ['string', 'null'] },
                      },
                    },
                    { type: 'null' },
                  ],
                },
                duplicateOf: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  };
}

/** Builds the `response_format` payload for the `json_schema` mode. */
export type ResponseFormatBuilder = () => Record<string, unknown>;

/**
 * Per-run negotiation state. `responseFormat()` yields the parameter for the
 * next call (undefined in `none` mode); `noteRejected()` downgrades one step
 * when the error is ABOUT the parameter and returns whether a downgrade
 * happened (the caller then repeats the call immediately, without burning a
 * retry attempt). The schema is stage-specific: analyze (default) and
 * backlog-match negotiators carry DIFFERENT builders — the schema must always
 * match the parser of the stage that owns the call.
 */
export class ResponseFormatNegotiator {
  mode: ResponseFormatMode = 'json_schema';

  constructor(private readonly buildFormat: ResponseFormatBuilder = buildAnalyzeResponseFormat) {}

  responseFormat(): Record<string, unknown> | undefined {
    if (this.mode === 'json_schema') return this.buildFormat();
    if (this.mode === 'json_object') return { type: 'json_object' };
    return undefined;
  }

  noteRejected(err: unknown): boolean {
    if (this.mode === 'none') return false;
    if (!isResponseFormatRejection(err)) return false;
    this.mode = this.mode === 'json_schema' ? 'json_object' : 'none';
    return true;
  }
}

/*
 * ── Few-shot примеры по классам источников (B3) ────────────────────────────
 * 1 пара (user → assistant) на класс: короткий фрагмент + СТРОГО валидный
 * JSON-ответ в формате текущего парсера, чтобы слабая модель увидела ровно
 * тот ответ, который от неё ждут. Примеры компактные — плоский добавок к
 * каждому вызову должен оставаться дешёвым.
 */

const FEW_SHOT: Record<AiImportSourceClass, Array<[string, string]>> = {
  'release-notes': [
    [
      'Файл: notes.md (пример)\nЧто нового в 2.1:\n- Быстрый фильтр по статусу — список фильтруется на лету.',
      JSON.stringify([
        {
          type: 'FUNCTION',
          name: 'Быстрый фильтр по статусу',
          description: 'Список фильтруется на лету по статусу.',
          source: 'notes.md § Что нового в 2.1',
        },
      ]),
    ],
  ],
  'user-guide': [
    [
      'Файл: guide.md (пример)\n## Поиск\nПользователь может искать записи по имени через строку поиска.',
      JSON.stringify([
        {
          type: 'FUNCTION',
          name: 'Поиск записей по имени',
          description: 'Поиск записей по имени через строку поиска.',
          source: 'guide.md § Поиск',
        },
      ]),
    ],
  ],
  'admin-guide': [
    [
      'Файл: admin.md (пример)\n## Резервное копирование\nАдминистратор настраивает ежедневное резервное копирование данных.',
      JSON.stringify([
        {
          type: 'FUNCTION',
          name: 'Настройка ежедневного резервного копирования',
          description: 'Администратор настраивает ежедневное резервное копирование данных.',
          source: 'admin.md § Резервное копирование',
        },
      ]),
    ],
  ],
  security: [
    [
      'Файл: security.md (пример)\nПароли хранятся только в виде хэша bcrypt.',
      JSON.stringify([
        {
          type: 'NFR',
          name: 'Хранение паролей в виде хэша',
          description: 'Пароли хранятся только в виде хэша bcrypt.',
          source: 'security.md § Пароли',
        },
      ]),
    ],
  ],
  'api-spec': [
    [
      'Файл: api.md (пример)\nGET /items — возвращает список элементов с пагинацией.',
      JSON.stringify([
        {
          type: 'FUNCTION',
          name: 'Получение списка элементов через API',
          description: 'GET /items возвращает список элементов с пагинацией.',
          source: 'api.md § GET /items',
        },
      ]),
    ],
  ],
  config: [
    [
      'Файл: config.md (пример)\nsession_timeout: 30 — сессия завершается после 30 минут неактивности.',
      JSON.stringify([
        {
          type: 'NFR',
          name: 'Тайм-аут сессии',
          description: 'Сессия завершается после 30 минут неактивности.',
          source: 'config.md § session_timeout',
        },
      ]),
    ],
  ],
  other: [
    [
      'Файл: doc.md (пример)\nСистема отправляет уведомление на почту при изменении записи.',
      JSON.stringify([
        {
          type: 'FUNCTION',
          name: 'Уведомление на почту при изменении записи',
          description: 'Система отправляет уведомление на почту при изменении записи.',
          source: 'doc.md § Уведомления',
        },
      ]),
    ],
  ],
};

/** Few-shot pairs (user, assistant) for one source class. */
export function fewShotForClass(cls: AiImportSourceClass): AiChatMessage[] {
  return FEW_SHOT[cls].flatMap(([user, assistant]) => [
    { role: 'user' as const, content: user },
    { role: 'assistant' as const, content: assistant },
  ]);
}
