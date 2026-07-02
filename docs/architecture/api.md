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
