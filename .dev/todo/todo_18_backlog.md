# todo_18 — Backlog (по решениям PO)

Источник: `.dev/todo/todo_18.md`. Ориентация — graphify. Ниже — декомпозиция двух проблем в ОДИН
сквозной конвейер (общий контракт в `@po/core`). Владение файлами:
- backend-агент: `@po/core` + `apps/server` (+ их тесты) — единственный владелец контракта;
- frontend-агент: `apps/web`;
- QA-агент: `e2e/`.

## Решения PO (зафиксировано)
1. Функция «смысловые связи» — **только в AI-импорте** (чекбокс `inferLinks`). Отдельной кнопки на проекте нет.
2. Объём анализа — **все три**: (а) дерево ФТ (CHILD_OF внутри FUNCTION), (б) дерево НФТ (CHILD_OF внутри NFR),
   (в) смысловые связи ФТ↔НФТ (RELATES_TO).
3. Иерархия на существующем проекте — **только заполнять пробелы**: CHILD_OF ставится лишь требованиям-корням;
   существующие родители и ручные связи не трогаем и не переставляем.
4. Best-practice параметры моделей — **редактируемо в UI настроек AI**; я задаю разумные дефолты, PO тюнингует.

## Диагноз (почему 0 связей)
- `relateStep` (в `AiImportService`) — единственная реализация «смысловых связей», делает ТОЛЬКО (в).
- (а)/(б) строит отдельный `structure`-шаг и только для свежеизвлечённых требований.
- 0 связей: скорее всего ответ «думающей» модели (`<think>…</think>` / reasoning) ломает `extractJsonArray`
  → шаг молча `skipped`. Совпадает с «хорошо работает только Qwen3-Coder-Next». Лечится обработкой reasoning (Проблема 2).

---

## Проблема 2 — per-model best-practice пресеты (фундамент, делаем первым)

### Контракт (`@po/core`, `packages/core/src/validation/ai.ts`)
- Новый `aiModelPresetSchema`:
  - `temperature: number (0..2)` — для пайплайна импорта/связей;
  - `maxOutputTokens: number int ≥1` — ПОТОЛОК для `max_tokens` любого вызова этой модели;
  - `chunkChars: number int ≥1000` — размер входного чанка при извлечении (вход. контекст);
  - `reasoning: 'none' | 'strip'` — `strip` = вырезать `<think>…</think>`/reasoning из ответа перед парсингом;
  - `topP?: number (0..1)` (опц.).
- `AI_MODEL_PRESET_DEFAULTS: Record<string, AiModelPreset>` — дефолты для 3 известных id + generic fallback:
  - `Qwen/Qwen3-Coder-Next`: temp 0.2, maxOut 4000, chunk 12000, reasoning `none` (работает сейчас);
  - `Qwen/Qwen3.5-397B-A17B`: temp 0.2, maxOut 8000, chunk 24000, reasoning `strip` (думающая, большой контекст);
  - `Qwen/Qwen3.6-27B`: temp 0.2, maxOut 6000, chunk 16000, reasoning `strip` (думающая);
  - `__default__`: temp 0.2, maxOut 4000, chunk 12000, reasoning `strip` (безопасно по умолчанию).
- `resolveModelPreset(modelId, overrides?)` — вернуть эффективный пресет: override из конфига → дефолт по id →
  generic fallback. Экспортировать.
- Расширить `AiConfigFile`/`aiConfigViewSchema`/`aiConfigUpdateSchema`: `modelPresets: Record<modelId, Partial<AiModelPreset>>`
  (частичный override; пустой = дефолты). View отдаёт пресеты (ключ не входит — как и раньше).

### Server
- `AiConfigRepo`: читать/писать `modelPresets`, merge при `update`. Дефолты не материализуем на диск — только оверрайды.
- Обработка reasoning: единая функция `stripReasoning(content)` (вырезать `<think>…</think>`, а также ведущие
  reasoning-обёртки) — применять в `extractJsonArray` (или до него) и в chat/gen/relate cleaning. При `reasoning:'strip'`.
  Для `none` — не трогаем (совместимость с Coder-Next).
- `AiHubService` + `AiImportService`: перед каждым вызовом брать `resolveModelPreset` по фактической модели и
  подставлять `temperature` (пайплайн импорта), `max_tokens = min(желаемый, preset.maxOutputTokens)`,
  `chunkChars` (импорт-извлечение) из пресета вместо констант `AI_IMPORT_*`. Chat/gen: `max_tokens` клампится
  пресетом; ответ чистится по `reasoning`.
- `AiChatCompletionParams`: добавить опц. `top_p?`; передавать из пресета когда задан.
- Routes `/api/ai/config` (GET/PUT): пробросить `modelPresets` через существующий контракт.

### Тесты (TDD, backend)
- unit `@po/core`: `resolveModelPreset` (override>дефолт>fallback), схемы пресетов, клампинг maxTokens.
- unit `stripReasoning`: `<think>...</think>` до/после/вокруг JSON-массива, вложенность, отсутствие тега.
- integration server: пресеты сохраняются/читаются; при выборе «думающей» модели ответ с `<think>` парсится в связи.

---

## Проблема 1 — смысловые связи а+б+в в импорте (поверх фундамента)

### Поведение
- Чекбокс `inferLinks` («Найти смысловые связи НФТ с ФТ (AI)») теперь охватывает все три:
  (а)/(б) уже даёт `structure`-шаг (идёт всегда) — убедиться, что дерево СВЯЗНОЕ (корень → декомпозиция),
  gap-fill (существующие родители не трогаются — уже так: existing реквизиты skip);
  (в) — `relateStep`, сделать надёжным (см. ниже). Лейбл/подсказку уточнить (frontend).
- Надёжность (в):
  - reasoning-strip уже лечит парсинг «думающих» моделей;
  - смягчить системный промпт relate (не терять явные соответствия), но сохранить правило «пара только НФТ↔ФТ»;
  - логировать явную причину, когда модель вернула `[]` (не «молча 0»): строка в job.log
    «Модель не нашла уверенных пар ФТ↔НФТ» — видимость вместо тишины (todo_18 §Фиксация вне-скоупа).
- Gap-fill инвариант (в структуре): для требований, у которых родитель уже есть в проекте (existing), CHILD_OF не
  переставляем; ставим только там, где узел — корень. Покрыть тестом.

### Тесты (backend)
- integration: импорт с `inferLinks=true` и «думающей» моделью → создаются и CHILD_OF (а/б), и RELATES_TO (в) > 0.
- unit: relate-парсер устойчив к `<think>`; пустой массив → статус done + лог-причина, а не молчание.

---

## Frontend (`apps/web`) — после пуша backend
- Экран настроек AI: редактирование пресетов на модель (temperature, maxOutputTokens, chunkChars, reasoning, topP);
  при выборе модели показывать эффективный пресет (оверрайд/дефолт), «Сбросить к дефолту».
- `AiImportModal`: уточнить подпись чекбокса/подсказку под «а+б+в»; в результатах показывать раздельно
  CHILD_OF (дерево) и RELATES_TO (кросс-связи) — счётчики уже есть (`result.links` / `relatesLinks` / `relate.created`).
- Компонентные тесты форм пресетов (Zod из `@po/core`).

## QA (`e2e/`) — после пуша frontend
- e2e: сохранение пресета модели в настройках; выбор «думающей» модели; импорт с чекбоксом → в логе и результате
  видны и дерево, и кросс-связи (> 0) на стабе, эмулирующем `<think>`-ответ.

## Финал каждой фазы
format:check → lint → typecheck → unit(coverage) → e2e; фиксы; обновить `docs/RELEASE_NOTES.md`; `graphify update .`;
коммит ТОЛЬКО файлов задачи (не тащить `extract-out/`, `new_design/`, `.playwright-mcp/` и пр. untracked).
