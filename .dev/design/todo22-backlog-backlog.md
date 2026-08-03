# Бэклог: todo_22 — AI-импорт бэклога из xlsx

Вход: `.dev/design/todo22-backlog-spec.md` (решения PO в разделе 6) + макеты
`design-out/todo22/` (4 экрана, включая 04-review «Выверка разметки»).
Ревью: спек полный, блокирующие вопросы закрыты гейтом PO; допущения — в задачах.

**Инварианты (todo_21/22):** контракт только в `@po/core`, владелец — backend-агент;
владение: backend = core+server, frontend = apps/web, QA = e2e/; TDD; graphify-first.
**Максимальный реюз todo_20:** джобы/чекпоинты/resume/история/лог, aiCall
(ретраи/таймауты/параллелизм), structured output с фолбэком, таксономия ошибок,
ReportBuilder, дедуп-утилиты. Ничего из этого не дублировать — расширять.

---

## Архитектурные решения

### Поток джобы (kind='backlog', та же машина AiImportJobs)

```
POST /api/projects/:id/ai-backlog-import (multipart xlsx)
  → stage parse (детерминированно): строки, колонки (ключ/текст/срок), предпросмотр
  → status 'awaiting-confirmation'  ← реюз статуса: preview+мини-смета в view
POST /api/ai-import/:jobId/confirm  {targetQuarter?, targetYear?}   ← общий target
  → stage match: батчи ≤20 → разметка (existing/new узлы, дубли, NFR)  [чекпоинты]
  → status 'awaiting-review'  ← НОВЫЙ статус: полная разметка в view, записи НЕТ
POST /api/ai-import/:jobId/apply  {rowIds: string[]}                ← выбор строк
  → stage populate: новые узлы → требования → связи → источники      [идемпотентно]
  → succeeded + отчёт
```

Cancel валиден на любом шаге; resume (todo_20) — для match/populate; статусы
`awaiting-confirmation`/`awaiting-review` персистятся в чекпоинт (переживают рестарт,
после рестарта видны как та же пауза, НЕ interrupted).

### xlsx-парсинг — без тяжёлой зависимости

`adm-zip` (уже есть) + **`fast-xml-parser`** (новая маленькая dependency сервера,
MIT, zero-deps) для `xl/worksheets/sheet1.xml` + `xl/sharedStrings.xml`. Нужны только
текстовые ячейки: shared strings, inline strings, числа/даты (для target-колонки —
serial date xlsx конвертировать). Merged cells/формулы — берём кэшированное значение
`<v>`. Любой не-парсящийся файл → DATA-код, сервер не падает (Н6).
[ДОПУЩЕНИЕ: только первый лист; если пуст — понятная ошибка.]

### Контракт (@po/core) — все изменения

1. **`SourceType` += `'BACKLOG'`** (`domain/types.ts` + все места, где перечислены
   типы: Zod-схемы, markdown-сериализация, тесты). Обратная совместимость чтения
   старых .md обязательна.
2. `ai.ts`:
   - `AI_BACKLOG_MAX_BYTES = 10 МБ`, `AI_BACKLOG_MAX_ROWS = 5000`, батч ≤20;
   - `aiBacklogColumnsSchema` `{keyColumn?: string, textColumn: string,
     targetColumn?: string}` (буква+заголовок для UI-чипов);
   - `aiBacklogPreviewSchema` `{columns, sampleRows: [{rowId, key?, text}] (≤5),
     totalRows, skippedRows, estimate {calls, tokens}, fileName, defaultTarget
     {quarter, year}}`;
   - `aiBacklogMappingSchema` `{rowId, key?, sourceText, businessName,
     type: FUNCTION|NFR, parent: {kind:'existing'|'new', name, parentName?: string|null},
     duplicateOf?: string, targetQuarter, targetYear, targetFromFile: boolean}`;
   - `aiBacklogReviewSchema` `{mappings: [...], newNodes: [{name,
     parentName: string|null, rowCount}], duplicates: number}`;
   - `aiBacklogReportSchema` `{rowsTotal, rowsSelected, created {functions, nfrs,
     links, newNodes}, duplicatesSkipped, deselected, usage}`;
   - job view: `kind: 'docs'|'backlog'` (дефолт 'docs' — старые клиенты живут),
     `backlogPreview?`, `backlogReview?`, `backlogReport?`; статус `'awaiting-review'`;
   - `aiImportJobSummarySchema` += `kind`;
   - роут-схемы: confirm body `{targetQuarter?, targetYear?}` (для kind='backlog'),
     apply body `{rowIds: string[] (1..5000)}`;
   - коды ошибок += `DATA-04` («В файле не найдена колонка с формулировками —
     проверьте, что это выгрузка бэклога», category data, не resumable),
     `DATA-05` («Файл не читается как xlsx…»).
3. Правило populate: новые узлы и требования создаются `implemented=false` +
   target (из строки или общий) + `sources: [{type:'BACKLOG',
   name:'Бэклог: <файл>', priorityId: <дефолтный приоритет словаря>}]`;
   описание = исходная формулировка + `\n\nКлюч бэклога: <key>` (если есть).

---

## Эпик E1: Контракт и парсер · Трассировка: П2, решения PO №3–4

#### T-301 · Контракт @po/core: SourceType BACKLOG + схемы бэклог-джобы · [M] · блокирует всё
- **Что:** п.1–3 «Контракта» выше; unit-тесты схем; markdown round-trip с
  source type BACKLOG; старые view/конфиги валидны (kind дефолтится в 'docs').
- **Где:** `packages/core/src/domain/types.ts`, `validation/ai.ts`,
  `validation/schema.ts`, `md/markdown.ts` (+тесты).
- **Критерии приёмки:**
  - [ ] Требование с источником BACKLOG сериализуется в .md и читается обратно без потерь.
  - [ ] Старые джоб-view без kind парсятся (kind='docs'); покрытие core ≥90%.
  - [ ] Роут-схемы confirm/apply валидируют границы (rowIds ≤5000, target-диапазоны).

#### T-302 · xlsx-ридер + распознавание колонок + target из файла · [L] · после T-301
- **Что:** `apps/server/src/services/aiImport/xlsx.ts`: adm-zip + fast-xml-parser
  (добавить dependency); shared/inline strings; выбор колонок по СОДЕРЖИМОМУ:
  ключ (паттерн `[A-ZА-Я]+-\d+` ≥60% непустых или заголовок Key/Issue key/ID/Ключ),
  текст (самая содержательная текстовая колонка или Summary/Название/Тема/Формулировка),
  срок (заголовок due/target/fix version/срок ИЛИ ≥60% значений — даты/кварталы;
  значения → {quarter, year}, xlsx serial dates поддержаны). Пустые строки — skip
  со счётчиком. Предпросмотр (первые 5) + мини-смета (батчи ≤20 → calls, ~токены).
- **Критерии приёмки (TDD, фикстуры):**
  - [ ] Книга2.xlsx (копия в `apps/server/test/fixtures/`): 2 колонки распознаны,
        все непустые строки прочитаны, ключи CRPV-* извлечены.
  - [ ] Синтетика: inline strings; без ключевой колонки (только текст); с колонкой
        сроков (даты и «Q1 2027»); кириллические заголовки; переставленные колонки.
  - [ ] Битый zip / не-xlsx / пустой лист / нет текстовой колонки → DATA-05/DATA-04.
  - [ ] 5000+ строк → DATA-02 (лимит), 10 МБ+ → DATA-02.

## Эпик E2: Match-стадия · Трассировка: П3, решения PO №1, №5

#### T-303 · AI-соотнесение батчами с картой дерева · [L] · после T-301, параллельно с T-302
- **Что:** `aiImport/backlogMatchStage.ts`: карта существующего дерева (имена+иерархия
  обоих типов, компактно как archiveMap); промпт: для каждой строки батча →
  `{rowId, businessName, type, parentExisting|parentNew {name, parentName|null},
  duplicateOf|null}`; правила промпта: новый узел — ТОЛЬКО бизнес-функция продукта
  (запрет технических группировок — прямо в промпте с примерами хорошо/плохо);
  structured output через ResponseFormatNegotiator; невалидный JSON → ретраи + деление
  батча пополам (реюз паттерна адаптивности); aiCall (ретраи/таймаут/параллелизм
  из пресета); чекпоинт после батча.
- Пост-обработка детерминированно: parentExisting валидируется по дереву
  (галлюцинация → превращается в parentNew с тем же именем? НЕТ —
  [ДОПУЩЕНИЕ]: несуществующий parentExisting → parentNew {name, parentName:null}
  с пометкой в лог); duplicateOf валидируется по дереву (галлюцинация → null);
  дедуп новых узлов между батчами (нормализация имён из todo_20 dedupe);
  businessName-коллизии между строками → суффиксы на populate.
- **Критерии приёмки:**
  - [ ] Мок-модель: разметка 214 строк за ≤14 вызовов; чекпоинт/resume с середины
        не переоплачивает пройденные батчи.
  - [ ] Галлюцинации родителя/дубля нейтрализуются кодом (тест).
  - [ ] 429/таймауты — ретраи todo_20 работают (интеграционный тест на моке сбоев).

## Эпик E3: Статусы, выверка, запись · Трассировка: П4, решения PO №1–4

#### T-304 · Сервис: поток статусов + confirm/apply + populate + отчёт · [L] · после T-302, T-303
- **Что:** `AiBacklogImportService` (или ветка kind в AiImportService — решить по
  месту, НЕ дублируя механику джоб): parse → awaiting-confirmation (preview в view) →
  confirm {target} → match → **awaiting-review** (разметка в view; НИ одной записи
  в проект до apply — тест) → apply {rowIds} → populate: (1) новые узлы в порядке
  родитель→дитя, (2) требования выбранных строк, (3) CHILD_OF, (4) SourceEntry
  BACKLOG с дефолтным priorityId словаря проекта; имена-коллизии — существующий
  суффикс-механизм; идемпотентность повторного apply (re-run не дублирует — реюз
  skip existing); отчёт (aiBacklogReport) + лог; роуты + OpenAPI; история jobs
  показывает kind; resume для match; awaiting-* переживают рестарт (не interrupted).
- **Критерии приёмки:**
  - [ ] До apply в Projects/<p>/openspec НИЧЕГО не меняется (тест следит за fs).
  - [ ] apply с подмножеством rowIds: только выбранные; снятые — deselected в отчёте.
  - [ ] Дубли (duplicateOf) не создаются и видны в отчёте; существующие не изменены.
  - [ ] Kill между match и apply → рестарт → джоба в awaiting-review с разметкой.
  - [ ] Повторный apply (после сбоя на середине populate) не создаёт дублей.
  - [ ] Целостность: все созданные связи проходят core-инварианты (один родитель, без циклов).

## Эпик E4: Frontend (волна 2) · Трассировка: бриф §4 + решения PO

#### T-305 · Кнопка + модалка: upload/preview/target → прогресс · [L] · после волны 1
- **Что:** кнопка «AI подгрузка из бэклога» рядом с существующей (макет 01);
  `AiBacklogImportModal` (реюз каркаса/size='large'): drag&drop xlsx → preview
  (чипы колонок, 5 строк, счётчики, поле «целевой квартал/год» с дефолтом из view,
  скрывать target-поле если колонка сроков найдена для всех строк) → «Начать анализ»
  (confirm) → прогресс (батч X из Y, счётчики, события, «Остановить») — макет 02;
  ошибки — компонент таксономии из todo_20 (реюз, не копипаста). API-слой: start/
  confirm(с телом)/apply/poll: расширить aiImportApi+hooks под kind.
- **Критерии приёмки:** компонентные тесты всех состояний; терминология «батч»/«строка».

#### T-306 · Выверка, отчёт, история, SourceType BACKLOG в UI · [L] · после T-305
- **Что:** шаг выверки (макет 04): блок «Будут созданы новые узлы (N)», таблица
  с чекбоксами (дефолт: все кроме дублей; «выбрано X из Y»; select-all), target-колонка
  (📄 у взятых из файла), «Записать в проект (N)» → apply; отчёт (макет 03) + история
  (kind-бейдж «Бэклог» в списке джоб); SourceType BACKLOG везде, где типы источников:
  `sourceTypes.ts` (лейбл «Бэклог», иконка ListTodo/Layers), формы источников,
  бейджи, фильтры по типу источника.
- **Критерии приёмки:** без выбора строк кнопка записи disabled; НФТ-бейдж в таблице;
  компонентные тесты выверки (select/deselect/apply-пейлоад) и UI-словарей BACKLOG.

## Эпик E5: QA (волна 3, e2e/)

#### T-307 · E2E полного потока на мок-модели · [L]
- **Что:** сценарии: (1) happy-path: загрузка фикстуры-xlsx → preview (колонки/строки/
  target-поле) → анализ → выверка (новые узлы видны, снять 1 строку) → запись →
  отчёт → дерево содержит новые узлы/требования с источником «Бэклог» (бейдж);
  (2) дубль не создан; (3) сбой модели на середине match → ошибка → «Продолжить» →
  выверка достигнута без дублей вызовов; (4) отмена на выверке — проект не изменён;
  (5) история: kind-бейдж, открытие старой джобы. Реюз ai-stub (расширить под
  match-ответы). Prettier по своим файлам.

---

## Рекомендуемый порядок (волны)

- **Волна 1 (backend, один агент последовательно):** T-301 → T-302 ∥ T-303 → T-304
- **Волна 2 (frontend):** T-305 → T-306
- **Волна 3 (QA):** T-307
- Финал: гейты → RELEASE_NOTES → graphify → коммит.

## Сводка

Эпиков: 5 · Задач: 7 · Волн: 3. Риски: (1) новый SourceType — ripple по core
(markdown/схемы) и UI-словарям, следить за обратной совместимостью старых .md;
(2) fast-xml-parser — новая dependency (маленькая, MIT; альтернатива exceljs
отклонена как тяжёлая); (3) промпт «только бизнес-узлы» — качество на слабых моделях
проверяется вручную на этапе F3-аналога (эталонного реестра для бэклога нет — приёмка
по Книга2.xlsx-фикстуре и выверке глазами PO).
