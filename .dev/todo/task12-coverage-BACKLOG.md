# Task 12 · Единый BACKLOG по покрытию тестами (сведение отчётов Архитектора и Senior PO)

Входы: `.dev/todo/task12-coverage-architect.md` (ARC-T1..T5) + `.dev/todo/task12-coverage-po.md`
(PO-T1..T6). Дедупликация и владельцы — ниже. Треки НЕЗАВИСИМЫ (без новых контрактов),
выполняются параллельно: backend / frontend / QA.

## Трек B — backend (packages/core + apps/server + их тесты)

**B-1 (P1, из ARC-T2 + PO-T2 + PO-T4 + ARC-T4 + PO-T1-server):**
1. Error-ветки AI-импорта (ARC-T2): дубликат имени из AI → skip+warn+счётчики, job до done;
   невалидная CHILD_OF → warn, импорт не падает; архив > maxDocFiles → ArchiveError, tmp удалён;
   corrupt tar.gz; пустой `content` апстрима → AiUpstreamError (generate И chat).
   Цели: AiImportService ≥95 st, unpack.ts ≥85 br, AiHubService br ≥90.
2. Живучесть AI-импорта (PO-T2): инжектированный сбой между созданием требований и связей →
   проект валиден (нет висячих ссылок), job failed с понятным сообщением; повторный запуск после
   сбоя достраивает без дублей; GET несуществующего/потерянного jobId → 404 (подтвердить тестом,
   что формат ошибки распознаваем клиентом).
3. Байт-детерминизм экспорта (PO-T4): openspec дважды → байт-в-байт; полный архив без выбора
   полей == архив со «все поля выбраны» байт-в-байт; re-import → повторный экспорт идентичен.
4. Perf NFR-3, серверная часть (PO-T1): бенч на 1000 требований — CRUD (create/update/delete
   с записью файла) и list; целевой критерий ТЗ p95 < 200 мс; если на референсной машине
   недостижим — зафиксировать фактические числа в отчёте (порог теста = факт с запасом),
   решение по корректировке ТЗ примет оркестратор. Выровнять бюджет perf.test.ts с итогом.
5. Микро-ветки server/lib (ARC-T4): parseInput, projectName, logger — br ≥75 по server/lib.

## Трек F — frontend (apps/web)

**F-1 (P1, ARC-T1):** RequirementModal — component-тесты link-секций ФТ/НФТ (пустое состояние,
список, пикер, удаление связи), ветки ошибок (uniqueness, отказ API). Цель ≥85 st / ≥80 fn.

**F-2 (P2, ARC-T3 + PO-T2-ui):**
1. TreeToolbar dropdown «Источник» (выбор/сброс/счётчик) → fn ≥80.
2. RequirementPickerModal br ≥85; ExportTasksModal ≥90 st; Import — ветки ошибок загрузки.
3. useFocusTrap br ≥85 (граничные ветки Tab/Shift+Tab); GraphLegend/graphEdgeStyles ветки.
4. PO-T2-ui: потеря job AI-импорта (GET → 404 после рестарта сервера) → UI переводит модалку в
   состояние ошибки с «Повторить анализ», а НЕ вечный прогресс; component-тест.

## Трек Q — QA (e2e/ + playwright.config)

**Q-1 (P2, PO-T3):** a11y новых AI-поверхностей: axe-скан экрана AI, открытого чат-виджета,
модалки AI-импорта, модалки экспорта — 0 serious/critical; e2e клавиатурного доступа: FAB чата
открывается Enter/Space, фокус внутри виджета, Esc закрывает; focus-trap модалки AI-импорта в
running (X → ConfirmDialog). Найденные a11y-нарушения НЕ чинить (frontend-зона) — зафиксировать.

**Q-2 (P2, PO-T5 + PO-T1-e2e):** scale-e2e на ~1000 требований (seed через API): раскрытие,
поиск, мультиселект-фильтр, открытие модалки — без таймаутов и h-scroll; замер первичного
рендера Main (цель ТЗ 1.5 с — мерить и логировать; жёсткий гейт-порог выбрать не-флаки,
напр. ×3 запас, чтобы CI не мигал; фактические числа в отчёт).

**Q-3 (P3, PO-T6 + ARC-T5):** @smoke для AI-поверхностей в webkit-smoke/firefox-smoke
(FAB виден и открывает виджет; экран AI рендерится). Отметить в отчёте, что CI ставит только
chromium — правку .github/workflows/ci.yml сделает оркестратор.

## Вне действий (осознанно, из отчётов)
App.tsx/Main.tsx/Dashboard.tsx колбэки (покрыты e2e), store/chat fn-остаток, GraphView/types,
core schema.ts 1 ветка, пасхалка DOOM. Задач «ради 100%» нет.
