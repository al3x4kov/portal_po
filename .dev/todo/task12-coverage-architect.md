# Task 12 — Архитекторский аудит покрытия тестами

Дата: 2026-07-04. Метод: `npx vitest run --coverage` (92 файла, **845 тестов, все зелёные, гейты пройдены**, exit 0) + агрегация `coverage/coverage-summary.json` + инвентаризация e2e (22 spec) + проверка `vitest.config.ts` / `.github/workflows/ci.yml`.

## 1. Фактическое покрытие по воркспейсам (2026-07-04)

| Воркспейс | Stmts | Branches | Funcs | Гейт (st/br/fn) | Вердикт |
|---|---|---|---|---|---|
| `packages/core` | 99.65 | 96.64 | 100 | 90/90/90 | OK |
| `apps/server` | 96.55 | 90.02 | 97.06 | 80/70/80 | OK |
| `apps/mcp` | 98.81 | 93.33 | 100 | 90/88/85 | OK |
| `apps/web` | 92.44 | 87.59 | 80.00 | 82/78/62 | OK (было 60.7 st на 2026-07-03) |
| **Итого** | **94.04** | **89.22** | **86.25** | — | — |

CI (`ci.yml`): format → lint → typecheck → unit (`npm test` = vitest c coverage-гейтами) → e2e (Playwright, **только chromium**, артефакты при падении). Порядок и гейты соответствуют CLAUDE.md.

## 2. Верификация прошлых задач (аудит 2026-07-03)

### T-A*/T-B* (web unit) — ВСЕ ЗАКРЫТЫ

| Задача | Было | Стало | Статус |
|---|---|---|---|
| T-A1 `lib/tree.ts` | 16.7 st | 100/100 | ✅ |
| T-A2 `api/client.ts` | 23.9 st | 100/100 | ✅ |
| T-A3 `api/endpoints.ts` | 25.6 st | 95.1 st / 90.3 br | ✅ |
| T-A4 `store/ui.ts` | 61 br | 100 st / 96.4 br | ✅ |
| T-A5 `plural`/`linkRules` | 84 | 100 / ≥90 | ✅ |
| T-B1 `GraphToolbar` | 16.7 br | 100/100 | ✅ |
| T-B2 `LinkList` | 71 st | 100 st / 90 br | ✅ |
| T-B3 `GraphView` | 33 fn | ≥98 | ✅ |
| T-B4 `ExportModal` | 84 st | 100 st / 97.8 br | ✅ |
| T-B5 `badges`/`PathHeader` | 62 br / 50 fn | 100/100 | ✅ |

### QA-* из ревью коллегии (2026-07-02) — проверено по файлам, не по ревью

| Пункт | Статус | Доказательство |
|---|---|---|
| QA-1 a11y | ✅ сделано | `e2e/tests/a11y.spec.ts`: 5 axe-сканов + блок «QA-1 · focus-trap, Esc and focus return (UX-5)»; хук `apps/web/src/hooks/useFocusTrap.ts` |
| QA-2 perf-бюджеты | ✅ сделано | `apps/server/test/perf.test.ts` (500 требований, p50 ≤ 800ms, hard cap 2s); `apps/web/src/lib/visibility.perf.test.ts`; `e2e/tests/scale.spec.ts` (~300 узлов, поиск/фильтр/no h-scroll) |
| QA-4 / BE-10 web-гейт | ✅ сделано | `vitest.config.ts`: `apps/web/src/**` в include + threshold 82/78/62; CI unit-job гоняет `npm test` |
| QA-6 error-handler | ✅ сделано | `apps/server/test/error-handler.test.ts` (5 тестов); `app.ts` br 87.5 (не покрыты только строки 39, 66) |
| QA-7 флаки | ✅ сделано | `playwright.config.ts:80` `retries: 0` с комментарием «QA-7: flaky budget is zero»; `layout-overlap.spec.ts` переписан на устойчивый допуск |
| QA-8 security импорта | ✅ сделано | `apps/server/test/archive-security.test.ts`: tar.gz path-traversal, zip entry-count bomb-guard, лимит распакованного размера zip И tar.gz, schemaVersion (ARCH-5) |
| QA-9 cross-browser | ⚠️ частично | `cross-browser.spec.ts` есть, но CI ставит только chromium (`npx playwright install ... chromium`) → firefox/webkit в CI не гоняются |

## 3. AI-фичи (tasks 8–11) — покрытие отдельно

Server: `routes/ai.ts` 100/100 · `AiHubService` 100 st / **85.4 br** · `AiImportService` **90.7 st / 88.9 br** · `AiImportJobs` 100/100 · `aiImportPrompt` 100/97.7 · `openaiClient` 100/91.3 · `AiConfigRepo` 100/90.3 · `routes/aiImport` 95.1/88.9 · `lib/unpack.ts` **86.6 st / 75 br**.
Тесты: `ai-hub-service`, `ai-routes`, `ai-tls`, `ai-config-repo`, `ai-prompt`, `ai-import-service`, `ai-import-routes`, `ai-import-prompt`, `openai-client` (все в `apps/server/test/`).

Web: `api/hooks.ts` 100/95.4 · `ChatWidget` 95.4/87 · `AiImportModal` 98.2/89 · `AiPage` 94.4/84.1 (fn 65) · `store/chat.ts` 100/100.

E2E: `ai-hub.spec.ts` (навигация, конфиг ключ/baseURL/модели, генерация+append, без конфига, ошибка апстрима; Task 10 — удаление ключа), `chat-widget.spec.ts` (Task 9, вкл. ошибку апстрима с сохранением истории), `ai-import.spec.ts` (Task 11).

**Вывод: AI-фичи покрыты хорошо на всех слоях.** Остаточные дыры — конкретные error-ветки (см. ARC-T2).

## 4. E2E-инвентаризация (22 spec)

happy-path, projects, requirements, links, import-export, graph-view, a11y, cross-browser, scale, edge-cases, xlsx-export, tree-visibility, iteration6, po-ux, layout-overlap, stale-boundary, smoke, export-fields, filter-groups, ai-hub, ai-import, chat-widget. Все основные пользовательские потоки, включая новые AI-потоки, покрыты. Единственная дыра — matrix браузеров в CI (см. ARC-T5).

## 5. API-контракты (REST + MCP)

REST-роуты (`apps/server/src/routes/requirements.ts` и др.) и MCP (`apps/mcp/src/tools.ts`) импортируют **единый источник** — `packages/core/src/validation/contracts.ts` (`requirementCreateShape/Schema`, `requirementUpdateShape`, `linkInputShape`) — структурный дрейф контрактов исключён по построению (ARCH-4 закрыт). `openapi.test.ts` проверяет, что задокументирован каждый REST-путь, схемы компонент и query-параметры. MCP `tools.test.ts` (23 теста) проверяет маппинг `DomainError → fail(code, details)`. Отдельный parity-тест REST↔MCP **не требуется**.

## 6. Задачи

### ARC-T1 · Покрыть link-секции и обработчики RequirementModal · frontend · P1 · M
`apps/web/src/components/RequirementModal.tsx` — 75.9 st / 79.5 br / 63.3 fn, крупнейшая дыра web; не покрыт хвост ~строки 800–893 (секции связей ФТ/НФТ внутри модалки) и часть обработчиков. Это центральный компонент редактирования (~900 строк), e2e гоняет только happy-path.
- [ ] component-тесты: рендер секций связей ФТ/НФТ (пустое состояние, список, открытие пикера, удаление связи из модалки)
- [ ] ветки ошибок (uniqueness-check, отказ API при сохранении связи/требования)
- [ ] файл ≥85 st / ≥80 fn

### ARC-T2 · Error-ветки AI-импорта и лимиты unpack · backend · P1 · S
Единственные существенные дыры AI-фич — пути деградации:
`AiImportService.ts` (строки ~444–453, 467–476): DomainError при создании требования и при создании CHILD_OF-связи — ветка «warn-лог + продолжение задания + счётчики» не проверена;
`lib/unpack.ts` (строки ~115, 120–122, 125–127): превышение `maxDocFiles`, «Corrupt tar.gz», cleanup-rethrow — лимиты безопасности не проверены;
`AiHubService.ts` (br 85.4, строки 136/143/179/184): ветки `content ?? null` / пустой ответ апстрима для generate и chat.
- [ ] тест: дубликат имени в ответе AI → требование пропущено c warn, задание доходит до done, счётчики верны
- [ ] тест: невалидная CHILD_OF-связь → warn, связи нет, импорт не падает
- [ ] тест: архив с > maxDocFiles doc-файлов → ArchiveError, temp-каталог удалён
- [ ] тест: пустой `choices[0].message.content` → AiUpstreamError (generate и chat)
- [ ] `AiImportService` ≥95 st, `unpack.ts` ≥85 br

### ARC-T3 · Ветки фильтров/пикеров и мелкие web-хвосты · frontend · P2 · M
Один проход по компонентным веткам с реальной логикой:
`TreeToolbar.tsx` (82.1 st / fn 64.3, строки ~502–576 — dropdown фильтра «Источник»: открытие, выбор, счётчик, сброс; e2e filter-groups покрывает частично);
`RequirementPickerModal.tsx` (br 74); `ExportTasksModal.tsx` (88.4/81.4); `Import.tsx` (br 76.5, fn 54 — ветки ошибок загрузки файла);
`useFocusTrap.ts` (br 72.4, строки 83–85 — a11y-критичный хук, граничные ветки Tab/Shift+Tab);
GraphView-мелочь: `GraphLegend.tsx` (br 66.7, строка 99), `graphEdgeStyles.ts` (77.8/71.4, строки 46–55).
- [ ] TreeToolbar: тесты dropdown «Источник» (выбор/сброс/счётчик) → fn ≥80
- [ ] RequirementPickerModal br ≥85; ExportTasksModal ≥90 st; Import ветки ошибок
- [ ] useFocusTrap br ≥85; GraphLegend/graphEdgeStyles ветки стилей рёбер

### ARC-T4 · Микро-ветки server/lib · backend · P3 · S
`parseInput.ts` (br 50, строки 11–12 — ветка невалидного входа), `projectName.ts` (br 50, строки 29–30), `logger.ts` (85.4 st, строки 94–99). Ветки маленькие, но это общий парсинг входа всех роутов.
- [ ] parseInput: невалидный JSON/схема → корректная ошибка
- [ ] projectName/logger: недостающие ветки
- [ ] server/lib без файлов с br < 75

### ARC-T5 · Cross-browser smoke в CI · QA · P3 · S
`cross-browser.spec.ts` существует, но CI ставит только chromium — spec фактически не гоняется на firefox/webkit (QA-9 остался). Либо включить, либо зафиксировать решение.
- [ ] в CI e2e-job добавлен smoke-прогон firefox и/или webkit (`playwright install --with-deps firefox webkit` + отдельный project)
- [ ] или ADR/пометка «desktop-chromium-only» и удаление мёртвого spec из ожиданий

### Не требует действий (осознанно)
`App.tsx` (52.8 st) — чистая обвязка роутера/провайдеров, покрыта каждым e2e; `Main.tsx` (fn 38.9) и `Dashboard.tsx` (fn 50) — колбэки покрыты e2e (happy-path, graph-view, po-ux); `store/chat.ts` fn 75 и `AiImportJobs` fn 88.9 — остаток без логики; `GraphView/types.ts` — типы; core `schema.ts` br 66.7 — 1 ветка из 3, ниже порога усилий. Задач «ради 100%» не ставим.
