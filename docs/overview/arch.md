# Архитектура: «Управление требованиями для Product Owner»

> Стек: **Node.js + TypeScript**. Источник истины — файлы `.md` на диске (без СУБД).
> Версия 1.0 · 2026-06-29. Опирается на `project.md` (ТЗ).

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
│     │  ├─ pages/             # Start, NewProject, Import, OpenExisting, Main
│     │  ├─ components/        # Tree, RequirementModal, LinkModal, Confirm…
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

### 5.1 Доменные типы (packages/core)
```ts
type RequirementType = 'FUNCTION' | 'NFR';
type Criticality = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type LinkType = 'PARENT_OF' | 'CHILD_OF' | 'RELATES_TO' | 'DEPENDS_ON' | 'BLOCKED_BY';

interface Link { type: LinkType; targetId: string; }

interface Requirement {
  id: string;            // ULID, неизменяем
  type: RequirementType;
  name: string;          // уникум по (project, type)
  criticality: Criticality;
  description?: string;
  implemented: boolean;
  targetQuarter?: 'Q1'|'Q2'|'Q3'|'Q4'; // обяз. если !implemented
  targetYear?: number;                  // обяз. если !implemented
  links: Link[];
  createdAt: string; updatedAt: string;
}
```

### 5.2 Сериализация MD
- `serialize(req): string` — `gray-matter` frontmatter (см. 2.5 ТЗ) + body=description.
- `parse(md): Requirement` — обратно, с zod-валидацией; «битый» файл → `ParseError`,
  помечается в UI, не роняет загрузку проекта.

### 5.3 Правила целостности (packages/core/graph)
- `assertUniqueName`, `assertNoCycle`, `assertSingleParent`, `assertNoSelfLink`,
  `assertSameType`, `cascadeUnlink(deletedId)` — чистые функции над массивом требований.

---

## 6. REST API (черновик)

| Метод | Путь | Назначение | FR |
|------|------|-----------|----|
| GET | `/api/projects` | список каталогов в `Projects/` | FR-4 |
| POST | `/api/projects` | создать проект (+воссоздать `Projects/`) | FR-2 |
| POST | `/api/projects/import` | импорт архива (multipart) | FR-3 |
| GET | `/api/projects/:id` | манифест + Main Path | FR-5 |
| GET | `/api/projects/:id/export?format=zip\|targz` | экспорт архива | FR-10 |
| GET | `/api/projects/:id/requirements` | дерево/список требований | FR-7 |
| GET | `/api/projects/:id/requirements/check-name` | проверка уникальности | FR-6.6 |
| POST | `/api/projects/:id/requirements` | создать требование | FR-6 |
| PUT | `/api/projects/:id/requirements/:rid` | редактировать | FR-6.5 |
| DELETE | `/api/projects/:id/requirements/:rid` | удалить + чистка ссылок | FR-9 |
| POST | `/api/projects/:id/links` | создать связь (с проверками) | FR-8 |
| DELETE | `/api/projects/:id/links` | удалить связь | FR-8 |

Все запросы/ответы валидируются zod-схемами; типы клиента генерируются из них.

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
| MD | gray-matter + js-yaml | стабильный машиночитаемый frontmatter |
| ID | ULID | сортируемые, без коллизий, без БД |
| Архивы | `archiver`/`adm-zip` + `tar` | zip и tar.gz (FR-3, FR-10) |
| Фронт | React + Vite + Tailwind | скорость, совместимость с макетами docs/design/ |
| Server state | React Query | кэш + инвалидция = «автосохранение видно сразу» |
| Лог | pino | NFR-9 |
| Unit/Integration | Vitest | быстрый, общий с Vite |
| E2E | Playwright | требование ТЗ |
| Упаковка (позже) | Electron-обёртка | десктоп без переписывания |

`[ОТКРЫТО]` Менеджер пакетов (npm vs pnpm) и финальное имя манифеста проекта —
зафиксировать на старте разработки (см. задачи фундамента в `docs/tasks/`).
