# Аудит покрытия автотестами — пробелы и задачи

Дата: 2026-07-03. Метод: `vitest run --coverage` по каждому воркспейсу + инвентаризация e2e.

## Итог по воркспейсам

| Воркспейс | Statements | Branches | Вердикт |
|-----------|-----------|----------|---------|
| `packages/core` | ~99% | ≥97% | ✅ отлично, гейт ≥90 выполнен |
| `apps/server` | ~97% | ≥93% | ✅ отлично |
| `apps/mcp` | 98.8% | 93.3% | ✅ отлично |
| `apps/web` | 60.7%* | 82.6% | ⚠️ пробелы в unit (см. ниже) |

\* низкий web-stmts объясняется тем, что `api/client.ts`, `api/endpoints.ts`, `pages/Main.tsx`
покрываются **e2e** (Playwright), а не unit — но unit-веток ошибок у них нет.

e2e: 16 spec-файлов (happy-path, projects, requirements, links, import/export, graph-view,
a11y, cross-browser, scale, edge-cases, xlsx-export, tree-visibility, iteration6, po-ux,
layout-overlap, stale-boundary) — сценарии продукта покрыты.

## Пробелы (только web unit) → задачи

### Кластер A — утилиты, api-клиент, стор
- **T-A1 `lib/tree.ts`** — 16.66% st, 0% fn. Чистая функция построения дерева — покрыть все ветки.
- **T-A2 `api/client.ts`** — 23.88% st, 42% fn. Юнит-тесты на построение запроса, `ApiError`,
  `errorMessage()` (сетевые/JSON/HTTP-ошибки). Happy-path уже в e2e.
- **T-A3 `api/endpoints.ts`** — 25.6% st, 0% fn. Проверить формируемые URL/параметры каждого метода.
- **T-A4 `store/ui.ts`** — 86.95% st, **61% br**. Действия/ветки Zustand-стора (открытие модалок,
  выбор проекта, раскрытие узлов, тема).
- **T-A5 `lib/plural.ts`** (84%), **`lib/linkRules.ts`** (84% — строки 47-48, 62-64).

### Кластер B — компоненты
- **T-B1 `GraphView/GraphToolbar.tsx`** — **16.66% br**. Колбэки кнопок тулбара (перерасставить,
  вписать, тогглы НФТ/типов связей).
- **T-B2 `LinkList.tsx`** — 71% st. Рендер списка связей + удаление связи.
- **T-B3 `GraphView.tsx`** — 33% fn, 78% st. Оставшиеся обработчики (выбор узла, режимы).
- **T-B4 `ExportModal.tsx`** — 84% st. Ветки выбора формата (zip/targz/xlsx/openspec).
- **T-B5 `badges.tsx`** (62% br), **`PathHeader.tsx`** (funcs 50%) — мелкие ветки/пропсы.

## Не требуют действий
`ServiceScreen.tsx` 100%, `requirementForm.ts` 100%, `useNameCheck` 100%, `criticality`/
`linkTypes`/`useDebounce`/`contrast`/`treeLines`/`visibility` 100%, все страницы ≥80% (+e2e).
Server-ветки (`archive.ts` 71-78, `LinkService` 70/115) — уже ≥93%, ниже порога усилий.
