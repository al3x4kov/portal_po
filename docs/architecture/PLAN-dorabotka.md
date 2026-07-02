# План доработки project_po (Фаза A)

Автор: Архитектор · 2026-07-01 · Дополняет `docs/overview/project.md`, `docs/overview/arch.md`.
Основной ADR по хранилищу: `ADR-001-openspec-storage.md`.

---

## A2 (исх. 2) — Экспорт в Excel `.xlsx`

**Цель:** помимо архивов (`.zip/.tar.gz`) отдавать проект как книгу Excel.

- **Библиотека:** `exceljs` (стриминг, без нативных зависимостей, MIT).
- **Эндпоинт:** `GET /api/projects/:id/export.xlsx` → `Content-Type:
  application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Content-Disposition:
  attachment`.
- **Листы:**
  1. `Requirements` — колонки: `slug, type, name, criticality, implemented, target (Q+год),
     description (plain), scenarios (кол-во)`.
  2. `Links` — `from(slug), type, to(slug)` (только «прямые» стороны пар: PARENT_OF,
     RELATES_TO, DEPENDS_ON — чтобы не дублировать реципрокные).
- **Сервис:** `ExcelExportService` в `apps/server/src/services/`, чистая функция построения
  книги из `Requirement[]` — покрывается unit-тестом (число строк/листов/заголовки).
- **UI:** пункт в меню «Экспорт» (рядом с zip/targz) — Фаза D7.
- **Тест:** unit на построение книги; E2E — скачивание файла и проверка сигнатуры `.xlsx`
  (PK-zip заголовок), непустых листов.

## A3 (исх. 9) — AI-ready API (REST + MCP)

**Цель:** требования как источник истины для ИИ-агентов.

- **REST для агентов** (стабилизировать существующий контур, добавить машинные форматы):
  - `GET /api/projects/:id/requirements?format=openspec` — вернуть склеенный OpenSpec-текст.
  - Все ответы уже валидируются zod; задокументировать в `docs/architecture/api.md` (OpenAPI-набросок).
- **MCP-сервер** `apps/mcp/` (новый workspace, `@po/mcp`, `@modelcontextprotocol/sdk`,
  stdio-транспорт). Тонкая обёртка над сервисами `@po/server`/`@po/core` (без HTTP):
  - Tools: `list_projects`, `get_project`, `list_requirements`, `get_requirement`,
    `create_requirement`, `update_requirement`, `link_requirements`, `delete_requirement`,
    `export_project`.
  - Валидация входов — те же zod-схемы из `@po/core` (единый источник правил).
  - Read-tools без побочных эффектов; write-tools возвращают итоговое состояние требования.
- **Тест:** unit на регистрацию tools и маппинг ошибок домена → MCP error; smoke на
  вызов `list_requirements` против временной директории.
- Задачи: `docs/tasks/E10-ai-mcp.md`.

## A4 (исх. 10) — Матрица ситуаций «корректно/некорректно»

Полная таблица в `docs/architecture/test-situations.md`. Категории: хранилище/парсинг,
целостность связей, уникальность/slug, импорт/экспорт (вкл. xlsx), ФС-безопасность, UI-
фильтры/поиск/раскрытие, MCP. Каждая строка → тест (unit или E2E) с владельцем.
Задачи на автотесты — `docs/tasks/E12-quality.md`.

## A5 (исх. 11) — Покрытие unit-тестами

**Факт (2026-07-01, `npm test`):** `packages/core` — 98.5% stmts / 94.59% branch / 100%
funcs. **НО** порог покрытия (`vitest.config.ts`) включает только `packages/core/src/**`.
`apps/server` (services, repositories, routes, lib) имеет интеграционные тесты, **но не
входит в метрику покрытия** — фактическое покрытие серверного слоя неизвестно.

**Решение:**
1. Расширить `coverage.include` на `apps/server/src/**` (кроме `main.ts`, роут-биндингов).
2. Порог для server — начать с `lines/statements ≥ 80%`, поднять до 90% по мере доводки.
3. Новый код (OpenSpec-хранилище, Excel, MCP) — писать по TDD, покрытие ≥90%.
- Задачи: `docs/tasks/E12-quality.md` (C4).

## A6 (исх. 12) — Ревизия коллизий постановок

| # | Коллизия | Разрешение |
|---|----------|-----------|
| 1 | «Убрать id» (исх.1) vs связи по `targetId` | ADR-001: ULID→**slug** (стабильный, читаемый). |
| 2 | OpenSpec = много требований в 1 spec.md vs «файл на ФТ/НФТ» | ADR-001: гибрид «1 файл = 1 требование», задокументировано как отклонение. |
| 3 | FR-7.4 «Описание по клику» (исх.6, B4) — было `[ОТКРЫТО]` | Закрывается макетом B4 (раскрытие/поповер/панель). |
| 4 | Поиск с показом предков (исх.5) vs «Скрыть зависимости» (исх.3) | Оба меняют видимость строк дерева → **единая модель фильтрации видимости** (search + collapse + criticality-filter — один слой `visibleRows`). Иначе конфликт состояний. |
| 5 | Мультиселект критичности (исх.7) vs дерево (скрытие потомка скрывает предка?) | Правило: фильтр оставляет предков видимого совпадения (как в поиске) — общий слой из #4. |
| 6 | Экспорт xlsx (исх.2) vs round-trip импорт (FR-10.2) | xlsx — **только выгрузка** (не импортируется); импорт остаётся archive-only. Зафиксировать в ТЗ. |
| 7 | Новая раскладка (исх.4) vs существующие data-testid для E2E | FE сохраняет/актуализирует `data-testid`, QA обновляет селекторы синхронно. |
| 8 | **Кросс-типовая коллизия slug** (найдено при E8): одно имя в FUNCTION и NFR (S9) → одинаковый slug в разных папках → неоднозначность `/requirements/:slug`, целей связей и ключей дерева | **Решение (2026-07-01):** `slug` уникален в рамках **проекта** (дедуп по всем slug обоих типов, не по типу). Slug однозначно адресует требование; тип выводится из папки. Правка в `RequirementService`/`dedupe` + тест (E8.1). |

**Правки постановки:** внесены в этот план; `docs/overview/project.md` дополнить пунктами
про xlsx-экспорт (только выгрузка), slug вместо id, единый слой видимости строк — задача
в `docs/tasks/E11-ui-enhancements.md`/`E8`.

---

## Порядок исполнения (Фазы C–E)

1. **C1** OpenSpec-хранилище (`@po/core` + repo) — фундамент, блокирует остальное.
2. Параллельно после C1: **C2** Excel, **C3** MCP, **D1–D6** UI (по макетам Фазы B).
3. **D7** кнопка Excel (после C2). **C4** покрытие.
4. **E2** E2E по матрице (после D). **E3** README.

Зависимости отражены в `docs/tasks/` через `blockedBy`.
