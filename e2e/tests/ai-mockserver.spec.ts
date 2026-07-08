import AdmZip from 'adm-zip';
import { expect, request as pwRequest, test, type Page, type TestInfo } from '@playwright/test';
import { createProject, projectIdFromUrl, rowByName, uniqueName } from './helpers/app.js';
import { expectAiImportSummary } from './helpers/ai-import.js';
import {
  addExpectation,
  bodyAsString,
  clearExpectation,
  COMPLETIONS_PATH,
  ensureMockServer,
  MOCKSERVER_OPENAI_BASE,
  MODELS_PATH,
  parseChatBody,
  retrieveRequests,
  verify,
  type MockServerHandle,
} from './helpers/mockserver.js';

/**
 * AI-интеграция против НАСТОЯЩЕГО MockServer (mock-server.com, Java, :1080).
 *
 * В отличие от ai-hub/chat-widget/ai-import.spec.ts (in-process ai-stub) здесь
 * портал ходит настоящим `openai`-клиентом во внешний HTTP-сервер с
 * декларативными матчерами (см. ~/Documents/mockserver/README.md):
 *   - базовые expectations преднастроены (models c Bearer-проверкой; chat/
 *     generation/extraction маршрутизируются по подстроке промпта);
 *   - fault-injection — динамические expectations c priority 30, снимаются
 *     точечно по id (`/mockserver/clear`); `/mockserver/reset` НЕ зовём,
 *     чтобы не стереть базовые.
 *
 * Если MockServer недоступен и его бинарь не установлен (CI без Java) — спек
 * целиком скипается. Конфиг портала (.ai-config.json глобальный) выставляется
 * per-тест и сбрасывается в afterAll ({apiKey: null}).
 *
 * Файл выполняется последовательно (workers: 1 в playwright.config.ts).
 */

const MOCK_KEY = 'mock-key';
const MOCK_MODEL = 'GigaChat-2-Pro';
const MOCK_MODELS = ['GigaChat-2-Max', 'GigaChat-2-Pro', 'Qwen-Coder-Next']; // sorted by the server
const MOCK_CHAT_REPLY = 'Ответ ассистента из MockServer: уточните критерии приёмки.';
const MOCK_GEN_TEXT =
  'Система обеспечивает вход пользователя по логину и паролю за не более чем 2 секунды (MockServer).';
const IMP_FUNCTION = 'Мок-функция входа';
const IMP_NFR = 'Мок-НФТ отклика';

/** Все id динамических expectations — afterEach снимает их безусловно. */
const FAULT_IDS = [
  'e2e-fault-500',
  'e2e-fault-401',
  'e2e-delay-8',
  'e2e-delay-70',
  'e2e-drop',
  'e2e-bad-json',
  'e2e-empty-choices',
  'e2e-structure',
  'e2e-extraction-related',
] as const;

/** Готовое OpenAI-совместимое тело ответа chat.completions. */
function chatCompletionBody(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-e2e-fault',
    object: 'chat.completion',
    model: MOCK_MODEL,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  };
}

let mock: MockServerHandle;

test.beforeAll(async () => {
  mock = await ensureMockServer();
});

test.beforeEach(() => {
  test.skip(!mock.available, 'MockServer недоступен (нет процесса на :1080 и бинарь не найден)');
});

test.afterEach(async () => {
  if (!mock.available) return;
  // Belt-and-suspenders: снять все динамические expectations (clear по
  // несуществующему id безопасен), базовые остаются нетронутыми.
  for (const id of FAULT_IDS) await clearExpectation(id);
});

test.afterAll(async () => {
  if (mock.available) {
    // Сброс глобального AI-конфига портала, чтобы соседние спеки стартовали
    // с чистого состояния (та же дисциплина, что в chat-widget.spec.ts).
    const port = Number(process.env.E2E_PORT ?? 41730);
    const ctx = await pwRequest.newContext({ baseURL: `http://127.0.0.1:${port}` });
    await ctx.put('/api/ai/config', { data: { apiKey: null } }).catch(() => {});
    await ctx.dispose();
  }
  await mock.stop();
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** PUT /api/ai/config: ключ+baseURL (глобально) и модель проекта. */
async function configureAi(page: Page, projectId: string): Promise<void> {
  const res = await page.request.put('/api/ai/config', {
    data: { apiKey: MOCK_KEY, baseURL: MOCKSERVER_OPENAI_BASE, projectId, model: MOCK_MODEL },
  });
  if (!res.ok()) throw new Error(`PUT /api/ai/config failed (${res.status()})`);
}

/** Новый проект + конфиг AI + reload, чтобы UI увидел конфиг. */
async function projectWithAi(page: Page, prefix: string): Promise<string> {
  await createProject(page, uniqueName(prefix));
  const id = projectIdFromUrl(page);
  await configureAi(page, id);
  await page.reload();
  await expect(page.getByTestId('main-page')).toBeVisible();
  return id;
}

/** Открыть плавающий чат-виджет. */
async function openWidget(page: Page): Promise<void> {
  await page.getByTestId('chat-fab').click();
  await expect(page.getByTestId('chat-widget')).toBeVisible();
}

/** Отправить сообщение в чат; дождаться пузыря пользователя. */
async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId('chat-input').fill(text);
  await expect(page.getByTestId('chat-send')).toBeEnabled();
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-msg-user').filter({ hasText: text })).toBeVisible();
}

/** Скриншот в артефакты теста. */
async function attachShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

/** Аннотация + дублирование в stdout (list-репортер аннотаций не печатает). */
function note(testInfo: TestInfo, type: string, description: string): void {
  testInfo.annotations.push({ type, description });
  console.log(`[${type}] ${testInfo.title}: ${description}`);
}

/* ── Сценарии ─────────────────────────────────────────────────────────────── */

test.describe('AI против реального MockServer', () => {
  /* a) Экран AI: модели из MockServer + Bearer-ключ доходит до апстрима. */

  test('экран AI: «Обновить список» сохраняет ключ и грузит 3 модели MockServer; апстрим получил ровно Bearer mock-key', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('MS-Models'));
    const id = projectIdFromUrl(page);

    await page.goto(`/p/${id}/ai`);
    await expect(page.getByTestId('ai-page')).toBeVisible();
    await page.getByTestId('ai-baseurl-input').fill(MOCKSERVER_OPENAI_BASE);
    await page.getByTestId('ai-key-input').fill(MOCK_KEY);
    // T5 (todo_17): «Обновить список» с непустым ключом сохраняет конфиг,
    // затем грузит модели (бывший flow «Сохранить и загрузить модели»).
    await page.getByTestId('ai-models-refresh').click();

    // Успех под кнопкой «Сохранить» + селект ровно с тремя моделями MockServer.
    const status = page.getByTestId('ai-status');
    await expect(status.locator('[data-state="success"]')).toBeVisible();
    await expect(status).toContainText('Подключение успешно');
    const select = page.getByTestId('ai-model-select');
    await expect(select).toBeVisible();
    // Ровно 3 модели MockServer (отсортированы сервером); первая авто-выбрана,
    // поэтому плейсхолдера «— выберите модель —» нет.
    await expect(select.locator('option')).toHaveText(MOCK_MODELS);
    await expect(select).toHaveValue(MOCK_MODELS[0]!);
    await select.selectOption(MOCK_MODEL);
    await page.getByTestId('ai-save').click();
    await expect(status.locator('[data-state="success"]')).toContainText('Настройки сохранены');
    await expect(page.getByTestId('ai-key-saved')).toBeVisible();
    await attachShot(page, testInfo, 'ms-models-loaded');

    // MockServer verify: GET /models пришёл с Authorization: Bearer mock-key.
    const verified = await verify(
      { method: 'GET', path: MODELS_PATH, headers: { Authorization: [`Bearer ${MOCK_KEY}`] } },
      { atLeast: 1 },
    );
    expect(verified.ok, verified.detail).toBe(true);

    // И РОВНО с ключом: последний записанный /models-запрос несёт точное значение.
    const recorded = await retrieveRequests({ method: 'GET', path: MODELS_PATH });
    expect(recorded.length).toBeGreaterThan(0);
    const last = recorded[recorded.length - 1]!;
    const auth = Object.entries(last.headers ?? {}).find(
      ([k]) => k.toLowerCase() === 'authorization',
    )?.[1];
    expect(auth).toEqual([`Bearer ${MOCK_KEY}`]);
  });

  /* b) Чат-виджет: ответ MockServer + модель и последний user-message в теле. */

  test('чат-виджет: ответ из MockServer; апстрим получил model и последний вопрос', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'MS-Chat');
    await openWidget(page);
    await expect(page.getByTestId('chat-model-select')).toHaveValue(MOCK_MODEL);

    const question = `Что такое критичность требования? [${uniqueName('q')}]`;
    await sendMessage(page, question);
    await expect(page.getByTestId('chat-msg-assistant')).toContainText(MOCK_CHAT_REPLY);
    await attachShot(page, testInfo, 'ms-chat-reply');

    // Тело запроса в апстрим: точная модель и последний user-message.
    const recorded = await retrieveRequests({
      method: 'POST',
      path: COMPLETIONS_PATH,
      body: { type: 'STRING', string: question, subString: true },
    });
    expect(recorded).toHaveLength(1);
    const body = parseChatBody(recorded[0]!);
    expect(body.model).toBe(MOCK_MODEL);
    const users = (body.messages ?? []).filter((m) => m.role === 'user');
    expect(users[users.length - 1]?.content).toContain(question);
  });

  /* c) Генерация описания в RequirementModal через MockServer. */

  test('генерация описания: превью содержит текст generation-мока MockServer', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'MS-Gen');

    await page.getByTestId('add-function').click();
    await expect(page.getByTestId('requirement-modal')).toBeVisible();
    await page.getByTestId('req-name').fill(uniqueName('MS-Req'));
    await page.getByTestId('req-criticality-high').click();
    // ФТ-E3 (todo_19): описание и AI-панель — за вкладкой «Описание».
    await page.getByTestId('req-tab-desc').click();
    await expect(page.getByTestId('req-description')).toBeVisible();
    await page.getByTestId('req-description').fill('Черновик описания от пользователя.');

    const genOpen = page.getByTestId('ai-gen-open');
    await expect(genOpen).toBeEnabled();
    await genOpen.click();
    await expect(page.getByTestId('ai-gen-hint')).toBeVisible();
    await page.getByTestId('ai-gen-submit').click();

    const preview = page.getByTestId('ai-gen-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(MOCK_GEN_TEXT);
    await attachShot(page, testInfo, 'ms-generation-preview');
  });

  /* d) AI-импорт документации: extraction+structure моки → требования в
     дереве; «Источник» пуст, «Реализация» = «Реализовано» (Task 13);
     relatedFunctions НФТ → связь RELATES_TO и счётчик (Task 15). */

  test('AI-импорт zip: успех, мок-требования в дереве, «Источник» пуст, «Реализовано», связь НФТ→ФТ', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'MS-Imp');

    // 2 небольших md; уникальные имена файлов скоупят журнал MockServer.
    const runId = uniqueName('msimp');
    const files: Record<string, string> = {
      [`login-${runId}.md`]: '# Вход\nПользователь входит по логину и паролю.\n',
      [`perf-${runId}.md`]: '# Отклик\nИнтерфейс отвечает не дольше 1 секунды.\n',
    };
    const zip = new AdmZip();
    for (const [entry, content] of Object.entries(files)) {
      zip.addFile(entry, Buffer.from(content, 'utf8'));
    }
    const zipPath = testInfo.outputPath('ms-docs.zip');
    zip.writeZip(zipPath);

    // Task 15: базовый extraction-мок (priority 20 в expectations-init.json)
    // relatedFunctions не знает → перекрываем его динамическим expectation
    // (priority 26, матчер по подстроке extraction-промпта): тот же массив
    // 1 ФТ + 1 НФТ и с теми же source («mock.md § …», их эхает батч
    // structure-вызова), но у НФТ появляется relatedFunctions=[ФТ] — пайплайн
    // обязан создать симметричную RELATES_TO НФТ→ФТ.
    await addExpectation({
      id: 'e2e-extraction-related',
      priority: 26,
      httpRequest: {
        method: 'POST',
        path: COMPLETIONS_PATH,
        body: { type: 'STRING', string: 'экстрактор требований', subString: true },
      },
      httpResponse: {
        statusCode: 200,
        headers: { 'Content-Type': ['application/json'] },
        body: chatCompletionBody(
          JSON.stringify([
            {
              type: 'FUNCTION',
              name: IMP_FUNCTION,
              description: 'Пользователь входит по логину и паролю (MockServer).',
              source: 'mock.md § Вход',
            },
            {
              type: 'NFR',
              name: IMP_NFR,
              description: 'Интерфейс отвечает не дольше 1 секунды (MockServer).',
              source: 'mock.md § Производительность',
              relatedFunctions: [IMP_FUNCTION],
            },
          ]),
        ),
      },
    });

    // Task 13 B2: пайплайн делает ДОПОЛНИТЕЛЬНЫЙ structure-вызов (system
    // «архитектор дерева требований…»). Базовые expectations MockServer его
    // не знают → без этого мока он упал бы в chat-ответ (не-JSON) и после
    // 3 попыток остался бы плоским. Отвечаем строгим JSON-массивом: оба
    // требования — корни (иерархия только внутри одного типа, а здесь 1 ФТ
    // и 1 НФТ), parentName обязан быть явным null.
    await addExpectation({
      id: 'e2e-structure',
      priority: 25,
      httpRequest: {
        method: 'POST',
        path: COMPLETIONS_PATH,
        body: { type: 'STRING', string: 'архитектор дерева требований', subString: true },
      },
      httpResponse: {
        statusCode: 200,
        headers: { 'Content-Type': ['application/json'] },
        body: chatCompletionBody(
          JSON.stringify([
            { type: 'FUNCTION', name: IMP_FUNCTION, parentName: null },
            { type: 'NFR', name: IMP_NFR, parentName: null },
          ]),
        ),
      },
    });

    await page.getByTestId('footer-ai-import').click();
    await expect(page.getByTestId('ai-import')).toBeVisible();
    await page.getByTestId('ai-import-file').setInputFiles(zipPath);
    await expect(page.getByTestId('ai-import-file-name')).toContainText('ms-docs.zip');
    await page.getByTestId('ai-import-start').click();

    // Мок отвечает ОДНИМ и тем же массивом (1 ФТ + 1 НФТ) на КАЖДЫЙ файл →
    // из 4 извлечённых записей создаются 2; 2 in-run дубликата второго файла
    // не попадают в счётчики («Пропущено как существующие: 0»), но фиксируются
    // warn-строкой в логе работы (бэкенд-фикс).
    const success = page.getByTestId('ai-import-success');
    await expect(success).toBeVisible({ timeout: 30_000 });
    // T5 (todo_17): итоги — сводка-таблица (5 строк) вместо однострочного текста.
    await expectAiImportSummary(page, {
      functions: 1,
      nfrs: 1,
      treeLinks: 0,
      relatesLinks: 1,
      skipped: 0,
    });
    // Бэкенд-фикс minor-дефекта: in-run дубли теперь явно видны warn-строкой
    // в логе работы (счётчики контракта не менялись — skipped остаётся 0).
    const log = page.getByTestId('ai-import-log');
    await expect(log).toContainText('Дубликатов в извлечении пропущено: 2');
    // Task 13 B2: стадия структуризации прошла через настоящий MockServer.
    await expect(log).toContainText('Построение древовидной структуры ФТ/НФТ через AI hub…');
    // Task 15: связь НФТ→ФТ из relatedFunctions — инфо-лог (счётчик уже
    // проверен в сводке-таблице выше).
    await expect(log).toContainText(
      `Связано: НФТ «${IMP_NFR}» → ФТ «${IMP_FUNCTION}» (RELATES_TO).`,
    );
    await attachShot(page, testInfo, 'ms-import-success');

    await page.getByTestId('ai-import-done').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);
    await expect(rowByName(page, IMP_FUNCTION)).toBeVisible();
    await expect(rowByName(page, IMP_NFR)).toBeVisible();

    // Task 13 A1/A2: «Источник» — бизнес-поле, при импорте остаётся пустым
    // (провенанс мока «mock.md § …» живёт только в логе работы); всё созданное
    // сразу «Реализовано», без квартала/года.
    const res = await page.request.get(`/api/projects/${encodeURIComponent(id)}/requirements`);
    expect(res.ok()).toBe(true);
    const { requirements } = (await res.json()) as {
      requirements: Array<{
        slug: string;
        name: string;
        source?: string;
        implemented?: boolean;
        targetQuarter?: string;
        targetYear?: number;
        links: Array<{ type: string; targetSlug: string }>;
      }>;
    };
    const byName = new Map(requirements.map((r) => [r.name, r]));
    for (const name of [IMP_FUNCTION, IMP_NFR]) {
      const req = byName.get(name);
      expect(req?.source ?? '', `source of «${name}» must stay empty`).toBe('');
      expect(req?.implemented, `«${name}» must be created implemented`).toBe(true);
      expect(req?.targetQuarter).toBeUndefined();
      expect(req?.targetYear).toBeUndefined();
    }

    // Task 15: RELATES_TO симметрична — запись у НФТ И парная запись у ФТ.
    const relatesOf = (name: string): string[] =>
      (byName.get(name)?.links ?? [])
        .filter((l) => l.type === 'RELATES_TO')
        .map((l) => l.targetSlug);
    expect(relatesOf(IMP_NFR)).toEqual([byName.get(IMP_FUNCTION)!.slug]);
    expect(relatesOf(IMP_FUNCTION)).toEqual([byName.get(IMP_NFR)!.slug]);

    // Запросы к апстриму, несущие runId (имена файлов входят и в extraction-
    // сообщение, и в карту архива structure-вызова): 2 extraction + 1 structure.
    const calls = await retrieveRequests({
      method: 'POST',
      path: COMPLETIONS_PATH,
      body: { type: 'STRING', string: runId, subString: true },
    });
    expect(calls).toHaveLength(3);
    const bodies = calls.map(parseChatBody);
    for (const body of bodies) expect(body.model).toBe(MOCK_MODEL);
    const extraction = bodies.filter((b) =>
      (b.messages?.[0]?.content ?? '').includes('экстрактор требований'),
    );
    const structure = bodies.filter((b) =>
      (b.messages?.[0]?.content ?? '').includes('архитектор дерева требований'),
    );
    expect(extraction).toHaveLength(2);
    expect(structure).toHaveLength(1);
    // Structure-вызов (Task 14): три секции — карта архива, полный список
    // допустимых родителей (TYPE\tимя) и батч с провенансом (TYPE\tимя\tисточник
    // из extraction-ответа мока «mock.md § …»).
    const structureUser = structure[0]?.messages?.find((m) => m.role === 'user')?.content ?? '';
    expect(structureUser).toContain('Структура архива (файлы документации):');
    expect(structureUser).toContain('Полный список требований (допустимые родители):');
    expect(structureUser).toContain('Батч (2 шт., формат: тип, имя и источник через табуляцию):');
    expect(structureUser).toContain(`FUNCTION\t${IMP_FUNCTION}\tmock.md § Вход`);
    expect(structureUser).toContain(`NFR\t${IMP_NFR}\tmock.md § Производительность`);
  });

  /* e1) 500 на completions: читабельная ошибка, история цела. */

  test('fault: 500 от апстрима → читабельная ошибка в чате, история сохраняется', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'MS-500');
    await openWidget(page);
    await sendMessage(page, 'Успешный вопрос до аварии.');
    await expect(page.getByTestId('chat-msg-assistant')).toContainText(MOCK_CHAT_REPLY);

    await addExpectation({
      id: 'e2e-fault-500',
      priority: 30,
      httpRequest: { method: 'POST', path: COMPLETIONS_PATH },
      httpResponse: {
        statusCode: 500,
        headers: { 'Content-Type': ['application/json'] },
        body: { error: { message: 'mock upstream exploded', type: 'server_error' } },
      },
    });
    try {
      const [apiRes] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === '/api/ai/chat'),
        sendMessage(page, 'Вопрос во время аварии 500.'),
      ]);
      // openai-SDK ретраит 5xx (maxRetries 1 после фикса) → ошибка с небольшим лагом.
      const error = page.getByTestId('chat-error');
      await expect(error).toBeVisible({ timeout: 20_000 });
      expect(apiRes.status()).toBe(502);
      const text = (await error.textContent()) ?? '';
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toContain(MOCK_KEY);
      note(testInfo, 'observed', `500 → чат: «${text}»`);

      // История цела: 2 вопроса + 1 успешный ответ.
      await expect(page.getByTestId('chat-msg-user')).toHaveCount(2);
      await expect(page.getByTestId('chat-msg-assistant')).toHaveCount(1);
      await attachShot(page, testInfo, 'ms-fault-500');

      // T5 (todo_17): «Повторить» после устранения аварии (снимаем
      // fault-expectation) переотправляет ту же историю БЕЗ дублирования
      // вопроса — конец-в-конец через настоящий MockServer.
      await expect(error).toContainText('Не удалось отправить:');
      await clearExpectation('e2e-fault-500');
      await page.getByTestId('chat-retry').click();
      await expect(page.getByTestId('chat-msg-assistant')).toHaveCount(2, { timeout: 20_000 });
      await expect(page.getByTestId('chat-msg-user')).toHaveCount(2); // не продублирован
      await expect(page.getByTestId('chat-error')).toHaveCount(0);
      await attachShot(page, testInfo, 'ms-fault-500-retried');
    } finally {
      await clearExpectation('e2e-fault-500');
    }
  });

  /* e2) 401: читабельно, ключ не утёк в текст ошибки. */

  test('fault: 401 от апстрима → читабельная ошибка без утечки ключа', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'MS-401');
    await openWidget(page);

    await addExpectation({
      id: 'e2e-fault-401',
      priority: 30,
      httpRequest: { method: 'POST', path: COMPLETIONS_PATH },
      httpResponse: {
        statusCode: 401,
        headers: { 'Content-Type': ['application/json'] },
        body: { error: { message: 'Invalid API key provided', type: 'invalid_request_error' } },
      },
    });
    try {
      const [apiRes] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === '/api/ai/chat'),
        sendMessage(page, 'Вопрос при 401.'),
      ]);
      const error = page.getByTestId('chat-error');
      await expect(error).toBeVisible({ timeout: 15_000 });
      expect(apiRes.status()).toBe(502);
      const text = (await error.textContent()) ?? '';
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toContain(MOCK_KEY); // ключ не «эхается» в сообщение
      note(testInfo, 'observed', `401 → чат: «${text}»`);
      await attachShot(page, testInfo, 'ms-fault-401');
    } finally {
      await clearExpectation('e2e-fault-401');
    }
  });

  /* e3) delay 8s: «печатает…» виден, UI жив, ответ приходит; замер. */

  test('fault: delay 8s → «печатает…», UI не завис, ответ приходит (замер)', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'MS-Slow8');
    await openWidget(page);

    const SLOW_REPLY = 'Медленный (8с) ответ ассистента из MockServer.';
    await addExpectation({
      id: 'e2e-delay-8',
      priority: 30,
      httpRequest: { method: 'POST', path: COMPLETIONS_PATH },
      httpResponse: {
        statusCode: 200,
        headers: { 'Content-Type': ['application/json'] },
        body: chatCompletionBody(SLOW_REPLY),
        delay: { timeUnit: 'SECONDS', value: 8 },
      },
    });
    try {
      const started = Date.now();
      await sendMessage(page, 'Медленный вопрос (8с).');

      // Индикатор «печатает…» появляется и UI остаётся отзывчивым: черновик
      // следующего сообщения набирается прямо во время ожидания.
      await expect(page.getByTestId('chat-typing')).toBeVisible();
      await page.getByTestId('chat-input').fill('Черновик, пока ассистент печатает…');
      await expect(page.getByTestId('chat-input')).toHaveValue(
        'Черновик, пока ассистент печатает…',
      );
      await attachShot(page, testInfo, 'ms-delay8-typing');

      await expect(page.getByTestId('chat-msg-assistant')).toContainText(SLOW_REPLY, {
        timeout: 25_000,
      });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(7_000);
      await expect(page.getByTestId('chat-typing')).toHaveCount(0);
      note(testInfo, 'measure', `delay 8s: ответ отрисован через ${elapsed} мс после отправки`);
    } finally {
      await clearExpectation('e2e-delay-8');
    }
  });

  /* e4) ОХОТА №1 · delay 70s: есть ли у портала разумный таймаут апстрима? */

  test('fault: delay 70s → таймаут апстрима: читабельная ошибка ≤90с (замер)', async ({
    page,
  }, testInfo) => {
    // Бэкенд-фикс БАГ №1: openai-клиент теперь timeout 40 000 мс per-attempt и
    // maxRetries 1 → худший случай ~80с (2 попытки × 40с + бэкофф), после чего
    // AiUpstreamError 502 с «Request timed out» в цепочке причин.
    test.setTimeout(150_000); // собственный потолок; ошибку ждём максимум 90с
    await projectWithAi(page, 'MS-Slow70');
    await openWidget(page);

    const VERY_SLOW_REPLY = 'Очень медленный (70с) ответ ассистента из MockServer.';
    await addExpectation({
      id: 'e2e-delay-70',
      priority: 30,
      httpRequest: { method: 'POST', path: COMPLETIONS_PATH },
      httpResponse: {
        statusCode: 200,
        headers: { 'Content-Type': ['application/json'] },
        body: chatCompletionBody(VERY_SLOW_REPLY),
        delay: { timeUnit: 'SECONDS', value: 70 },
      },
    });
    try {
      const started = Date.now();
      await sendMessage(page, 'Очень медленный вопрос (70с).');
      await expect(page.getByTestId('chat-typing')).toBeVisible();

      // Ответ прийти НЕ должен (обе попытки обрываются на 40-й секунде);
      // ошибка обязана появиться в пределах 90с.
      const error = page.getByTestId('chat-error');
      await expect(error).toBeVisible({ timeout: 90_000 });
      const elapsed = Date.now() - started;
      const text = (await error.textContent()) ?? '';
      await attachShot(page, testInfo, 'ms-delay70-outcome');
      note(testInfo, 'measure', `delay 70s: ошибка таймаута через ${elapsed} мс; текст: «${text}»`);

      // Читабельно, без утечки ключа, и это именно ошибка, а не «answer».
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toContain(MOCK_KEY);
      await expect(page.getByTestId('chat-msg-assistant')).toHaveCount(0);
      await expect(page.getByTestId('chat-typing')).toHaveCount(0);
      // Первая попытка рвётся не раньше ~40с; всё вместе укладывается в 90с.
      expect(elapsed).toBeGreaterThanOrEqual(35_000);
      expect(elapsed).toBeLessThanOrEqual(90_000);
      // История цела: вопрос пользователя остался в ленте.
      await expect(page.getByTestId('chat-msg-user')).toHaveCount(1);
    } finally {
      await clearExpectation('e2e-delay-70');
    }
  });

  /* e5) dropConnection: обрыв соединения апстрима. */

  test('fault: dropConnection → 502 с читабельным сообщением', async ({ page }, testInfo) => {
    await projectWithAi(page, 'MS-Drop');
    await openWidget(page);

    await addExpectation({
      id: 'e2e-drop',
      priority: 30,
      httpRequest: { method: 'POST', path: COMPLETIONS_PATH },
      httpError: { dropConnection: true },
    });
    try {
      const [apiRes] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === '/api/ai/chat'),
        sendMessage(page, 'Вопрос при обрыве соединения.'),
      ]);
      // SDK ретраит connection error (maxRetries 1) → ошибка с небольшим лагом.
      const error = page.getByTestId('chat-error');
      await expect(error).toBeVisible({ timeout: 20_000 });
      const text = (await error.textContent()) ?? '';
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toContain(MOCK_KEY);
      note(
        testInfo,
        'observed',
        `dropConnection → HTTP ${apiRes.status()} /api/ai/chat; чат: «${text}»`,
      );
      expect(apiRes.status()).toBe(502);
      await attachShot(page, testInfo, 'ms-fault-drop');
    } finally {
      await clearExpectation('e2e-drop');
    }
  });

  /* e6) Невалидный JSON (200 + text «oops not json» под application/json). */

  test('fault: невалидный JSON от апстрима → читабельная ошибка, не зависание', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'MS-BadJson');
    await openWidget(page);

    await addExpectation({
      id: 'e2e-bad-json',
      priority: 30,
      httpRequest: { method: 'POST', path: COMPLETIONS_PATH },
      httpResponse: {
        statusCode: 200,
        body: { type: 'STRING', string: 'oops not json', contentType: 'application/json' },
      },
    });
    try {
      const [apiRes] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === '/api/ai/chat'),
        sendMessage(page, 'Вопрос при кривом JSON.'),
      ]);
      const error = page.getByTestId('chat-error');
      await expect(error).toBeVisible({ timeout: 20_000 });
      const text = (await error.textContent()) ?? '';
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toContain(MOCK_KEY);
      note(
        testInfo,
        'observed',
        `невалидный JSON → HTTP ${apiRes.status()} /api/ai/chat; чат: «${text}»`,
      );
      expect(apiRes.status()).toBe(502);
      await attachShot(page, testInfo, 'ms-fault-badjson');
    } finally {
      await clearExpectation('e2e-bad-json');
    }
  });

  /* e7) Пустой choices: [] → читабельная ошибка (end-to-end подтверждение). */

  test('fault: пустой choices [] → читабельная ошибка «пустой ответ»', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'MS-Empty');
    await openWidget(page);

    await addExpectation({
      id: 'e2e-empty-choices',
      priority: 30,
      httpRequest: { method: 'POST', path: COMPLETIONS_PATH },
      httpResponse: {
        statusCode: 200,
        headers: { 'Content-Type': ['application/json'] },
        body: { id: 'chatcmpl-empty', object: 'chat.completion', choices: [] },
      },
    });
    try {
      const [apiRes] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === '/api/ai/chat'),
        sendMessage(page, 'Вопрос при пустом choices.'),
      ]);
      const error = page.getByTestId('chat-error');
      await expect(error).toBeVisible({ timeout: 15_000 });
      expect(apiRes.status()).toBe(502);
      const text = (await error.textContent()) ?? '';
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toContain(MOCK_KEY);
      note(testInfo, 'observed', `пустой choices → чат: «${text}»`);
    } finally {
      await clearExpectation('e2e-empty-choices');
    }
  });

  /* f) Верификация отсутствия утечек ключа в телах запросов к апстриму. */

  test('утечек нет: apiKey отсутствует в телах/путях запросов к апстриму (только Authorization)', async () => {
    // Журнал MockServer накопил все запросы предыдущих сценариев этого файла
    // (models, chat, generation, extraction, fault-повторы SDK).
    const recorded = await retrieveRequests({ path: '/openai/v1/.*' });
    expect(recorded.length).toBeGreaterThan(0);

    for (const req of recorded) {
      // Тело не должно содержать ключ ни в каком виде.
      expect(bodyAsString(req), `тело ${req.method} ${req.path} содержит apiKey`).not.toContain(
        MOCK_KEY,
      );
      // Путь и query тоже чистые (ключ не передаётся параметром URL).
      expect(String(req.path ?? ''), 'apiKey в path').not.toContain(MOCK_KEY);
      expect(JSON.stringify(req.queryStringParameters ?? {}), 'apiKey в query').not.toContain(
        MOCK_KEY,
      );
      // Единственное разрешённое место — заголовок Authorization.
      for (const [name, values] of Object.entries(req.headers ?? {})) {
        if (name.toLowerCase() === 'authorization') continue;
        expect(
          JSON.stringify(values),
          `apiKey в заголовке ${name} у ${req.method} ${req.path}`,
        ).not.toContain(MOCK_KEY);
      }
    }
  });
});
