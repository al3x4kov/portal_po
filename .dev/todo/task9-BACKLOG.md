# Task 9 BACKLOG: плавающий виджет AI-чата (Architect)

Входы: `.dev/design/task9-chat-widget-spec.md` (спек PO, решения §6),
`design-out/task9/chat-widget.html` (+`chat-widget.jpeg`). Инфраструктура task 8 переиспользуется:
`AiConfigRepo` (ключ/baseURL глобально, модель per-project), `AiHubService` + `AiClientFactory`
(инжектится, в тестах — мок), маршруты `apps/server/src/routes/ai.ts`.

Копия этого файла: `.dev/todo/task9-BACKLOG.md` (первоисточник для коммита).

## ЕДИНЫЙ API-контракт (владелец — backend, `packages/core/src/validation/ai.ts`)

```ts
// Константы (не в UI):
export const AI_CHAT_TEMPERATURE = 0.7;
export const AI_CHAT_MAX_TOKENS = 1000;
export const AI_CHAT_HISTORY_LIMIT = 20; // сколько последних сообщений уходит в запрос

export const aiChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});
export type AiChatMessage = z.infer<typeof aiChatMessageSchema>;

export const aiChatRequestSchema = z.object({
  projectId: z.string().min(1).optional(), // нет на экранах без проекта
  model: z.string().min(1).optional(),     // override из дропдауна виджета
  messages: z.array(aiChatMessageSchema).min(1).max(AI_CHAT_HISTORY_LIMIT),
});
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;

export const aiChatResponseSchema = z.object({
  message: aiChatMessageSchema, // role: 'assistant'
});
export type AiChatResponse = z.infer<typeof aiChatResponseSchema>;
```

`POST /api/ai/chat`:
- 400 — невалидное тело; нет сохранённого ключа («AI Hub API key is not configured.»);
  модель не определена: `model` из запроса → иначе `modelByProject[projectId]` → иначе 400
  («No AI model is selected. Choose a model in the chat or configure the project.»).
- 502 (`AiUpstreamError`) — ошибка апстрима/пустой ответ; текст санитизирован (ключ → `***`).
- 200 — `{ message: { role: 'assistant', content } }`.

Переименования существующего НЕ делаем. NB: в `services/aiPrompt.ts` уже есть локальный тип
`AiChatMessage` — core-тип не должен с ним конфликтовать (использовать core-тип и убрать
дублирование ИЛИ алиас при импорте; решает backend, публичный контракт — core).

## Волна 1 — backend-node-senior (владеет @po/core, apps/server; TDD)

B1. Контракт в `packages/core/src/validation/ai.ts` (+ экспорт через barrel, тесты схем в
    `ai.test.ts`: валидные/невалидные роли, пустой content, лимит messages).
B2. `AiHubService.chat(input: AiChatRequest): Promise<string>`:
    читает конфиг → проверка ключа → резолв модели (см. выше) → системный промпт (RU,
    ассистент PO по управлению требованиями, отвечает кратко, по-русски, без выдумывания
    фактов) + `input.messages` (уже ограничены схемой) → `chat.completions.create({model,
    messages, temperature: AI_CHAT_TEMPERATURE, max_tokens: AI_CHAT_MAX_TOKENS})` →
    trim, пустой ответ = AiUpstreamError. Системный промпт — в `services/aiPrompt.ts`
    (`buildChatMessages(input)` рядом с `buildDescriptionMessages`).
    Unit-тесты `apps/server/test/ai-hub-service.test.ts` (мок-клиент): happy path, override
    модели, модель из projectId, 400 без ключа/модели, 502 upstream/пустой ответ, санитизация.
B3. Маршрут `POST /api/ai/chat` в `routes/ai.ts` (parse400 + сервис). Integration-тест в
    существующем стиле ai-роутов.

DoD волны 1: unit+integration зелёные, coverage core ≥90%, typecheck/lint зелёные.

## Волна 2 — frontend-ts-senior (владеет apps/web; контракт только потребляет из @po/core)

F1. Store `apps/web/src/store/chat.ts` (Zustand): `{isOpen, fabPos, widgetPos, modelOverride,
    messages: AiChatMessage[], pending, error}` + actions (open/close/newChat/send-хелперы не в
    store — мутация через React Query). Живёт в памяти (решение PO §6.1/6.6).
F2. API: `endpoints.ts` + `api/hooks.ts` — `useAiChat` (POST /api/ai/chat), переиспользовать
    существующие `useAiConfig(projectId)` / `useAiModels` (если есть — из task 8).
F3. Компонент `components/ChatWidget/` :
    - FAB: fixed, draggable (pointer events, порог 5px click-vs-drag), z-50, testid `chat-fab`.
    - Виджет 380×560: header (select модели `chat-model-select` — options из useAiModels;
      disabled+opacity+тултип title, когда `!hasApiKey`; дефолт значения — модель проекта из
      config при открытом проекте; выбор → `modelOverride`), кнопка `chat-new`, кнопка
      `chat-close`; drag за header.
    - Лента `chat-messages`: пузыри + аватары бота/юзера (inline SVG по макету), автоскролл
      вниз, «печатает…» при pending, ошибка — сообщение в ленте (`chat-error`).
    - Ввод: textarea `chat-input` (Enter=send, Shift+Enter=перенос), кнопка `chat-send`;
      disabled при pending/пусто/не определена модель (тултип «Настройте AI Hub»).
    - projectId для запроса/конфига — из текущего роута (`/p/:id/...`), если открыт.
F4. Монтирование в `App.tsx` над `<AppRoutes/>` — виджет на всех экранах.
F5. Компонентные тесты `ChatWidget.test.tsx`: открытие/закрытие с сохранением переписки,
    «новый чат» очищает, серое состояние без ключа, отправка (mock fetch) рисует user+assistant,
    ошибка не теряет историю.

DoD волны 2: component-тесты зелёные, lint/typecheck зелёные, ручной smoke через vite build.

## Волна 3 — playwright-qa-senior (владеет e2e/)

Матрица (§4 спека): FAB на всех экранах; drag FAB; открыть/закрыть с сохранением переписки;
новый чат очищает; без ключа — серый дропдаун+тултип+disabled send; с ключом (AI-стаб e2e из
task 8 — найти существующий стаб и переиспользовать) — отправка и ответ бота; override модели
доходит до стаба; ошибка апстрима — читабельное сообщение. Скриншоты ключевых состояний.

## Финал (оркестратор)

format:check → lint → typecheck → unit(coverage) → e2e; PO-проверка соответствия спеку;
`docs/RELEASE_NOTES.md`; `graphify update .`; коммит ТОЛЬКО файлов задачи
(core/server/web/e2e + .dev/design/task9-* + .dev/todo/task9-BACKLOG.md + RELEASE_NOTES).
design-out/ и architect-out/ gitignored — не коммитить.
