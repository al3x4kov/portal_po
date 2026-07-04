# Task 11 BACKLOG: «AI подгрузка ФТ/НФТ из документации» (Architect)

Входы: `.dev/design/task11-ai-import-spec.md` (спек PO, решения §3, тексты ошибок §4),
`design-out/task11/ai-import-modal.html` (+ `.jpeg`), скилл
`apps/web/public/skills/project-po-extract.skill.md` (правила экстракции).
Переиспользуем: `AiConfigRepo`/`AiHubService`/`AiClientFactory` (task 8), multipart-паттерн
из `routes/archive.ts` (`req.parts()` → tmp-файл), распаковку adm-zip/tar (как `ArchiveRepo`,
c zip-slip защитой — NFR-5), сервисы требований/связей (services/repositories), поле `source`
требования (провенанс, FR-19).

Копия файла: `.dev/todo/task11-BACKLOG.md`.

## ЕДИНЫЙ контракт (владелец — backend, `packages/core/src/validation/ai.ts`)

```ts
// Константы:
export const AI_IMPORT_TEMPERATURE = 0.2;
export const AI_IMPORT_MAX_TOKENS = 2000;
export const AI_IMPORT_CHUNK_CHARS = 12_000;   // маленькое контекстное окно (Qwen-Coder-Next)
export const AI_IMPORT_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const AI_IMPORT_MAX_DOC_FILES = 500;

export const AI_IMPORT_STAGES = ['unpack', 'analyze', 'aggregate', 'populate', 'done'] as const;
export type AiImportStage = (typeof AI_IMPORT_STAGES)[number];

export const AI_IMPORT_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const;
export type AiImportStatus = (typeof AI_IMPORT_STATUSES)[number];

export const aiImportLogEntrySchema = z.object({
  ts: z.string(),                       // ISO
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
});

export const aiImportResultSchema = z.object({
  createdFunctions: z.number().int().min(0),
  createdNfrs: z.number().int().min(0),
  skippedExisting: z.number().int().min(0),
  links: z.number().int().min(0),
});

export const aiImportJobViewSchema = z.object({
  jobId: z.string(),
  projectId: z.string(),
  status: z.enum(AI_IMPORT_STATUSES),
  stage: z.enum(AI_IMPORT_STAGES),
  progress: z.number().min(0).max(100),
  log: z.array(aiImportLogEntrySchema),
  result: aiImportResultSchema.optional(),   // при succeeded (и при cancelled — что успело)
  error: z.object({ message: z.string(), hint: z.string() }).optional(), // при failed
});
export type AiImportJobView = z.infer<typeof aiImportJobViewSchema>;

// Ответ старта:
export const aiImportStartResponseSchema = z.object({ jobId: z.string() });

// Схема одного извлечённого требования (валидация ответа модели на сервере):
export const aiExtractedRequirementSchema = z.object({
  type: z.enum(['FUNCTION', 'NFR']),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  source: z.string().min(1).max(300),          // провенанс: файл §раздел — ОБЯЗАТЕЛЕН
  criticality: z.enum(CRITICALITIES).optional(),
  implemented: z.boolean().optional(),
  targetQuarter: z.enum(['Q1','Q2','Q3','Q4']).optional(),
  targetYear: z.number().int().optional(),
  parentName: z.string().optional(),
});
```

Маршруты (`apps/server/src/routes/aiImport.ts`):
- `POST /api/projects/:id/ai-import` — multipart: file (архив) + опц. поле `model` (override).
  Валидации до старта: проект существует (404); ключ AI задан и модель определена
  (override → модель проекта → 400 c текстом «Настройте AI Hub…», спек §4); размер ≤ лимита
  (400); уже есть running job проекта → 409. Ответ 202 `{jobId}` — работа асинхронная.
- `GET /api/ai-import/:jobId` → `AiImportJobView` (404 если нет).
- `POST /api/ai-import/:jobId/cancel` → `AiImportJobView` (идемпотентно; после завершения — no-op).

## Волна 1 — backend-node-senior (@po/core + apps/server, TDD)

B1. Контракт (выше) + тесты схем.
B2. `services/aiImportPrompt.ts`: `buildExtractionMessages(chunk, fileName, chunkInfo)` —
    system-промпт (RU) кодирует правила скилла: извлекать ТОЛЬКО из переданного текста, ничего
    не домысливать; каждый пункт с непустым `source` (имя файла + раздел/заголовок);
    criticality/implemented/target — только если явно в тексте; parentName — только если
    иерархия явно следует из структуры; ответ — СТРОГО JSON-массив объектов схемы выше, без
    markdown/преамбул; пустой массив если требований нет. Параметры: AI_IMPORT_TEMPERATURE/
    MAX_TOKENS. Парсер ответа: вычленить JSON-массив (в т.ч. из ```json-блока), safeParse
    каждой записи; невалидные записи — warn.
B3. `services/AiImportService.ts` + `lib/unpack.ts`:
    - unpack: adm-zip / tar в `os.tmpdir()/po-ai-import-*` (zip-slip защита: назначение строго
      внутри tmp-директории), фильтр `.md/.markdown/.txt`, лимит файлов; cleanup в finally.
    - analyze: файлы по алфавиту → чанки по AI_IMPORT_CHUNK_CHARS (резать по границам строк) →
      последовательные вызовы AI (client из AiConfigRepo, модель уже отрезолвлена на старте);
      после КАЖДОГО чанка — проверка флага cancel; лог per-файл/чанк («извлечено N ФТ, M НФТ»);
      чанк с нераспарсенным ответом → warn и продолжить; ВСЕ чанки невалидны → fail этапа
      (текст+hint из спека §4); ошибка AI Hub → fail (санитизация ключа как в AiHubService).
    - aggregate: дедуп по (type, name с trim, регистронезависимо); отбросить записи без source
      (warn); parentName → валиден если родитель в наборе или среди существующих требований.
    - populate: `loadAll` существующих; имя существует в рамках типа → skip (warn, счётчик);
      создать через существующий сервис требований (валидации core действуют):
      criticality ?? MEDIUM; implemented ?? false; для implemented=false: target из извлечения
      или следующий квартал от `deps.now()`; `source` = провенанс. Затем CHILD_OF-связи через
      сервис связей; доменная ошибка связи → warn, продолжаем.
    - Прогресс: unpack 0–5, analyze 5–80 (по чанкам), aggregate 80–85, populate 85–100.
    - Job-менеджер: in-memory Map (класс `AiImportJobs`), один running на проект, TTL-очистка
      завершённых (30 мин), инжект `now`/`makeAiClient` для тестов.
B4. Роуты (выше) в стиле ai.ts (parse400, error mapping), регистрация в app.ts.
    Тесты: unit сервиса на мок-клиенте (happy: 2 md → создание; чанкование большого файла —
    несколько вызовов; дедуп; skip существующих БЕЗ изменения их файлов; parentName-иерархия;
    отмена между чанками — cancelled + частичный result; ошибки этапов: пустой архив без md,
    upstream-ошибка, все чанки невалидны; умолчания criticality/implemented/target; провенанс
    в source; запись без source отброшена). Integration: multipart-загрузка маленького zip
    (создать в тесте adm-zip'ом), 202→поллинг→succeeded; 409 второй запуск; 400 без ключа;
    404 чужой jobId; cancel. Zip-slip тест (запись `../evil` не выходит из tmp).

DoD: unit+integration зелёные, coverage core ≥90%, lint/typecheck/format зелёные.

## Волна 2 — frontend-ts-senior (apps/web)

F1. `api/endpoints.ts`/`hooks.ts`: `startAiImport(projectId, file, model?)` (FormData),
    `useAiImportJob(jobId)` — query с `refetchInterval` ~800 мс пока status==='running',
    `cancelAiImport(jobId)`. Инвалидация requirements-запросов проекта при succeeded/cancelled.
F2. Кнопка в футере Main справа от `footer-add-nfr`: data-testid="footer-ai-import",
    «AI подгрузка из документации» (иконка-искра, стиль по макету).
F3. `components/AiImportModal.tsx` по макету design-out/task11 (все 7 состояний):
    - file input (accept .zip,.tar.gz,.tgz) + dnd-зона; testid "ai-import-file",
      выбранный файл "ai-import-file-name" + «Заменить»;
    - селект модели "ai-import-model-select" (паттерн ChatWidget: модель проекта по умолчанию,
      серый+тултип без ключа, testid обёртки "ai-import-model-hint");
    - «Запустить анализ» "ai-import-start" (disabled без файла/модели, тултипы по спеку);
    - running: прогресс-бар "ai-import-progress" (+ % "ai-import-progress-pct"), этап,
      лог "ai-import-log" (строки с ts/level, автоскролл), кнопка «Остановить" "ai-import-stop";
    - X "ai-import-close" и клик по оверлею: если running → ConfirmDialog («Прекратить
      автоматизацию?», тексты из макета) → confirm = cancel+закрыть; иначе просто закрыть;
    - успех: блок "ai-import-success" с итогами (created ФТ/НФТ, связи, skipped) + кнопка
      «Закрыть и перейти к проекту» "ai-import-done";
    - ошибка: блок "ai-import-error" (этап, message, hint «Что делать…») + «Повторить анализ».
F4. Component-тесты: disabled-состояния, запуск (mock API) → прогресс/лог, стоп, confirm на X
    при running и мгновенное закрытие при idle, успех, ошибка с hint.

## Волна 3 — playwright-qa-senior (e2e/)

Матрица §5 спека. AI-стаб (`e2e/tests/helpers/ai-stub.ts`) расширить extraction-ответом:
на chat.completions с extraction-промптом возвращать валидный JSON-массив (2–3 ФТ/НФТ с
source), режим ошибки. Архивы для теста собрать в тесте (adm-zip доступен в workspace server;
либо заранее положить фикстуру в e2e/fixtures). Обязательно: happy-path zip → требования
появились в дереве с «Источник»; повторный запуск → skipped, без дублей; отмена; confirm на X
при running; ошибка этапа с инструкцией; tar.gz. Скриншоты состояний.

## Финал (оркестратор)

format:check → lint → typecheck → unit(coverage) → e2e; PO-проверка; RELEASE_NOTES;
graphify update; коммит только файлов задачи (core/server/web/e2e + .dev/design/task11-*,
.dev/todo/task11-BACKLOG.md, .dev/todo/todo_10.md, RELEASE_NOTES).
