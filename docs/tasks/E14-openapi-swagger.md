# E14 — OpenAPI/Swagger документация REST API (BE, TDD)

Основание: обратная связь по экрану «Сервисные функции» (REST API). Нужен настоящий
Swagger-документ со схемами тел запроса/ответа и query-параметрами, доступный по URL.

## Контракт (согласованные URL — фронтенд ссылается на них, НЕ менять)
- **Swagger UI (интерактивно):** `GET /docs` → HTML со Swagger UI.
- **OpenAPI JSON (машиночитаемо):** `GET /openapi.json` → валидный OpenAPI 3.x документ.

## Требования
- Подключить `@fastify/swagger` (^9) и `@fastify/swagger-ui` (^5) (совместимы с Fastify 5).
  Ассеты Swagger UI должны отдаваться локально (без внешнего CDN) — приложение локальное.
- Документ OpenAPI должен покрывать ВСЕ существующие эндпоинты и для каждого содержать:
  - **path-параметры** с пояснением: `:id` — идентификатор проекта (имя каталога проекта в
    `Projects/`, из `GET /api/projects`), `:slug` — стабильный человекочитаемый идентификатор
    требования (генерируется из имени, уникален в проекте; см. ADR-001).
  - **query-параметры**: у `GET /api/projects/:id/requirements` — `format=json|openspec`;
    у `GET /api/projects/:id/export` — `format=zip|targz`.
  - **request body schema** и **response schema** (component-схемы Requirement, Link, Project,
    CreateRequirement, UpdateRequirement, CreateLink, CheckNameResult, Error).
- Схемы компонентов строить из существующих zod-схем (`@po/core` + тела роутов) через
  `zod-to-json-schema` (или эквивалент), чтобы не расходились с реальной валидацией. Если
  проще и надёжнее — навесить JSON-schema на `schema` каждого роута, чтобы `@fastify/swagger`
  собрал спецификацию автоматически; двойная валидация допустима, если схемы совпадают с zod.
- `info.title`, `info.version`, `servers` (например `http://localhost:3000`) заполнить.
- Существующее поведение и все текущие тесты — НЕ ломать. Не трогать apps/web, apps/mcp.

## Тесты (TDD)
- `GET /openapi.json` → 200, `openapi` начинается с `3.`, в `paths` присутствуют ключевые
  маршруты (`/api/projects`, `/api/projects/{id}/requirements`, `.../requirements/{slug}`,
  `/api/projects/{id}/links`, `/api/projects/{id}/export`), у списка требований описан query
  `format`, у требования описаны `id` и `slug` c описанием.
- `GET /docs` → 200, `text/html` (Swagger UI).
- Интеграционные тесты сервера остаются зелёными.

## DoD
- `npm test` зелёный (+ новые), покрытие не падает ниже порогов; `typecheck`/`lint`/`format` — OK.
- В отчёте: добавленные зависимости, файлы, финальные URL, число passed тестов.
