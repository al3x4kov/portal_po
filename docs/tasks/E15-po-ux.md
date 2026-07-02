# E15 — UX-доработки по Senior PO (постановка Архитектора)

Основание: `docs/po/UX-review.md` (T1–T5). Все фичи — в рамках существующих функций.
Разработка от тестов (TDD). Ниже — по фиче: слой, задачи, критерии, data-testid.

## Проверка архитектуры (Архитектор)
- Слой видимости (`apps/web/src/lib/visibility.ts`) уже единый — фильтр «Реализация»
  добавляется как ещё один предикат, без нового механизма (согласуется с A6#4).
- Удаление связей: API `DELETE /api/projects/:id/links` и хук `useDeleteLink` УЖЕ есть —
  нужна только UI-привязка. `requirement.links` уже приходит в модалку — данные для показа есть.
- Добавление НФТ из строки ФТ: композиция существующих `useCreateRequirement` +
  `useCreateLink` (тип `BLOCKED_BY`, источник — ФТ). Нового бэкенда не требуется.
- Excel-вид: переработка `ExcelExportService` (только сервер), контракт эндпоинта не меняется.
Изменений в доменном ядре/схемах не требуется.

---

## T1 · Фильтр по «Реализация» (FE) — HIGH
- `store/ui.ts`: `implementationFilter: Set<'DONE'|'PLANNED'>` (+ setter), по аналогии с
  `criticalityFilter`.
- `lib/visibility.ts`: `computeVisibleRows` принимает `implementationFilter`; предикат
  `matchesSelf`: `DONE` = `implemented===true`, `PLANNED` = `implemented===false`. Комбинируется
  (AND) с поиском и фильтром критичности; предки видимых — как контекст.
- `components/TreeToolbar.tsx`: мультиселект-дропдаун (как критичность): `impl-filter`,
  опции `impl-opt-done` / `impl-opt-planned`, `impl-apply` / `impl-reset`, бейдж-счётчик
  `impl-count`.
- **Unit:** `lib/visibility.test.ts` — фильтр PLANNED показывает только плановые + предков;
  DONE — только реализованные; совместно с поиском/критичностью без «сирот».
- **Приёмка:** см. T1 в UX-review.

## T2 · Связи в карточке требования (FE) — HIGH
- `components/RequirementModal.tsx` (режим редактирования): блок «Связи» `req-links`.
  Пропустить `nameBySlug` из `Main` в модалку. Рендер каждой связи: человекочитаемо
  (`LINK_TYPE_LABEL[type]` + «название цели»), `data-testid="req-link-<targetSlug>"`,
  `data-link-type`. Пустое состояние `req-links-empty` («Связей нет»).
- **Unit:** модалка с требованием, имеющим связи, показывает их; без связей — пустое состояние.

## T3 · Удаление связи (FE) — HIGH
- В блоке «Связи» у каждой связи — кнопка `req-link-del-<targetSlug>` → инлайн-подтверждение
  `req-link-del-confirm` (как у удаления требования). Удаление через `useDeleteLink`
  (`{ sourceSlug: requirement.slug, type, targetSlug }`); инвалидация запросов обновляет список.
- **Unit:** клик по удалению → подтверждение → вызов мутации с корректным input; после успеха
  связь исчезает.
- **Приёмка:** удаляется реципрокная пара (проверяется в e2e у обоих концов).

## T4 · Добавить НФТ из строки ФТ, preset BLOCKED_BY (FE) — MEDIUM
- `components/TreeTable.tsx`: в строке ФТ (type==='FUNCTION') действие `row-add-nfr` (+ `data-slug`).
- `pages/Main.tsx`: новый режим модалки `{ kind:'requirement', reqType:'NFR', linkFrom:<ftSlug>,
  linkType:'BLOCKED_BY' }`. Модалка показывает подсказку `nfr-from-ft-hint` («Будет связано:
  «<ФТ>» блокируется этим НФТ»). После успешного создания НФТ (возвращает slug) —
  `useCreateLink({ sourceSlug: ftSlug, type:'BLOCKED_BY', targetSlug: newSlug })`.
- **Направление связи (решение Архитектора):** источник — ФТ, тип — `BLOCKED_BY`, цель — НФТ.
- **Unit:** режим показывает подсказку; сабмит создаёт НФТ и затем связь с верным input (моки).
- **Приёмка:** см. T4 в UX-review; в карточке ФТ (T2) связь видна.

## T5 · Excel-экспорт «как в UI» (BE) — MEDIUM
- Переписать `apps/server/src/services/ExcelExportService.ts`: **один лист «Требования»**,
  повторяющий таблицу портала.
  - Порядок строк: секция ФТ в порядке дерева (корни → потомки, DFS), затем секция НФТ.
    Иерархия — по связям PARENT_OF/CHILD_OF; глубина → отступ (Excel `alignment.indent`
    или ведущие пробелы) в колонке «Требование».
  - Колонки: `Требование` (с отступом), `Тип` (ФТ/НФТ), `Критичность` (Low…Blocker, текст),
    `Реализация` (`Реализовано` или `Q3 2026`), `Описание`, `Связи` (человекочитаемо: типы +
    названия целей через `;`).
  - Шапка жирным; по возможности — фон/цвет ячейки критичности. Валидный `.xlsx` (exceljs).
  - Один лист достаточно; отдельный «сырой» лист связей убрать.
- Вспомогательный порядок-дерева и разрешение имён целей — в сервисе (из `Requirement[]`).
- **Unit:** `apps/server/test/excel-export.test.ts` — 1 лист «Требования», корректные заголовки,
  число строк = число требований, потомок идёт после родителя с бóльшим отступом, «Связи»
  словами, «Реализация»/«Критичность» текстом. Эндпоинт `GET /export.xlsx` — 200, сигнатура
  `PK\x03\x04` (существующий тест адаптировать).

---

## E2E (Playwright, QA) — T-1502
Покрыть: T1 (фильтр DONE/PLANNED + комбинации), T2 (открыть ФТ со связью — видно),
T3 (удалить связь — исчезла у обоих концов), T4 (из строки ФТ создать НФТ — появилось + чип
BLOCKED_BY на ФТ), T5 (скачать .xlsx — валиден). Использовать data-testid ниже.

## Контракт data-testid (для FE и QA)
`impl-filter`, `impl-opt-done`, `impl-opt-planned`, `impl-apply`, `impl-reset`, `impl-count`;
`req-links`, `req-links-empty`, `req-link-<targetSlug>` (+`data-link-type`),
`req-link-del-<targetSlug>`, `req-link-del-confirm`; `row-add-nfr` (+`data-slug`),
`nfr-from-ft-hint`. Экспорт — прежний `export-xlsx`.

## DoD
Зелёные: `format:check` → `lint` → `typecheck` → unit(+coverage пороги) → e2e. Границы фич
соблюдены (T1–T4 — `apps/web`; T5 — `apps/server`).
