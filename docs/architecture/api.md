# AI-ready API — contract sketch (E10)

Дополняет существующий REST-контур `apps/server`. Все ошибки — единый конверт
`{ code, message, details? }` (см. `apps/server/src/lib/errors.ts`, `httpStatusForCode`).

## REST (для агентов)

### GET `/api/projects/:id/requirements`
Список требований проекта. Поведение зависит от query-параметра `format`.

| Параметр | Значения | По умолчанию |
|----------|----------|--------------|
| `format` | `json` \| `openspec` | `json` |

- **`json` (или без параметра)** — прежний ответ, `Content-Type: application/json`:
  ```json
  { "requirements": [ /* Requirement[] */ ], "broken": [ { "file": "...", "error": "..." } ] }
  ```
- **`openspec`** — склеенный OpenSpec-текст, `Content-Type: text/markdown; charset=utf-8`:
  ```markdown
  # OpenSpec: <projectId>

  ## functions

  ### Requirement: <name>
  - criticality: ...
  ...

  ## nfr

  ### Requirement: <name>
  ...
  ```
  Заголовок проекта + секция `## <folder>` на каждый тип (`functions`/`nfr`),
  внутри — сериализованные `### Requirement:` фрагменты (ADR-001). Пустой проект →
  только строка `# OpenSpec: <projectId>`.

**Коды ошибок:** `404 NOT_FOUND` (нет проекта), `400 BAD_REQUEST` (неверный `format`).

## AI-подсистема (внешний LLM-провайдер, ADR-007) `[ДОБАВЛЕНО 2026-07-07 — ARCH-7]`

Исходящая интеграция с внешним OpenAI-совместимым сервисом (AI Hub). Ключ **никогда не
возвращается** в ответах. Границы, что уходит наружу, и **принятый риск** (TLS/ключ) —
[`ADR-007-ai-hub-integration.md`](ADR-007-ai-hub-integration.md).

| Метод | Путь | Запрос → Ответ | Ошибки |
|-------|------|----------------|--------|
| GET | `/api/ai/config` | `?projectId?` → `{ baseURL, hasApiKey, model?, modelPresets? }` | 400 |
| PUT | `/api/ai/config` | `{ baseURL?, apiKey?: string\|null, model?, modelPresets?, projectId? }` → `AiConfigView` | 400 |
| GET | `/api/ai/models` | → `{ models: string[] }` | 400/5xx (провайдер) |
| POST | `/api/ai/chat` | `{ messages[], model?, projectId? }` → `{ message }` | 400/5xx |
| POST | `/api/ai/generate-description` | `{ projectId, requirement…, hint? }` → `{ description }` | 400/5xx |
| POST | `/api/projects/:id/ai-import` | multipart (`file` + опц. `model`, `inferLinks`) → **202** `{ jobId }` | 400/404/413 |
| GET | `/api/ai-import/:jobId` | → `AiImportJobView` `{ jobId, projectId, status, stage, progress, log[], result?, error?, relate? }` (`status`: `running\|succeeded\|failed\|cancelled`) | 404 (нет/истёк/после рестарта) |
| POST | `/api/ai-import/:jobId/cancel` | отменить импорт-джобу → `AiImportJobView` | 404 |

- **Async-контракт импорта:** старт возвращает `jobId` (202); клиент опрашивает статус (~800 мс).
  Реестр джоб **in-memory, single-process** — после рестарта процесса `jobId` → `404` (ARCH-4).
  Повторный запуск идемпотентен по смыслу (доливает недостающее). `apiKey:null` в `PUT` удаляет ключ.
- **Что уходит наружу:** сообщения чата, контекст требования/проекта, **содержимое документации**
  (импорт). Единый конверт ошибок `{ code, message, details? }`.

## Лимиты загрузки `[ДОБАВЛЕНО 2026-07-07 — ARCH-5/ARCH-6]`

Единый источник — `apps/server/src/lib/limits.ts` (импортируется в `app.ts`, роутах
импорта, `ArchiveRepo`, `lib/unpack.ts`). Продуктовый предел архива берётся из
`@po/core` (`AI_IMPORT_MAX_ARCHIVE_BYTES`), чтобы совпадать с проверкой в UI.

| Константа | Значение | Где применяется |
|-----------|----------|-----------------|
| `BODY_LIMIT_BYTES` | 5 MiB | Fastify `bodyLimit` для обычных (не-multipart) запросов |
| `MAX_UPLOAD_BYTES` | 50 MiB (= `AI_IMPORT_MAX_ARCHIVE_BYTES`) | multipart `fileSize` — предел одного загружаемого архива |
| `MAX_UNPACK_TOTAL_BYTES` | 100 MiB | суммарный **несжатый** размер при распаковке (bomb-guard) |
| `MAX_UNPACK_ENTRIES` | 10 000 | суммарное число записей архива (bomb-guard) |

- **Ранняя отбраковка (ARCH-6):** multipart-поток обрезается на `MAX_UPLOAD_BYTES`
  (`throwFileSizeLimit: false`); роуты импорта проверяют `part.file.truncated` сразу
  после стрима и возвращают `400`, не записывая в tmp больше кэпа. Предел больше не
  проверяется постфактум по `fs.stat` после полной записи.
- **Защита от decompression-bomb (ARCH-5):** и `ArchiveRepo` (импорт проекта), и
  `lib/unpack.ts` (AI-импорт) считают несжатый размер и число записей **инкрементально**
  во время обхода — для zip перед записью каждой записи, для tar.gz потоково в `filter`.
  Превышение → `ArchiveError`, временный каталог удаляется. Защита от zip-slip/traversal
  (NFR-5) сохранена без изменений.

## MCP (stdio, `apps/mcp`, `@po/mcp`)

Тонкая обёртка над сервисами `@po/server` поверх общего `PROJECTS_ROOT` (env, дефолт
`<repo>/Projects`). Входы валидируются Zod (енумы из `@po/core`). Доменные ошибки
(`UNIQUENESS`, `CYCLE`, `SELF_LINK`, `MULTIPLE_PARENT`, `HAS_CHILDREN`, `VALIDATION`,
`NOT_FOUND`, …) маппятся в MCP error-result (`isError: true`, текст `[CODE] message`),
не в необработанное исключение.

| Tool | Вход | Выход |
|------|------|-------|
| `list_projects` | — | `{ projects: ProjectSummary[] }` |
| `get_project` | `projectId` | `{ project: ProjectSummary }` |
| `list_requirements` | `projectId` | `{ requirements: Requirement[], broken: [] }` (пусто → `[]`, не ошибка) |
| `get_requirement` | `projectId, slug` | `{ requirement: Requirement }` |
| `create_requirement` | `projectId, type, name, criticality, description?, implemented, targetQuarter?, targetYear?` | `{ requirement }` (итоговое состояние) |
| `update_requirement` | `projectId, slug, name, criticality, description?, implemented, targetQuarter?, targetYear?` | `{ requirement }` (slug/type неизменны) |
| `link_requirements` | `projectId, sourceSlug, type, targetSlug` | `{ requirement }` (source после связи) |
| `delete_requirement` | `projectId, slug` | `{ deleted: true, slug }` |
| `export_project` | `projectId, format: zip\|targz` | `{ path, filename, contentType, bytes }` (архив во временном файле) |

**Read-tools** (`list_*`, `get_*`) — без сайд-эффектов. **Write-tools** возвращают
итоговое состояние требования.

**Запуск:** `npm run build` → `node apps/mcp/dist/main.js` (транспорт stdio);
`PROJECTS_ROOT` можно переопределить через env.
