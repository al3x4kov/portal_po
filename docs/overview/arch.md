# Архитектура: «Управление требованиями для Product Owner»

> Стек: **Node.js + TypeScript**. Источник истины — файлы `.md` на диске (без СУБД).
> Версия 1.1 · 2026-07-02. Опирается на `project.md` (ТЗ).
>
> **Формат хранения и идентификаторы — по [`ADR-001-openspec-storage.md`](../architecture/ADR-001-openspec-storage.md)
> (OpenSpec-раскладка, `slug` вместо ULID, связи по `targetSlug`).** Значимые решения —
> в `docs/architecture/ADR-002…006` (MCP-поверх-сервисов, reciprocal-связи, конкурентность,
> single-process SPA+API, версионирование REST). Границы системы — [`context.md`](../overview/context.md).
>
> **История версий:**
> - v1.2 (2026-07-07) — **AI Hub как внешняя интеграция**: §6.3, AI-роуты в §6, актор
>   «Внешний LLM-провайдер», принятый риск по безопасности AI-канала. ADR-007. По итогам совета
>   (ARCH-1/ARCH-7).
> - v1.1 (2026-07-02) — синхронизация с ADR-001 (slug/OpenSpec), актуальные роуты
>   (`:slug`, `/links`, `/export.xlsx`, `?format=openspec`), MCP-сервер, OpenAPI (`/docs`,
>   `/openapi.json`). По итогам совета (ARCH-8).
> - v1.0 (2026-06-29) — исходная архитектура.

---

## 1. Общая схема

Локальное приложение: **браузерный фронтенд** + **локальный Node-сервер**, который
выполняет операции с файловой системой (`Projects/`). Такой вариант выбран вместо
чистого SPA, потому что нужны привилегированные ФС-операции (создание каталогов,
чтение/запись `.md`, упаковка/распаковка архивов), которые недоступны из браузера.
Позже сервер можно обернуть в Electron без переписывания логики.

```
┌─────────────────────────────────────────────┐
│  Browser (React + Vite + TS + Tailwind)       │
│  UI · React Query · Zustand · формы/модалки   │
└───────────────▲───────────────────────────────┘
                │ REST/JSON (localhost)
┌───────────────┴───────────────────────────────┐
│  Node server (Fastify + TypeScript)            │
│  routes → services → repositories → fs         │
│  Zod-валидация · zip/tar · логирование         │
└───────────────▲───────────────────────────────┘
                │ fs (atomic write)
        ┌───────┴────────┐
        │  Projects/      │  ← каталоги проектов, *.md, манифест
        └────────────────┘
```

---

## 2. Структура репозитория (монорепо, npm/pnpm workspaces)

```
project_po/
├─ package.json                # workspaces: packages/*, apps/*
├─ tsconfig.base.json
├─ packages/
│  └─ core/                    # доменная логика, БЕЗ зависимости от fs/http
│     ├─ src/
│     │  ├─ domain/            # модели: Requirement, Link, Project, enums
│     │  ├─ validation/        # zod-схемы + правила целостности (2.4 ТЗ)
│     │  ├─ md/                # сериализация/парсинг MD (gray-matter)
│     │  ├─ graph/             # дерево/связи: циклы, один родитель, каскад
│     │  └─ index.ts
│     └─ test/                 # unit (Vitest) — чистые функции
├─ apps/
│  ├─ server/                  # Fastify API
│  │  ├─ src/
│  │  │  ├─ routes/            # http-слой (тонкий)
│  │  │  ├─ services/          # сценарии: ProjectService, RequirementService…
│  │  │  ├─ repositories/      # FsProjectRepo, FsRequirementRepo, ArchiveRepo
│  │  │  ├─ lib/               # atomicWrite, pathSafe, archive(zip/tar), logger
│  │  │  ├─ app.ts             # сборка Fastify (плагины, error-handler)
│  │  │  └─ main.ts            # bootstrap + serve фронта
│  │  └─ test/                 # unit + integration (temp dir)
│  └─ web/                     # React SPA
│     ├─ src/
│     │  ├─ pages/             # Start, NewProject, Import, OpenExisting, Main,
│     │  │                     # Dashboard, Dictionaries, AiPage, ExportPage, GeneratePage
│     │  ├─ components/        # Tree, RequirementModal, LinkModal, Confirm,
│     │  │                     # WorkspaceScreen (каркас полноэкранных режимов),
│     │  │                     # RequirementPicker (дерево с выбором ветками)
│     │  ├─ api/               # типизированный клиент к серверу
│     │  ├─ store/             # Zustand (UI), React Query (server state)
│     │  └─ main.tsx
│     └─ index.html
└─ e2e/                        # Playwright (запускает server+web, гоняет сценарии)
```

`packages/core` не знает про fs и http → легко покрывается быстрыми unit-тестами.

---

## 3. Бэкенд (apps/server)

### 3.1 Слои
- **routes** — разбор HTTP, вызов сервиса, маппинг ошибок в коды. Без бизнес-логики.
- **services** — сценарии использования; оркестрируют repo + core-правила;
  обеспечивают транзакционность операции (напр. удаление = файл + чистка ссылок).
- **repositories** — единственное место ввода-вывода (fs, архивы).
- **core (импорт из packages/core)** — модели, валидация, графовые проверки.

**Сервисный фасад `[ДОБАВЛЕНО — ARCH-9]`.** Публичная поверхность сервисов
зафиксирована стабильными интерфейсами-фасадами `RequirementServicePort` /
`LinkServicePort` / `ProjectServicePort` (`services/ports.ts`). Классы сервисов
`implements` эти порты (компилятор гарантирует соответствие), а три адаптера над
доменным ядром — REST-роуты, MCP-tools (ADR-002) и `AiImportService` — типизированы
против портов, а не конкретных классов (фабрики в `factory.ts` возвращают порт-тип;
`AiImportServiceDeps`/стадии AI-импорта и `serviceFor` в роутах используют порты).
Порт покрывает ровно те методы, что вызывают адаптеры — приватные хелперы не
протекают. Изменение приватной поверхности сервиса не задевает потребителей; изменение
публичной проходит через порт и сразу видно всем трём адаптерам. Contract-тест:
`apps/server/test/service-ports.test.ts`.

### 3.2 Ключевые модули
- `lib/pathSafe.ts` — резолв путей строго внутри `Projects/`; защита от path traversal
  (NFR-5). Любой путь проверяется `resolved.startsWith(projectsRoot)`.
- `lib/atomicWrite.ts` — запись через temp-файл + `rename` (NFR-4).
- `lib/archive.ts` — `zip` (через `archiver`/`adm-zip`) и `tar.gz` (через `tar`):
  экспорт каталога и импорт во временную папку с валидацией перед «вкатом».
- `lib/logger.ts` — pino, лог ФС-операций и ошибок (NFR-9).
- `services/IntegrityService` — обёртка над core/graph для проверок при связывании/удалении.

### 3.3 Обработка ошибок
Единый `errorHandler`: доменные ошибки (`UniquenessError`, `CycleError`,
`MultipleParentError`, `NotFoundError`, `ArchiveError`, `PathSafetyError`) → понятные
JSON `{ code, message, details }` и корректные HTTP-коды (400/404/409/422/500).

### 3.4 Импорт/экспорт (атомарность)
- **Импорт:** распаковать во `Projects/.import-tmp/<rand>` → валидировать схему всех `.md`
  → проверить целостность ссылок → атомарно `rename` в `Projects/<name>`. При любой
  ошибке tmp удаляется, целевой каталог не создаётся (FR-3.4).
- **Экспорт:** собрать архив в памяти/во временный файл → отдать поток на скачивание.

---

## 4. Фронтенд (apps/web)

- **React + Vite + TypeScript + Tailwind** (макеты в `docs/design/` — тот же визуальный язык,
  токены переносятся в `tailwind.config`).
- **Серверное состояние:** React Query (кэш списка проектов, требований; инвалидция
  после мутаций → автосохранение из FR-6.4 видно сразу).
- **UI-состояние:** Zustand (открытые модалки, выбранный проект, раскрытые узлы дерева).
- **Формы:** React Hook Form + Zod (та же схема, что на сервере, переиспользуется из
  `packages/core`) → единые правила валидации, real-time проверка уникальности (FR-6.6)
  делает дебаунс-запрос к `GET /api/projects/:id/requirements/check-name`.
- **Компоненты:** `TreeTable` (рекурсивное дерево + колонки), `RequirementModal`
  (создание/редактирование), `LinkModal` (тип + поиск), `ConfirmDialog` (подтверждения),
  `PathHeader` (Main Path), `ImportDropzone`.

---

## 5. Модель данных и контракты

### 5.1 Доменные типы (packages/core) `[ОБНОВЛЕНО v1.1 — ADR-001]`
```ts
type RequirementType = 'FUNCTION' | 'NFR';
type Criticality = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'BLOCKER'; // 5 значений (BA-2/SA-5)
type LinkType = 'PARENT_OF' | 'CHILD_OF' | 'RELATES_TO' | 'DEPENDS_ON' | 'BLOCKED_BY';

interface Link { type: LinkType; targetSlug: string; } // цель по slug (ADR-001)

interface Requirement {
  slug: string;          // человекочитаемый [a-z0-9-], уникум в проекте, неизменяем (ADR-001)
  type: RequirementType; // выводится из папки functions/nfr
  name: string;          // уникум по (project, type)
  criticality: Criticality;
  description?: string;
  implemented: boolean;
  targetQuarter?: 'Q1'|'Q2'|'Q3'|'Q4'; // обяз. если !implemented
  targetYear?: number;                  // обяз. если !implemented (2020..2100)
  scenarios?: Scenario[]; // опц. OpenSpec `#### Scenario:` (read-only из импорта, SA-10)
  links: Link[];
  createdAt: string; updatedAt: string;
}
```

### 5.2 Сериализация MD (OpenSpec) `[ОБНОВЛЕНО v1.1 — ADR-001]`
- `serialize(req): string` — OpenSpec-разметка (не frontmatter): `### Requirement:` +
  метаданные-булиты + тело-описание + опц. `#### Scenario:` / `#### Links` (см. 2.5 ТЗ, ADR-001).
- `parse(md): Requirement` — обратно, со строгим разбором и zod-валидацией; «битый» файл →
  `ParseError`, помечается в UI (`broken[]`), не роняет загрузку проекта.
- Round-trip serialize↔parse — без потерь (инвариант тестов, S1).
- Манифест `openspec/project.md` (frontmatter: `name`, `schemaVersion`, `createdAt`);
  `schemaVersion` проверяется при чтении/импорте (ADR-006/SA-9).

### 5.3 Правила целостности (packages/core/graph) `[ОБНОВЛЕНО v1.1]`
- `assertUniqueName`, `assertNoCycle`, `assertSingleParent`, `assertNoSelfLink`,
  `assertSameType`, `cascadeUnlink(deletedSlug)` — чистые функции над массивом требований
  (адресация по `slug`). `toSlug`/`dedupe` — генерация и дедуп slug в рамках проекта.

---

## 6. REST API `[ОБНОВЛЕНО v1.1 — актуальные роуты; ADR-001/ADR-006]`

Адресация требований — по **`slug`** (не `:rid`/ULID). Полный контракт и коды ошибок —
[`docs/architecture/api.md`](../architecture/api.md).

| Метод | Путь | Назначение | FR |
|------|------|-----------|----|
| GET | `/api/projects` | список каталогов в `Projects/` | FR-4 |
| POST | `/api/projects` | создать проект (+воссоздать `Projects/`) | FR-2 |
| POST | `/api/projects/import` | импорт архива (multipart) | FR-3 |
| GET | `/api/projects/:id` | манифест + Main Path | FR-5 |
| GET | `/api/projects/:id/export?format=zip\|targz` | экспорт архива | FR-10 |
| GET | `/api/projects/:id/export.xlsx` | экспорт в Excel (только выгрузка) | FR-10.3/FR-15 |
| GET | `/api/projects/:id/requirements` | список требований; `?format=json\|openspec` | FR-7/FR-10.4 |
| GET | `/api/projects/:id/requirements/check-name` | проверка уникальности | FR-6.6 |
| POST | `/api/projects/:id/requirements` | создать требование | FR-6 |
| PUT | `/api/projects/:id/requirements/:slug` | редактировать | FR-6.5 |
| DELETE | `/api/projects/:id/requirements/:slug[?cascade=true]` | удалить + чистка ссылок; `cascade=true` — удалить узел со всем поддеревом (200 `{deleted,slugs}`), иначе узел с детьми → 409 HAS_CHILDREN | FR-9 / UX-2 |
| POST | `/api/projects/:id/links` | создать связь (реципрокная пара, с проверками) | FR-8 |
| DELETE | `/api/projects/:id/links` | удалить связь (обе стороны) | FR-8/FR-13 |
| GET/PUT | `/api/ai/config` | чтение/запись AI-конфига (ключ не возвращается) | FR-17 |
| GET | `/api/ai/models` | список моделей провайдера | FR-17.3 |
| POST | `/api/ai/chat` | сообщение чат-помощнику | FR-18 |
| POST | `/api/ai/generate-description` | генерация описания требования | FR-19 |
| POST | `/api/projects/:id/ai-import` | старт AI-импорта из документации (async → `jobId`) | FR-20 |
| GET | `/api/ai-import/:jobId` | статус/прогресс/лог импорт-джобы (`running/succeeded/failed/cancelled`) | FR-20.2 |
| POST | `/api/ai-import/:jobId/cancel` | отменить импорт-джобу | FR-20.2 |

- `[ДОБАВЛЕНО v1.2]` **AI-эндпоинты** (`/api/ai/*`, `/api/…/ai-import`) — исходящая интеграция с
  внешним LLM (AI Hub); async-контракт импорта (202 + polling) и границы — §6.3, ADR-007, api.md.
- **`?format=openspec`** на `/requirements` — склеенный OpenSpec-текст (`text/markdown`),
  детерминированный/байт-в-байт (§1.2 ТЗ, api.md). `?format=json` (по умолчанию) — прежний JSON.
- Все запросы/ответы валидируются zod-схемами (единый источник — `@po/core`, ARCH-4);
  типы клиента и MCP-tools используют те же схемы.
- **Ошибки** — единый конверт `{ code, message, details? }`, коды 400/404/409/422/500
  (`httpStatusForCode`, api.md).
- **Версионирование:** `schemaVersion` манифеста; политика REST — через `info.version` OpenAPI,
  обратносовместимые изменения (ADR-006/ARCH-5).

### 6.1 OpenAPI / Swagger `[ДОБАВЛЕНО v1.1 — E14]`
- Спецификация публикуется как `GET /openapi.json`; интерактивный UI — `GET /docs`
  (Swagger). Отражает актуальные роуты и модели.

### 6.2 MCP-сервер (для ИИ-агентов) `[ДОБАВЛЕНО v1.1 — ADR-002]`
- `apps/mcp` (`@po/mcp`, `@modelcontextprotocol/sdk`, транспорт **stdio**) — **тонкая обёртка
  поверх доменных сервисов** `@po/server`/`@po/core` (не поверх HTTP). Входы валидируются
  теми же zod-схемами из `@po/core`.
- Tools: `list_projects`, `get_project`, `list_requirements`, `get_requirement`,
  `create_requirement`, `update_requirement`, `link_requirements`, `delete_requirement`,
  `export_project`. Read-tools без сайд-эффектов; write-tools возвращают итоговое состояние.
- Доменные ошибки маппятся в MCP error с сохранением `details` (напр. `CycleError.path`,
  ARCH-11). Лог — в stderr (NFR-9). Запуск: `node apps/mcp/dist/main.js`, `PROJECTS_ROOT` из env.
- Контекст акторов/событий REST и MCP — [`context.md`](../overview/context.md).

### 6.3 AI Hub (внешний LLM-провайдер) `[ДОБАВЛЕНО v1.2 — ADR-007]`
- **Исходящая** интеграция с внешним OpenAI-совместимым сервисом (`services/AiHubService.ts`,
  `AiImportService.ts`, `openaiClient.ts`; конфиг — `AiConfigRepo` → `.ai-config.json`).
  Единственная внешняя система, к которой сервер обращается сам.
- **Сценарии:** чат (`/api/ai/chat`), генерация описания (`/api/ai/generate-description`),
  AI-импорт из документации (`/api/projects/:id/ai-import`, async). Наружу уходят сообщения
  чата, контекст требования/проекта и **содержимое загруженной документации**.
- **Async-контракт импорта:** старт → `jobId`; статус/прогресс/лог — polling `GET /api/ai-import/:jobId`;
  реестр джоб **in-memory, single-process** (при рестарте состояние теряется — ARCH-4); импорт
  **не атомарен** как целое (каждая запись под своим project-lock, ADR-004).
- **Деградация:** ядро работает без AI Hub; при недоступности провайдера деградируют только
  AI-функции (NFR-10).
- **Секрет и TLS:** ключ — plaintext в конфиге, наружу не отдаётся, редактируется из логов;
  TLS-проверка AI Hub по умолчанию отключена. Это **принятый риск** локального demo — см.
  [`../architecture/ADR-007-ai-hub-integration.md`](../architecture/ADR-007-ai-hub-integration.md)
  (условие пересмотра, задачи ARCH-2/BE-8/SA-2).
- Контекст акторов/событий AI — [`context.md`](../overview/context.md) (актор «Внешний
  LLM-провайдер», события #25–#29).

---

## 7. Тестирование (NFR-8)

- **Unit (Vitest) — `packages/core`:** сериализация/парсинг MD (round-trip), все правила
  целостности (уникальность, циклы, один родитель, self-link, типы, каскад), валидация
  условных полей (квартал/год при `implemented=false`).
- **Integration (Vitest) — `apps/server`:** репозитории и сервисы на **временной**
  директории (`os.tmpdir()`): создание проекта, CRUD требований, импорт/экспорт round-trip,
  атомарность (сбой посередине не портит данные), path traversal отклоняется.
- **E2E (Playwright) — `e2e/`:** поднимает server+web, прогоняет сценарии: новый проект →
  добавить ФТ/НФТ → связать → дерево → удалить с подтверждением → экспорт → импорт.
  Покрывает FR-1…FR-10 и DoD из ТЗ.
- **CI:** `lint` (ESLint) → `typecheck` (tsc) → `unit` → `e2e`. Зелёный CI = критерий 6 DoD.

---

## 8. Технологический выбор (резюме)

| Область | Выбор | Почему |
|--------|-------|--------|
| Язык | TypeScript (strict) | требование ТЗ, типобезопасность контрактов |
| Сервер | Fastify | быстрый, схемы/валидация из коробки |
| Валидация | Zod | единые схемы фронт/бэк/core |
| MD | OpenSpec-разметка (свой парсер/сериализатор) | человекочитаемо для PO и ИИ-агента; манифест — frontmatter (js-yaml) (ADR-001) |
| ID | **slug** (`[a-z0-9-]`, из `name`) | читаемые связи, стабильны при переименовании; без опаковых ULID (ADR-001) |
| Архивы | `archiver`/`adm-zip` + `tar` | zip и tar.gz (FR-3, FR-10) |
| Excel | `exceljs` | `.xlsx`-выгрузка «как в UI» (FR-10.3/FR-15), без нативных зависимостей |
| AI-канал (исходящий MCP) | MCP (`@modelcontextprotocol/sdk`, stdio) | второй потребитель — ИИ-агент поверх сервисов (ADR-002) |
| AI Hub (исходящая интеграция) | внешний OpenAI-совместимый провайдер (`openaiClient`/undici) | чат, генерация описания, AI-импорт; §6.3, ADR-007 (принятый риск TLS/ключа) |
| API-док | OpenAPI/Swagger | `/openapi.json` + `/docs` (E14) |
| Фронт | React + Vite + Tailwind | скорость, совместимость с макетами docs/design/ |
| Server state | React Query | кэш + инвалидция = «автосохранение видно сразу» |
| Лог | pino | NFR-9 |
| Unit/Integration | Vitest | быстрый, общий с Vite |
| E2E | Playwright | требование ТЗ |
| Упаковка (позже) | Electron-обёртка | десктоп без переписывания |

Имя манифеста зафиксировано — `openspec/project.md` (ADR-001). Менеджер пакетов —
npm workspaces (см. задачи фундамента в `docs/tasks/`).
