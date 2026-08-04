import type { OpenAPIV3 } from 'openapi-types';
import { z } from 'zod';
import {
  aiBacklogApplyBodySchema,
  aiChatRequestSchema,
  aiChatResponseSchema,
  aiConfigUpdateSchema,
  aiConfigViewSchema,
  aiImportConfirmBodySchema,
  aiImportJobListSchema,
  aiImportJobViewSchema,
  aiImportStartResponseSchema,
  aiModelsViewSchema,
  generateDescriptionRequestSchema,
  generateDescriptionResponseSchema,
  linkSchema,
  requirementSchema,
} from '@po/core';
import { createBody, updateBody } from '../routes/requirements.js';
import { linkBody } from '../routes/links.js';

/**
 * OpenAPI 3.0 document for the REST API (E14). Component schemas are derived
 * from the very same zod schemas the routes validate against (`z.toJSONSchema`),
 * so the documentation cannot drift from the real contract. The document is
 * served verbatim by `@fastify/swagger` in `static` mode, which keeps route
 * behaviour (manual `parseInput` validation, response serialization) untouched.
 */

/** Convert a zod schema to an OpenAPI-3.0-compatible JSON schema object. */
function toSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'openapi-3.0' }) as Record<string, unknown>;
}

/** `#/components/schemas/<name>` reference. */
function ref(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

const ID_DESC =
  'Идентификатор проекта — имя каталога проекта в `Projects/`. ' +
  'Список доступных значений возвращает `GET /api/projects` (поле `id`).';

const SLUG_DESC =
  'Стабильный, человекочитаемый идентификатор требования (kebab-case, `[a-z0-9-]`). ' +
  'Уникален в пределах проекта, неизменяем после создания — переименование `name` его не ' +
  'меняет (см. ADR-001). Используется как имя файла и цель связей.';

/** Path parameter object for `:id`. */
const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  description: ID_DESC,
  schema: { type: 'string' },
} as const;

/** Path parameter object for `:slug`. */
const slugParam = {
  name: 'slug',
  in: 'path',
  required: true,
  description: SLUG_DESC,
  schema: { type: 'string' },
} as const;

/** Path parameter object for the AI-import `:jobId`. */
const jobIdParam = {
  name: 'jobId',
  in: 'path',
  required: true,
  description:
    'Идентификатор задания AI-импорта, возвращённый `POST /api/projects/{id}/ai-import` (202). ' +
    'Состояние задания сохраняется в контрольных точках (`Projects/<project>/.ai-jobs/`): ' +
    'после рестарта сервера незавершённое задание видно как `interrupted` и может быть продолжено.',
  schema: { type: 'string' },
} as const;

const jsonBody = (schemaName: string, required = true): Record<string, unknown> => ({
  required,
  content: { 'application/json': { schema: ref(schemaName) } },
});

const jsonResponse = (description: string, schemaName?: string): Record<string, unknown> => ({
  description,
  ...(schemaName ? { content: { 'application/json': { schema: ref(schemaName) } } } : {}),
});

const errorResponse = (description: string): Record<string, unknown> =>
  jsonResponse(description, 'Error');

/** Build the full OpenAPI document. */
export function buildOpenApiDocument(): OpenAPIV3.Document {
  const schemas: Record<string, unknown> = {
    Requirement: toSchema(requirementSchema),
    Link: toSchema(linkSchema),
    CreateRequirement: toSchema(createBody),
    UpdateRequirement: toSchema(updateBody),
    CreateLink: toSchema(linkBody),
    Project: {
      type: 'object',
      description: 'Сводка по проекту (каталог в `Projects/`).',
      required: ['id', 'name', 'mainPath', 'createdAt'],
      properties: {
        id: { type: 'string', description: 'Идентификатор проекта (имя каталога).' },
        name: { type: 'string', description: 'Отображаемое имя проекта.' },
        mainPath: { type: 'string', description: 'Абсолютный путь каталога проекта на диске.' },
        createdAt: { type: 'string', description: 'Метка времени создания (ISO-8601).' },
      },
    },
    CheckNameResult: {
      type: 'object',
      required: ['available', 'slug'],
      properties: {
        available: { type: 'boolean', description: 'Свободно ли имя в проекте.' },
        slug: {
          type: 'string',
          description: 'Slug, который получило бы требование с этим именем.',
        },
      },
    },
    // AI Hub (Task 8–11): schemas derived from the same @po/core zod contracts
    // the /api/ai/* routes validate against. AiConfigView deliberately omits the
    // API key — only `hasApiKey` is exposed (security invariant).
    AiConfigView: toSchema(aiConfigViewSchema),
    AiConfigUpdate: toSchema(aiConfigUpdateSchema),
    // todo_22: backlog-import bodies (the job view/list already carry the
    // backlog fields — they are derived from the same extended zod schemas).
    AiImportConfirmBody: toSchema(aiImportConfirmBodySchema),
    AiBacklogApplyBody: toSchema(aiBacklogApplyBodySchema),
    AiModelsView: toSchema(aiModelsViewSchema),
    AiChatRequest: toSchema(aiChatRequestSchema),
    AiChatResponse: toSchema(aiChatResponseSchema),
    GenerateDescriptionRequest: toSchema(generateDescriptionRequestSchema),
    GenerateDescriptionResponse: toSchema(generateDescriptionResponseSchema),
    AiImportJobView: toSchema(aiImportJobViewSchema),
    AiImportStartResponse: toSchema(aiImportStartResponseSchema),
    // todo_20: история прогонов проекта (решение PO №4).
    AiImportJobList: toSchema(aiImportJobListSchema),
    Error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          description: 'Машиночитаемый код доменной ошибки (например NOT_FOUND, CONFLICT, CYCLE).',
        },
        message: { type: 'string', description: 'Человекочитаемое описание ошибки.' },
        details: {
          description: 'Дополнительные структурированные данные (например путь цикла).',
          nullable: true,
        },
      },
    },
  };

  const paths: Record<string, unknown> = {
    '/api/projects': {
      get: {
        tags: ['projects'],
        summary: 'Список проектов',
        responses: {
          200: {
            description: 'Массив сводок по проектам.',
            content: {
              'application/json': {
                schema: { type: 'array', items: ref('Project') },
              },
            },
          },
        },
      },
      post: {
        tags: ['projects'],
        summary: 'Создать проект',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
              },
            },
          },
        },
        responses: {
          201: jsonResponse('Проект создан.', 'Project'),
          409: errorResponse('Проект с таким именем уже существует.'),
          422: errorResponse('Некорректное имя проекта.'),
        },
      },
    },
    '/api/projects/{id}': {
      get: {
        tags: ['projects'],
        summary: 'Получить проект',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Сводка по проекту.', 'Project'),
          404: errorResponse('Проект не найден.'),
        },
      },
      delete: {
        tags: ['projects'],
        summary: 'Удалить проект (каталог со всеми файлами)',
        parameters: [idParam],
        responses: {
          204: { description: 'Проект удалён.' },
          400: errorResponse('Некорректный id (например попытка path traversal).'),
          404: errorResponse('Проект не найден.'),
        },
      },
    },
    '/api/projects/import': {
      post: {
        tags: ['projects'],
        summary: 'Импортировать проект из архива',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['name', 'file'],
                properties: {
                  name: { type: 'string', description: 'Имя нового проекта.' },
                  file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Архив проекта (.zip или .tar.gz).',
                  },
                },
              },
            },
          },
        },
        responses: {
          201: jsonResponse('Проект импортирован.', 'Project'),
          400: errorResponse('Отсутствует файл или имя проекта, либо архив повреждён.'),
          409: errorResponse('Проект с таким именем уже существует.'),
        },
      },
    },
    '/api/projects/{id}/export': {
      get: {
        tags: ['projects'],
        summary: 'Экспортировать проект в архив',
        parameters: [
          idParam,
          {
            name: 'format',
            in: 'query',
            required: false,
            description: 'Формат архива (по умолчанию `zip`).',
            schema: { type: 'string', enum: ['zip', 'targz'], default: 'zip' },
          },
        ],
        responses: {
          200: {
            description: 'Бинарный архив проекта.',
            content: {
              'application/zip': { schema: { type: 'string', format: 'binary' } },
              'application/gzip': { schema: { type: 'string', format: 'binary' } },
            },
          },
          404: errorResponse('Проект не найден.'),
        },
      },
    },
    '/api/projects/{id}/export.xlsx': {
      get: {
        tags: ['projects'],
        summary: 'Экспортировать требования в Excel (.xlsx)',
        parameters: [idParam],
        responses: {
          200: {
            description: 'Рабочая книга Excel с требованиями и связями.',
            content: {
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          404: errorResponse('Проект не найден.'),
        },
      },
    },
    '/api/projects/{id}/requirements': {
      get: {
        tags: ['requirements'],
        summary: 'Список требований проекта',
        parameters: [
          idParam,
          {
            name: 'format',
            in: 'query',
            required: false,
            description:
              '`json` (по умолчанию) — JSON-список требований; ' +
              '`openspec` — единый OpenSpec-markdown документ (text/markdown).',
            schema: { type: 'string', enum: ['json', 'openspec'] },
          },
        ],
        responses: {
          200: {
            description: 'JSON-список требований (или OpenSpec-markdown при `format=openspec`).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['requirements'],
                  properties: {
                    requirements: { type: 'array', items: ref('Requirement') },
                    broken: { type: 'array', items: { type: 'object' } },
                    incomplete: {
                      type: 'array',
                      items: { type: 'string' },
                      description:
                        'Slug-и требований без полного критерия приёмки (нет сценариев ' +
                        'или есть неполные сценарии) — SA-4.',
                    },
                  },
                },
              },
              'text/markdown': { schema: { type: 'string' } },
            },
          },
          404: errorResponse('Проект не найден.'),
        },
      },
      post: {
        tags: ['requirements'],
        summary: 'Создать требование',
        parameters: [idParam],
        requestBody: jsonBody('CreateRequirement'),
        responses: {
          201: jsonResponse('Требование создано.', 'Requirement'),
          404: errorResponse('Проект не найден.'),
          409: errorResponse('Имя требования уже занято в проекте.'),
          422: errorResponse('Ошибка валидации требования.'),
        },
      },
    },
    '/api/projects/{id}/requirements/check-name': {
      get: {
        tags: ['requirements'],
        summary: 'Проверить доступность имени требования',
        parameters: [
          idParam,
          {
            name: 'type',
            in: 'query',
            required: true,
            description: 'Тип требования (FUNCTION или NFR).',
            schema: { type: 'string', enum: ['FUNCTION', 'NFR'] },
          },
          {
            name: 'name',
            in: 'query',
            required: true,
            description: 'Проверяемое имя требования.',
            schema: { type: 'string' },
          },
          {
            name: 'excludeSlug',
            in: 'query',
            required: false,
            description: 'Slug, исключаемый из проверки (при переименовании существующего).',
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: jsonResponse('Результат проверки имени.', 'CheckNameResult'),
          404: errorResponse('Проект не найден.'),
        },
      },
    },
    '/api/projects/{id}/requirements/{slug}': {
      put: {
        tags: ['requirements'],
        summary: 'Обновить требование',
        description:
          'Обновляет редактируемые поля требования. `aiValidated` (task26) — отметка «проверено» ' +
          'для требований, созданных ИИ: `true` снимает подсветку «не проверено», `false` возвращает её, ' +
          'отсутствие поля сохраняет текущее значение. Поле `origin` (происхождение ИИ-импорта) ' +
          'проставляет только сервер: в теле запроса оно игнорируется и изменить его нельзя.',
        parameters: [idParam, slugParam],
        requestBody: jsonBody('UpdateRequirement'),
        responses: {
          200: jsonResponse('Обновлённое требование.', 'Requirement'),
          404: errorResponse('Проект или требование не найдены.'),
          409: errorResponse('Имя требования уже занято в проекте.'),
          422: errorResponse('Ошибка валидации требования.'),
        },
      },
      delete: {
        tags: ['requirements'],
        summary: 'Удалить требование (каскадно снимает связи)',
        description:
          'По умолчанию удаляет один узел и снимает все ссылки на него у остальных требований; ' +
          'узел с дочерними при этом отклоняется (409 HAS_CHILDREN). При `cascade=true` удаляет узел ' +
          'вместе со всем поддеревом потомков атомарно и возвращает 200 с числом удалённых узлов.',
        parameters: [
          idParam,
          slugParam,
          {
            name: 'cascade',
            in: 'query',
            required: false,
            description:
              'Каскадное удаление поддерева (UX-2). `true` — удалить узел со всеми потомками (ответ 200 ' +
              'с `{ deleted, slugs }`). Отсутствует или `false` — безопасное поведение по умолчанию: узел ' +
              'с дочерними отклоняется (409). Иное значение — 422.',
            schema: { type: 'string', enum: ['true', 'false'] },
          },
        ],
        responses: {
          200: {
            description: 'Поддерево удалено каскадно (`cascade=true`).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['deleted', 'slugs'],
                  properties: {
                    deleted: {
                      type: 'integer',
                      description: 'Число удалённых требований (узел + все потомки).',
                    },
                    slugs: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Slug-и удалённых требований (целевой узел первым).',
                    },
                  },
                },
              },
            },
          },
          204: { description: 'Требование удалено (без каскада).' },
          404: errorResponse('Проект или требование не найдены.'),
          409: errorResponse(
            'Требование нельзя удалить без каскада (есть дочерние, HAS_CHILDREN).',
          ),
          422: errorResponse('Недопустимое значение параметра cascade.'),
        },
      },
    },
    '/api/projects/{id}/links': {
      post: {
        tags: ['links'],
        summary: 'Создать связь между требованиями',
        parameters: [idParam],
        requestBody: jsonBody('CreateLink'),
        responses: {
          201: {
            description: 'Связь создана.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok'],
                  properties: { ok: { type: 'boolean' } },
                },
              },
            },
          },
          404: errorResponse('Проект или требование не найдены.'),
          409: errorResponse('Связь создаёт цикл (details.path содержит путь цикла).'),
          422: errorResponse('Ошибка валидации связи.'),
        },
      },
      delete: {
        tags: ['links'],
        summary: 'Удалить связь между требованиями',
        parameters: [idParam],
        requestBody: jsonBody('CreateLink'),
        responses: {
          200: {
            description: 'Связь удалена.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ok'],
                  properties: { ok: { type: 'boolean' } },
                },
              },
            },
          },
          404: errorResponse('Проект или требование не найдены.'),
        },
      },
    },
    '/api/ai/config': {
      get: {
        tags: ['ai'],
        summary: 'Прочитать конфигурацию AI-хаба',
        description:
          'Ключ API НИКОГДА не возвращается — его наличие сигнализируется полем `hasApiKey`.',
        parameters: [
          {
            name: 'projectId',
            in: 'query',
            required: false,
            description: 'Проект, для которого вернуть выбранную модель (`model`).',
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: jsonResponse('Текущая конфигурация AI-хаба (без ключа API).', 'AiConfigView'),
          400: errorResponse('Некорректные параметры запроса.'),
        },
      },
      put: {
        tags: ['ai'],
        summary: 'Обновить конфигурацию AI-хаба',
        description:
          'Частичное обновление. `apiKey`: непустая строка сохраняет ключ, `null` удаляет его, ' +
          'пропуск/пустая строка сохраняют текущий. Ключ в ответе не возвращается.',
        requestBody: jsonBody('AiConfigUpdate'),
        responses: {
          200: jsonResponse('Обновлённая конфигурация (без ключа API).', 'AiConfigView'),
          400: errorResponse('Ошибка валидации тела запроса.'),
        },
      },
    },
    '/api/ai/models': {
      get: {
        tags: ['ai'],
        summary: 'Список доступных моделей AI-хаба',
        responses: {
          200: jsonResponse('Идентификаторы моделей, доступных на хабе.', 'AiModelsView'),
          400: errorResponse('AI-хаб не настроен или недоступен.'),
        },
      },
    },
    '/api/ai/chat': {
      post: {
        tags: ['ai'],
        summary: 'Отправить сообщение ассистенту',
        description:
          'Роль `system` от клиента не принимается — серверный системный промпт добавляется сам. ' +
          'Модель берётся из `model`, иначе из проекта по `projectId`.',
        requestBody: jsonBody('AiChatRequest'),
        responses: {
          200: jsonResponse('Ответ ассистента (одно сообщение роли assistant).', 'AiChatResponse'),
          400: errorResponse('Ошибка валидации тела или не выбрана модель.'),
        },
      },
    },
    '/api/ai/generate-description': {
      post: {
        tags: ['ai'],
        summary: 'Сгенерировать описание требования',
        requestBody: jsonBody('GenerateDescriptionRequest'),
        responses: {
          200: jsonResponse('Сгенерированный текст описания.', 'GenerateDescriptionResponse'),
          400: errorResponse('Ошибка валидации тела запроса.'),
        },
      },
    },
    '/api/projects/{id}/ai-import': {
      post: {
        tags: ['ai'],
        summary: 'Запустить AI-импорт ФТ/НФТ из архива документации',
        description:
          'Асинхронно: возвращает `jobId` (202), прогресс опрашивается через `GET /api/ai-import/{jobId}`.',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Архив документации (.zip или .tar.gz).',
                  },
                  model: {
                    type: 'string',
                    description: 'Необязательная модель-переопределение для этого импорта.',
                  },
                  inferLinks: {
                    type: 'string',
                    enum: ['true', 'false'],
                    description: 'Опциональный шаг простановки связей ФТ↔НФТ (по умолчанию false).',
                  },
                  buildTree: {
                    type: 'string',
                    enum: ['true', 'false'],
                    description:
                      'Логическое дерево «навыка AI Product Owner»: модель проектирует бизнес-таксономию ' +
                      '(домены → разделы) и раскладывает по ней все ФТ/НФТ; группирующие узлы создаются ' +
                      'как требования с пометкой ИИ (по умолчанию false — структуризация по документации).',
                  },
                },
              },
            },
          },
        },
        responses: {
          202: jsonResponse('Задание импорта поставлено в очередь.', 'AiImportStartResponse'),
          400: errorResponse('Файл не передан, архив повреждён или AI-хаб не настроен.'),
          404: errorResponse('Проект не найден.'),
          413: errorResponse('Архив превышает лимит размера.'),
        },
      },
    },
    '/api/ai-import/{jobId}': {
      get: {
        tags: ['ai'],
        summary: 'Статус задания AI-импорта',
        parameters: [jobIdParam],
        responses: {
          200: jsonResponse(
            'Текущее состояние задания (статус, прогресс, лог, результат).',
            'AiImportJobView',
          ),
          400: errorResponse('Некорректный jobId.'),
          404: errorResponse('Задание не найдено (истёк TTL или сервер был перезапущен).'),
        },
      },
    },
    '/api/ai-import/{jobId}/cancel': {
      post: {
        tags: ['ai'],
        summary: 'Отменить задание AI-импорта',
        parameters: [jobIdParam],
        responses: {
          200: jsonResponse('Задание отменено; в ответе — частичный результат.', 'AiImportJobView'),
          400: errorResponse('Некорректный jobId.'),
          404: errorResponse('Задание не найдено (истёк TTL или сервер был перезапущен).'),
        },
      },
    },
    '/api/projects/{id}/ai-backlog-import': {
      post: {
        tags: ['ai'],
        summary: 'Запустить AI-импорт бэклога из xlsx (todo_22)',
        description:
          'Асинхронно: возвращает `jobId` (202); тот же реестр заданий, что и импорт документации ' +
          '(`kind: "backlog"`). Поток: parse → `awaiting-confirmation` (предпросмотр `backlogPreview`) → ' +
          '`POST …/confirm` {целевой квартал} → match → `awaiting-review` (разметка `backlogReview`, ' +
          'в проект ещё НИЧЕГО не записано) → `POST …/apply` {rowIds} → populate → `succeeded` + `backlogReport`.',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Выгрузка бэклога (.xlsx, до 10 МБ / 5000 строк).',
                  },
                  model: {
                    type: 'string',
                    description: 'Необязательная модель-переопределение для этого импорта.',
                  },
                },
              },
            },
          },
        },
        responses: {
          202: jsonResponse(
            'Задание импорта бэклога поставлено в очередь.',
            'AiImportStartResponse',
          ),
          400: errorResponse('Файл не передан или AI-хаб не настроен.'),
          404: errorResponse('Проект не найден.'),
          409: errorResponse('У проекта уже есть активное задание AI-импорта.'),
        },
      },
    },
    '/api/ai-import/{jobId}/apply': {
      post: {
        tags: ['ai'],
        summary: 'Записать выверенную разметку бэклога в проект (todo_22)',
        description:
          'Единственный шаг, который пишет в проект: создаёт новые узлы (родитель→дитя), требования ' +
          'выбранных строк, связи CHILD_OF и источники типа `BACKLOG` с дефолтным приоритетом словаря. ' +
          'Идемпотентен: повторный запуск не дублирует уже созданное. Дубли (`duplicateOf`) не создаются. ' +
          'task25: необязательное поле `overrides` (rowId → правка шага выверки) мерджится в разметку ДО записи: ' +
          '`businessName` — новое имя требования; `parent` — существующий узел дерева (точное имя, тип строки) ' +
          'или новый КОРНЕВОЙ узел; `targetQuarter`+`targetYear` — срок реализации (только парой). ' +
          'Ключи overrides обязаны входить в `rowIds`; отчёт и контрольная точка отражают отредактированные значения.',
        parameters: [jobIdParam],
        requestBody: jsonBody('AiBacklogApplyBody'),
        responses: {
          200: jsonResponse(
            'Запись запущена; прогресс — через `GET /api/ai-import/{jobId}`.',
            'AiImportJobView',
          ),
          400: errorResponse(
            'Некорректное тело запроса, неизвестные rowIds или невалидная правка overrides ' +
              '(строка вне выбора; несуществующий existing-узел; пустое имя; год вне 2020–2100; ' +
              'квартал/год не парой) — в тексте ошибки указан rowId.',
          ),
          404: errorResponse('Задание не найдено.'),
          409: errorResponse('Задание не находится в статусе `awaiting-review`.'),
        },
      },
    },
    '/api/ai-import/{jobId}/confirm': {
      post: {
        tags: ['ai'],
        summary: 'Подтвердить смету и запустить извлечение (todo_20) / анализ бэклога (todo_22)',
        description:
          'Задание со сметой выше порога (`estimateThresholdTokens` пресета) останавливается в статусе ' +
          '`awaiting-confirmation` ДО первого LLM-вызова извлечения. Подтверждение продолжает конвейер. ' +
          'Для заданий `kind: "backlog"` необязательное тело задаёт общий целевой квартал/год для строк ' +
          'без срока из файла (по умолчанию — `backlogPreview.defaultTarget`).',
        parameters: [jobIdParam],
        requestBody: jsonBody('AiImportConfirmBody', false),
        responses: {
          200: jsonResponse(
            'Смета подтверждена, задание продолжает выполняться.',
            'AiImportJobView',
          ),
          400: errorResponse('Некорректный jobId.'),
          404: errorResponse('Задание не найдено.'),
          409: errorResponse('Задание не находится в статусе `awaiting-confirmation`.'),
        },
      },
    },
    '/api/ai-import/{jobId}/resume': {
      post: {
        tags: ['ai'],
        summary: 'Продолжить задание с контрольной точки (todo_20)',
        description:
          'Возобновляет задание в статусе `failed`/`cancelled`/`interrupted` с последней контрольной точки: ' +
          'уже обработанные фрагменты повторно НЕ отправляются модели (и не оплачиваются); ' +
          'наполнение проекта идемпотентно (существующие требования/связи не дублируются). ' +
          'Лимиты (бюджет, порог сметы) перечитываются из текущего пресета модели.',
        parameters: [jobIdParam],
        responses: {
          202: jsonResponse('Продолжение запущено; jobId прежний.', 'AiImportStartResponse'),
          400: errorResponse('AI-хаб не настроен (нет API-ключа).'),
          404: errorResponse('Задание или его контрольная точка не найдены.'),
          409: errorResponse(
            'Статус задания не допускает продолжения, нет данных контрольной точки или у проекта уже есть активное задание.',
          ),
        },
      },
    },
    '/api/ai-import/{jobId}/log': {
      get: {
        tags: ['ai'],
        summary: 'Скачать полный лог задания файлом (todo_20)',
        parameters: [jobIdParam],
        responses: {
          200: {
            description: 'Полный лог задания (`text/plain`, `Content-Disposition: attachment`).',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
          400: errorResponse('Некорректный jobId.'),
          404: errorResponse('Задание не найдено.'),
        },
      },
    },
    '/api/projects/{id}/ai-import/jobs': {
      get: {
        tags: ['ai'],
        summary: 'История AI-импортов проекта (todo_20)',
        description:
          'Полная история прогонов проекта (решение PO №4): статус, счётчики результата, даты; ' +
          '`resumable: true` — задание можно продолжить через `POST /api/ai-import/{jobId}/resume`.',
        parameters: [idParam],
        responses: {
          200: jsonResponse('Список заданий, новые первыми.', 'AiImportJobList'),
          404: errorResponse('Проект не найден.'),
        },
      },
    },
  };

  // The document is assembled from plain object literals (schemas derived from
  // zod, paths written by hand). Its runtime shape is a valid OpenAPI 3.0 doc,
  // but the piecemeal literals aren't statically inferred as OpenAPIV3.Document,
  // so a single structural cast bridges to the plugin's expected type.
  const doc = {
    openapi: '3.0.3',
    info: {
      title: 'Project PO — REST API',
      description:
        'REST API управления требованиями (проекты, требования, связи, импорт/экспорт). ' +
        'Хранение — OpenSpec-файлы в каталоге `Projects/` (ADR-001).',
      version: '0.1.0',
    },
    servers: [{ url: 'http://localhost:3000', description: 'Локальный сервер разработки.' }],
    tags: [
      { name: 'projects', description: 'Проекты: список, создание, открытие, импорт/экспорт.' },
      { name: 'requirements', description: 'Требования: CRUD и проверка имени.' },
      { name: 'links', description: 'Связи между требованиями.' },
      {
        name: 'ai',
        description:
          'AI-хаб: конфигурация (ключ не возвращается), модели, чат, генерация описаний и AI-импорт из архива документации.',
      },
    ],
    paths,
    components: { schemas },
  };
  return doc as unknown as OpenAPIV3.Document;
}
