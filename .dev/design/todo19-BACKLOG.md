# Бэклог: доработки портала PO (todo_19)

Вход: `.dev/design/todo19-po-spec.md`, макет `.dev/design/todo19/proposal.html`. Все гейты PO закрыты.
Границы владения: **backend** = `@po/core` + `apps/server` (+их тесты); **frontend** = `apps/web`; **QA** = `e2e/`. Контракт — один, в `@po/core` (Zod), фронт только потребляет.

---

## 0. ЕДИНЫЙ КОНТРАКТ (владелец — backend, Волна 1). Фронт не меняет.

### 0.1 Доменные типы (`@po/core` `domain/types.ts`)
```ts
export type SourceType = 'CLIENT' | 'STAKEHOLDER' | 'STANDARD' | 'TEXT';

// Базовые шкалы RICE (селекты)
export const RICE_REACH = [1,2,3,4,5] as const;
export const RICE_IMPACT = [0.25,0.5,1,2,3] as const;
export const RICE_CONFIDENCE = [0.5,0.8,1] as const;
export const RICE_EFFORT = [0.5,1,2,3,5,8] as const;
export interface Rice { reach:number; impact:number; confidence:number; effort:number; }

// Фиксированная палитра цветов приоритетов (ключи → токены проекта)
export const PRIORITY_COLORS = ['red','amber','blue','green','purple','sky','gray','pink'] as const;
export type PriorityColor = (typeof PRIORITY_COLORS)[number];

// Источник требования (0..N на требование)
export interface SourceEntry {
  type: SourceType;
  name: string;              // 1..100
  priorityId: string;        // ссылка на SourcePriority.id справочника проекта
  rice?: Rice;               // опционально
  targetQuarter?: TargetQuarter;
  targetYear?: number;       // 2020..2100
  targetDate?: string;       // ISO yyyy-mm-dd, опционально
}

// Requirement получает:
//   sources?: SourceEntry[]   // присутствует только когда непусто (как scenarios)
//   releaseDate?: string      // ISO date; очищается при implemented===true
// Устаревшее source?: string сохраняется для чтения и мигрируется.

// Справочники проекта
export interface SourcePriority { id:string; name:string; color:PriorityColor; order:number; }
export interface SourceRef { id:string; name:string; type:SourceType; color?:PriorityColor; }
export interface ProjectDictionaries { priorities:SourcePriority[]; sources:SourceRef[]; }

// Дефолт при создании проекта:
//   priorities = [{ id, name:'Квартальная цель', color:'amber', order:0 }]
//   sources = []
```

### 0.2 Правила (`@po/core` `validation/`)
- `sources[]` через Zod; `name` 1..100 trim; `priorityId` непустой; `rice` — значения из шкал; `targetYear` 2020..2100; `targetDate` — валидная ISO-дата.
- `releaseDate`: при `implemented===true` очищается (как targetQuarter/Year). При `implemented===false` — опционально.
- Уникальность имён в справочниках (case-insensitive + trim): приоритеты между собой, источники между собой.

### 0.3 Скоринг (`@po/core` `scoring/`)
- `riceScore(r: Rice): number` = `round(reach*impact*confidence/effort, 0.1)`.
- `aggregateRiceScore(sources): number | undefined` = max по источникам с rice; иначе undefined.
- `aggregatePriorityId(sources, priorities): string | undefined` = priorityId источника с минимальным `order` (старший).
- `isDateInQuarter(dateISO, quarter, year): boolean` — для бледного предупреждения (не бросает).

### 0.4 Сериализация (`@po/core` `md/markdown.ts`)
- `sources`, `releaseDate` — в frontmatter; round-trip lossless.
- Миграция при чтении: если есть legacy `source:string` и нет `sources` → `sources=[{type:'TEXT', name:source, priorityId:<дефолтный приоритет проекта>}]`. Имя добавляется в справочник источников.

### 0.5 Хранение справочников (`apps/server`)
- Файл `Projects/<id>/dictionaries.json`; репозиторий `FsDictionariesRepo` (единственное место I/O).
- Создание проекта сеет дефолтный справочник.

### 0.6 REST-контракт (`apps/server` routes, все — Zod)
```
GET    /api/projects/:id/dictionaries                      → { priorities, sources }
POST   /api/projects/:id/dictionaries/priorities          {name,color}         → SourcePriority
PUT    /api/projects/:id/dictionaries/priorities/:pid      {name?,color?,order?}→ SourcePriority
DELETE /api/projects/:id/dictionaries/priorities/:pid?reassignTo=<pid>          → 204
POST   /api/projects/:id/dictionaries/sources             {name,type,color?}   → SourceRef
PUT    /api/projects/:id/dictionaries/sources/:sid         {name?,type?,color?} → SourceRef
DELETE /api/projects/:id/dictionaries/sources/:sid                              → 204
```
Требования: существующие `POST/PUT /requirements` принимают `sources[]`/`releaseDate`; сервер валидирует, что каждый `priorityId` есть в справочнике проекта (иначе 4xx доменной ошибкой).

---

## Эпик A — Множественные источники требования
Трассировка: ФТ-A1…A4, НФТ-2, НФТ-3.

### Стори S-A: Как PO, я хочу указывать несколько источников у требования (каждый со своим приоритетом/оценкой/сроком), чтобы честно отражать интересы разных заказчиков.
Критерии приёмки стори: у требования 0..N источников; сохранение/чтение lossless; старые данные мигрируют.

#### T-101 · Доменные типы sources/rice/dictionaries/releaseDate + палитра · [M] · Волна 1 · backend
- **Где:** `@po/core/domain/types.ts`.
- **Критерии:** типы из §0.1 добавлены; PRIORITY_COLORS(8); Requirement расширен `sources?`/`releaseDate?`; сборка core зелёная.
- **Зависимости:** blocks: T-102,103,104,105,110. **Трассировка:** ФТ-A1.

#### T-102 · Zod-схемы + правила (releaseDate, sources, справочники) · [M] · Волна 1 · backend · TDD
- **Где:** `@po/core/validation/schema.ts`, `rules.ts`.
- **Критерии:** тесты на: валидный/невалидный source; priorityId обязателен; rice из шкал; releaseDate очищается при implemented=true; уникальность имён в справочниках. Зелёные.
- **Зависимости:** blocked by: T-101; blocks: T-114. **Трассировка:** ФТ-A1, D3.

#### T-104 · Markdown round-trip для sources/releaseDate · [M] · Волна 1 · backend · TDD
- **Где:** `@po/core/md/markdown.ts` (+тест).
- **Критерии:** требование с 2 источниками (все поля) и releaseDate сериализуется и десериализуется без потерь; существующий round-trip тест расширен.
- **Зависимости:** blocked by: T-101. **Трассировка:** НФТ-2.

#### T-105 · Миграция legacy `source:string` → sources[0] TEXT · [S] · Волна 1 · backend · TDD
- **Где:** `@po/core/md/markdown.ts`.
- **Критерии:** `.md` со старым `source` и без `sources` читается → один источник TEXT с дефолтным priorityId; имя добавляется в справочник; данные не теряются.
- **Зависимости:** blocked by: T-101,110. **Трассировка:** ФТ-A4, НФТ-2.

---

## Эпик B — RICE-скоринг + агрегаты
Трассировка: ФТ-B1…B4, НФТ-1, НФТ-3.

#### T-103 · Модуль scoring (riceScore, aggregate*, isDateInQuarter) · [M] · Волна 1 · backend · TDD
- **Где:** `@po/core/scoring/` (новый).
- **Критерии:** riceScore(4,3,0.8,3)=3.2; aggregateRiceScore([3.2,2.4])=3.2; пусто→undefined; aggregatePriorityId по минимальному order; isDateInQuarter корректно (сент∈Q3). Unit-покрытие ≥90%.
- **Зависимости:** blocked by: T-101; blocks: T-205,206,207,209. **Трассировка:** ФТ-B1,B2,D3.

---

## Эпик C — Справочники проекта
Трассировка: ФТ-C1.1…C2.3, НФТ-4.

#### T-110 · FsDictionariesRepo + дефолт при создании проекта · [M] · Волна 1 · backend · TDD
- **Где:** `apps/server/repositories/`, wire в ProjectService.create.
- **Критерии:** read/write `dictionaries.json`; новый проект → один приоритет «Квартальная цель» (amber, order 0), sources=[]; тесты на temp-dir.
- **Зависимости:** blocked by: T-101; blocks: T-111,113. **Трассировка:** ФТ-C1.1.

#### T-111 · DictionariesService: CRUD приоритетов/источников, reassign, order · [M] · Волна 1 · backend · TDD
- **Где:** `apps/server/services/`.
- **Критерии:** add/rename/recolor/reorder/delete приоритета (delete с reassignTo переносит источники требований); CRUD источников; уникальность имён; тесты.
- **Зависимости:** blocked by: T-110. **Трассировка:** ФТ-C1.1,C1.4,C2.1.

#### T-112 · Routes /dictionaries (§0.6) · [M] · Волна 1 · backend · TDD
- **Где:** `apps/server/routes/dictionaries.ts` + app.ts.
- **Критерии:** все эндпойнты §0.6; Zod-валидация; error→status; integration-тесты happy + краевые (дубликат имени, delete без reassign используемого).
- **Зависимости:** blocked by: T-111; blocks: T-201. **Трассировка:** ФТ-C1.*,C2.*.

#### T-113 · Сид дефолтного справочника при create project · [S] · Волна 1 · backend · TDD
- **Критерии:** POST /api/projects создаёт dictionaries.json с дефолтом; тест.
- **Зависимости:** blocked by: T-110. **Трассировка:** ФТ-C1.1.

#### T-114 · Requirements принимают sources/releaseDate + проверка priorityId · [M] · Волна 1 · backend · TDD
- **Где:** `apps/server/services/requirement*`, routes.
- **Критерии:** create/update сохраняют sources/releaseDate; отклоняют неизвестный priorityId доменной ошибкой; integration-тесты.
- **Зависимости:** blocked by: T-102,110. **Трассировка:** ФТ-A1, C1.3.

#### T-115 · Автосбор имени источника в справочник при сохранении (страховка) · [S] · Волна 1 · backend · TDD
- **Критерии:** если имя источника требования отсутствует в справочнике — добавляется (тип из записи, дефолт TEXT); тест.
- **Зависимости:** blocked by: T-111,114. **Трассировка:** ФТ-C2.1.

---

## Эпик D — Сроки: пожелания источников + решение PO
Трассировка: ФТ-D1…D4. (Контракт — в T-101/102/103; ниже фронт.)

_Задачи фронта — в Волне 2 (T-206, T-207)._

---

## ВОЛНА 2 — Frontend (`apps/web`). Blocked by Волна 1 (контракт).

#### T-201 · API-клиент + React Query хуки для справочников · [M] · frontend
- **Где:** `api/endpoints.ts`, `api/hooks.ts`, `api/types.ts` (импорт типов из @po/core).
- **Критерии:** useDictionaries; мутации create/update/delete приоритета и источника; инвалидация; типобезопасно.
- **Зависимости:** blocked by: T-112. **Трассировка:** ФТ-C1.*,C2.*.

#### T-202 · Экран «Справочники» /p/:id/dictionaries · [L] · frontend
- **Где:** `pages/Dictionaries.tsx`, компоненты таблиц.
- **Критерии:** таблица приоритетов (название, цвет-пикер из палитры, порядок drag/стрелки, бейдж «дефолт», CRUD); таблица источников (имя, тип, цвет, CRUD); удаление используемого приоритета предлагает замену. data-testid на строки/кнопки.
- **Зависимости:** blocked by: T-201,210. **Трассировка:** ФТ-C1.1,C1.4,C2.1.

#### T-203 · Пункт навигации «Справочники» + маршрут · [S] · frontend
- **Где:** `App.tsx` (route), навигация проекта.
- **Критерии:** маршрут `/p/:id/dictionaries`; пункт меню рядом с Дерево/Дашборд/AI; активное состояние.
- **Зависимости:** blocked by: T-202. **Трассировка:** ФТ-C (меню).

#### T-204 · Модалка требования → вкладки, снять confirm на сохранении · [M] · frontend
- **Где:** `components/RequirementModal.tsx`.
- **Критерии:** вкладки Основное/Приоритизация/Описание и сценарии/Связи/Справочно; обычное сохранение без confirm; фокус/таб-навигация сохранены. data-testid на вкладки. (Пересекается с E3.)
- **Зависимости:** blocks: T-205,206. **Трассировка:** ФТ-E3, A2.

#### T-205 · Вкладка «Приоритизация»: список источников · [L] · frontend
- **Где:** `RequirementModal` (Приоритизация).
- **Критерии:** карточки источников (add/remove); тип-селект; **combobox поиска имени** по справочнику с подсветкой и «Создать новый источник» (**автосбор СРАЗУ при вводе** — создаёт запись справочника); селект приоритета из справочника + инлайн «Добавить свой вариант…» (название+цвет из палитры); RICE 4 селекта с живым score источника. data-testid.
- **Зависимости:** blocked by: T-201,204,210,103. **Трассировка:** ФТ-A2,A3,B1,C1.2,C2.1,D1.
- **Примечание:** RICE-вычисления импортируются из @po/core (T-103), не дублировать.

#### T-206 · Итог-агрегат + блок «Решение PO» + валидация даты · [M] · frontend
- **Где:** `RequirementModal` (Приоритизация).
- **Критерии:** строка «Итог» (приоритет=старший, RICE=max) живая; блок решения PO (quarter/year + releaseDate) со сводкой пожеланий источников; releaseDate скрыт при implemented=true; дата вне квартала → бледная янтарная подсветка + примечание, сохранение проходит. data-testid.
- **Зависимости:** blocked by: T-205,103. **Трассировка:** ФТ-B2,D2,D3.

#### T-207 · Дерево: колонки RICE/Источники/Срок · [M] · frontend
- **Где:** `components/TreeTable.tsx`.
- **Критерии:** колонка RICE (агрегат, сортировка, «—» в конец); колонка «Источники·приоритет» (старший источник + приоритет названием+цветом + «+N» с title); колонка «Срок реализации» двухуровневая (квартал/год / выпуск дата / «Реализовано»). data-testid.
- **Зависимости:** blocked by: T-103,210. **Трассировка:** ФТ-B2,B3,D4.

#### T-208 · Режим «По источникам» (срез) · [M] · frontend
- **Где:** `pages/Main.tsx` + компонент среза.
- **Критерии:** группировка по источнику; счётчики верхних приоритетов; требование с N источниками в N группах со своим приоритетом. data-testid.
- **Зависимости:** blocked by: T-207. **Трассировка:** ФТ (срез, из макета).

#### T-209 · Дашборд: топ-5 по RICE · [S] · frontend
- **Критерии:** блок топ-5 требований по агрегату RICE; корректно при пустых оценках.
- **Зависимости:** blocked by: T-103. **Трассировка:** ФТ-B4.

#### T-210 · Компоненты PriorityBadge + ColorPalettePicker · [S] · frontend
- **Где:** `apps/web/components/`.
- **Критерии:** PriorityBadge(name,color) — только название+цвет, без кодов, контраст ≥AA; ColorPalettePicker — фиксированный набор PRIORITY_COLORS из токенов; тёмная тема. Компонентные тесты.
- **Зависимости:** blocks: T-202,205,207. **Трассировка:** ФТ-C1.3, НФТ-5.

---

## Трек E — Look-n-feel (`apps/web`, БЕЗ контрактов). Параллельно Волне 1/2, всё сразу.
Трассировка: ФТ-E1…E8, norman-review.md.

- **T-E1** · Действия строки дерева видимы всегда (не opacity-0), доступны с клавиатуры/тача · [S].
- **T-E2** · Шапка главного: имя проекта крупно и первым, путь — вторично · [S].
- **T-E3** · Вкладки модалки + снятие confirm (реализуется T-204; здесь — прочие модалки/консистентность) · [S].
- **T-E4** · 100% Lucide-иконки вместо эмодзи/символов (Start, дерево) · [M].
- **T-E5** · Иконки «добавить ФТ/НФТ» различать формой (Plus/ShieldPlus) · [S].
- **T-E6** · Развести Toast и FAB чата по углам (z-index, offset) · [S].
- **T-E7** · Дропзона импорта: dragover-подсветка, автоимя из файла, прогресс · [M].
- **T-E8** · Start: недавние проекты; читаемость чипов связей (≥12px); объяснения дизейбла текстом · [M].
- **Критерии всего трека:** визуальные регрессы обновлены; a11y не хуже; data-testid где нужно для e2e.
- **Зависимости:** независимы (кроме T-E3 ↔ T-204). **Владелец:** frontend.

---

## ВОЛНА 3 — QA (`e2e/`, Playwright). Blocked by Волна 2.

- **T-301** · Множественные источники: добавить 2, сохранить, переоткрыть — данные на месте (round-trip) · blocked by: T-205,114.
- **T-302** · RICE: заполнить, проверить score источника, агрегат в модалке и колонке дерева, сортировку · blocked by: T-206,207.
- **T-303** · Справочники: дефолт=«Квартальная цель»; добавить приоритет (название+цвет); удалить используемый с заменой · blocked by: T-202.
- **T-304** · Combobox источника: поиск/подсветка, автосбор сразу при вводе (новое имя появилось в справочнике) · blocked by: T-205,202.
- **T-305** · Валидация даты вне квартала — бледное предупреждение, сохранение проходит; releaseDate скрыт при implemented=true · blocked by: T-206.
- **T-306** · Дерево: двухуровневая колонка срока + срез «По источникам» · blocked by: T-207,208.
- **T-307** · Обновить эталонные скриншоты под look-n-feel (E1–E8) · blocked by: T-E1…E8.
- **Критерии:** happy-path + краевые; серийный прогон зелёный; трассировки в тестах.

---

## Финал (оркестратор, после Волны 3)
- Прогон: `format:check → lint → typecheck → npm test (coverage ≥90%) → e2e`; фиксы.
- `docs/RELEASE_NOTES.md` — запись о доработках todo_19.
- `graphify update .`
- Коммит: ТОЛЬКО файлы задачи (не тащить demo-out/, extract-out/ и пр. untracked). Пуш — по явной просьбе.

---

## Рекомендуемый порядок (волны)
- **Волна 1 (backend, параллельно внутри):** T-101 → {T-102, T-103, T-104}; T-110 → {T-111, T-113}; затем T-105, T-112, T-114, T-115. Трек E можно начинать здесь же (frontend, независим).
- **Волна 2 (frontend, после контракта):** T-210 → {T-202, T-207}; T-201; T-203; T-204 → {T-205 → T-206}; T-208; T-209. Трек E-* параллельно.
- **Волна 3 (QA, после UI):** T-301…T-307.
- **Финал:** прогон/фиксы/RELEASE_NOTES/graphify/commit.

## Сводка
Эпиков: 5 (A–E) · Задач: контракт §0 + 27 (T-101…T-115, T-201…T-210, T-E1…E8, T-301…T-307).
Волна 1 (backend): 10 · Волна 2 (frontend): 10 · Трек E: 8 · Волна 3 (QA): 7.
Параллелизуемо сразу: ядро контракта (T-101) разблокирует всё; трек E полностью независим.
Открытых `[ОТКРЫТО]` нет — все развилки закрыты на гейтах PO.
