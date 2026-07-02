import type { OpenAPIV3 } from 'openapi-types';
import { z } from 'zod';
import { linkSchema, requirementSchema } from '@po/core';
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
        parameters: [idParam, slugParam],
        responses: {
          204: { description: 'Требование удалено.' },
          404: errorResponse('Проект или требование не найдены.'),
          409: errorResponse('Требование нельзя удалить (например, есть дочерние).'),
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
    ],
    paths,
    components: { schemas },
  };
  return doc as unknown as OpenAPIV3.Document;
}
