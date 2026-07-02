# E13 — «Сервисные функции» на главном экране (FE, TDD)

Основание: `.dev/todo/todo_2.md` (п.1, п.2). Реализовать строго по TDD (Vitest + RTL).

## Цель
На главном экране добавить блок **«Сервисные функции»** с 3 пунктами и 3 экрана-описания
(что это и как пользоваться): **AI-ready API**, **REST API**, **MCP**.

## T-1301 · Раздел «Сервисные функции» на стартовом экране (п.1)
- На стартовом экране (`apps/web/src/pages/Start.tsx`), **под** карточками «Новый проект»,
  «Импорт», «Открыть существующий» — раздел **«Сервисные функции»** (`data-testid="services-section"`)
  из 3 карточек: «AI-ready API» (`service-open-ai`), «REST API» (`service-open-rest`),
  «MCP» (`service-open-mcp`). Клик по карточке открывает соответствующий `ServiceScreen`.
- Раздел НЕ размещается на экране управления ФТ/НФТ (`Main`/`PathHeader`).

## T-1302 · 3 экрана-описания (п.2)
- Новый компонент `ServiceScreen` (модалка на базе `components/Modal.tsx`, широкая, со скроллом):
  `data-testid="service-screen"`, атрибут `data-service` = `ai|rest|mcp`, заголовок
  `service-screen-title`, закрытие `service-screen-close` (кнопка/Esc/скрим).
- Контент по каждому пункту — секции «Что это» и «Как пользоваться» с таблицей/кодом.
  Стиль — через дизайн-токены (`var(--color-*)`), как в остальном UI. Текст — ниже.

### AI-ready API
- **Что это:** требования — источник истины для ИИ. Хранятся в человекочитаемом формате
  OpenSpec (`### Requirement:` / `#### Scenario:`), который ИИ-агент читает без парсера.
- **Как:** `GET /api/projects/:id/requirements?format=openspec` → `text/markdown` со
  склеенным OpenSpec-текстом всего проекта. Отдайте агенту как контекст.
- **Пример:** `curl "http://localhost:3000/api/projects/<id>/requirements?format=openspec"`

### REST API
- **Что это:** локальный сервер даёт REST/JSON поверх файлового хранилища; все запросы/ответы
  валидируются zod-схемами из `@po/core`.
- **Эндпоинты (таблица):**
  - `GET /api/projects` — список проектов; `POST /api/projects` — создать
  - `GET /api/projects/:id/requirements` — список/дерево (или `?format=openspec`)
  - `POST /api/projects/:id/requirements` — создать; `PUT .../requirements/:slug` — изменить;
    `DELETE .../requirements/:slug` — удалить
  - `GET /api/projects/:id/requirements/check-name` — проверка уникальности имени
  - `POST` / `DELETE /api/projects/:id/links` — создать/удалить связь
  - `GET /api/projects/:id/export?format=zip|targz`, `GET /api/projects/:id/export.xlsx` — экспорт
- **Пример:** `curl -X POST http://localhost:3000/api/projects -H 'content-type: application/json' -d '{"name":"my-product"}'`

### MCP
- **Что это:** `apps/mcp` — MCP-сервер (Model Context Protocol, транспорт stdio) поверх той же
  доменной логики; даёт ИИ-ассистенту инструменты для работы с требованиями.
- **Инструменты:** `list_projects, get_project, list_requirements, get_requirement,
  create_requirement, update_requirement, link_requirements, delete_requirement, export_project`.
- **Как подключить:** `npm run build`, затем `node apps/mcp/dist/main.js` (env `PROJECTS_ROOT`).
  Пример конфигурации MCP-клиента:
  ```json
  {
    "mcpServers": {
      "project-po": {
        "command": "node",
        "args": ["/абсолютный/путь/apps/mcp/dist/main.js"],
        "env": { "PROJECTS_ROOT": "/абсолютный/путь/Projects" }
      }
    }
  }
  ```

## DoD
- Vitest+RTL: меню открывает 3 пункта; каждый открывает `service-screen` с нужным `data-service`
  и ключевым текстом (напр. «format=openspec», список tools, curl-пример); закрытие работает.
- `npm run typecheck`, `npm run lint`, `npm test` (web) — зелёные. Границы: только `apps/web`.
