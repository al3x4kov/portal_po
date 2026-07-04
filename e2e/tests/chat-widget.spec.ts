import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startAiStub, type AiStub } from './helpers/ai-stub.js';
import { createProject, projectIdFromUrl, uniqueName } from './helpers/app.js';

/**
 * Task 9 · E2E for the floating AI chat widget (spec §4 matrix).
 *
 * The widget is mounted globally (App.tsx), so the FAB must be present on
 * every screen. Chat requests go to `POST /api/ai/chat`; the upstream is the
 * shared OpenAI-compatible stub from task 8 (helpers/ai-stub.ts), pointed at
 * via `PUT /api/ai/config`. The stub captures each `/chat/completions` body so
 * the model-override and history behaviour can be asserted end-to-end.
 *
 * ORDER MATTERS inside this file: the AI config (`.ai-config.json` in
 * PROJECTS_ROOT) is global — and ai-hub.spec.ts (task 8) runs before this file
 * and stores a key. So the «no key» scenario clears the stored key through the
 * official API (`PUT /api/ai/config {apiKey: null}`, task 10), and every
 * «with key» scenario re-configures explicitly afterwards.
 */

const STUB_MODELS = ['GigaChat-2-Pro', 'GigaChat-2'];
const STUB_REPLY = 'Стабовый ответ ассистента: краткое пояснение по требованиям.';

let stub: AiStub;

test.beforeAll(async () => {
  stub = await startAiStub({ models: STUB_MODELS, reply: STUB_REPLY });
});

test.afterAll(async () => {
  await stub.close();
});

/** Global AI config → no key: official API reset (task 10, `apiKey: null`). */
async function resetAiConfig(page: Page): Promise<void> {
  const res = await page.request.put('/api/ai/config', { data: { apiKey: null } });
  if (!res.ok()) throw new Error(`PUT /api/ai/config {apiKey:null} failed (${res.status()})`);
}

/** Store key+baseURL (global) and the model for `projectId` via the API. */
async function configureAi(page: Page, projectId: string, model: string): Promise<void> {
  const res = await page.request.put('/api/ai/config', {
    data: { baseURL: stub.baseUrl, apiKey: 'sk-e2e-chat-key', projectId, model },
  });
  if (!res.ok()) throw new Error(`PUT /api/ai/config failed (${res.status()})`);
}

/** Click the FAB and wait for the expanded widget. */
async function openWidget(page: Page): Promise<void> {
  await page.getByTestId('chat-fab').click();
  await expect(page.getByTestId('chat-widget')).toBeVisible();
  await expect(page.getByTestId('chat-fab')).toHaveCount(0);
}

/** Type a message and send it with the button; waits for the user bubble. */
async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId('chat-input').fill(text);
  await expect(page.getByTestId('chat-send')).toBeEnabled();
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-msg-user').filter({ hasText: text })).toBeVisible();
}

/** Attach a full-page screenshot to the test artifacts (no snapshot compare). */
async function attachShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

test.describe('Task 9 · плавающий AI-чат', () => {
  /* ── 1. FAB присутствует везде; открытие/закрытие ─────────────────────── */

  test('FAB виден на старте и в проекте; клик открывает виджет, X сворачивает', async ({
    page,
  }, testInfo) => {
    // Start screen.
    await page.goto('/');
    await expect(page.getByTestId('start-page')).toBeVisible();
    await expect(page.getByTestId('chat-fab')).toBeVisible();

    // Project (main) screen — the widget is mounted globally.
    await createProject(page, uniqueName('Chat-Fab'));
    await expect(page.getByTestId('chat-fab')).toBeVisible();

    // Click (no drag) opens the widget and hides the FAB.
    await openWidget(page);
    await expect(page.getByTestId('chat-messages')).toBeVisible();
    await expect(page.getByTestId('chat-empty')).toBeVisible();
    await attachShot(page, testInfo, 'widget-open');

    // X collapses back to the FAB.
    await page.getByTestId('chat-close').click();
    await expect(page.getByTestId('chat-widget')).toHaveCount(0);
    await expect(page.getByTestId('chat-fab')).toBeVisible();
  });

  /* ── 2. Без ключа: серый селект + тултип + disabled send ──────────────── */

  test('без API-ключа: селект модели disabled с тултипом, отправка disabled', async ({
    page,
  }, testInfo) => {
    // Clear the stored key BEFORE the app loads (ai-hub.spec.ts stored one).
    await resetAiConfig(page);

    await page.goto('/');
    await openWidget(page);

    // Model select is disabled and wrapped in the hint with a title tooltip.
    await expect(page.getByTestId('chat-model-select')).toBeDisabled();
    const hint = page.getByTestId('chat-model-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveAttribute('title', /API-ключ/);

    // Composer: send stays disabled even with text typed.
    await page.getByTestId('chat-input').fill('Привет!');
    await expect(page.getByTestId('chat-send')).toBeDisabled();

    // Empty state explains how to enable the feature.
    await expect(page.getByTestId('chat-empty')).toContainText('настройте AI Hub');
    await attachShot(page, testInfo, 'widget-no-key');
  });

  /* ── 3. Drag FAB: перемещение не открывает виджет ─────────────────────── */

  test('drag FAB перемещает кнопку и не открывает виджет; клик после — открывает', async ({
    page,
  }) => {
    await page.goto('/');
    const fab = page.getByTestId('chat-fab');
    await expect(fab).toBeVisible();

    const before = await fab.boundingBox();
    if (!before) throw new Error('FAB has no bounding box');

    // Pointer-drag well beyond the 5px click-vs-drag threshold.
    const startX = before.x + before.width / 2;
    const startY = before.y + before.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 250, startY - 350, { steps: 12 });
    await page.mouse.up();

    // Drag must NOT open the widget; the FAB stays, repositioned.
    await expect(page.getByTestId('chat-widget')).toHaveCount(0);
    await expect(fab).toBeVisible();
    const after = await fab.boundingBox();
    if (!after) throw new Error('FAB has no bounding box after drag');
    expect(after.x).toBeLessThan(before.x - 200);
    expect(after.y).toBeLessThan(before.y - 300);

    // A plain click afterwards still opens the widget.
    await openWidget(page);
  });

  test('drag виджета за header перемещает карточку', async ({ page }) => {
    await page.goto('/');
    await openWidget(page);
    const widget = page.getByTestId('chat-widget');

    const before = await widget.boundingBox();
    if (!before) throw new Error('widget has no bounding box');

    // Grab the header padding area (left edge, clear of select/buttons).
    await page.mouse.move(before.x + 6, before.y + 18);
    await page.mouse.down();
    await page.mouse.move(before.x + 6 - 180, before.y + 18 - 120, { steps: 10 });
    await page.mouse.up();

    await expect(widget).toBeVisible();
    const after = await widget.boundingBox();
    if (!after) throw new Error('widget has no bounding box after drag');
    expect(after.x).toBeLessThan(before.x - 100);
    expect(after.y).toBeLessThan(before.y - 60);
  });

  /* ── 4. С ключом: отправка/ответ, сохранение после X, новый чат ───────── */

  test('с ключом: отправка и ответ ассистента; X сохраняет переписку; новый чат очищает', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('Chat-Talk'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'GigaChat-2-Pro');

    await openWidget(page);
    // Configured project → select enabled with the per-project model.
    const select = page.getByTestId('chat-model-select');
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue('GigaChat-2-Pro');
    await expect(page.getByTestId('chat-model-hint')).toHaveCount(0);

    // First exchange: user bubble, then assistant bubble with the stub reply.
    await sendMessage(page, 'Привет! Что такое критичность требования?');
    await expect(page.getByTestId('chat-msg-assistant')).toContainText(STUB_REPLY);

    // Second exchange via Enter — the history accumulates.
    await page.getByTestId('chat-input').fill('А что такое NFR?');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('chat-msg-user')).toHaveCount(2);
    await expect(page.getByTestId('chat-msg-assistant')).toHaveCount(2);

    // The upstream received the running history: user, assistant, user (+system prompt server-side).
    const last = stub.lastChatRequest();
    expect(last?.model).toBe('GigaChat-2-Pro');
    const roles = (last?.messages ?? []).map((m) => m.role);
    expect(roles.filter((r) => r === 'user')).toHaveLength(2);
    expect(roles.filter((r) => r === 'assistant')).toHaveLength(1);
    await attachShot(page, testInfo, 'widget-conversation');

    // X collapses; reopening shows the SAME conversation (store in memory).
    await page.getByTestId('chat-close').click();
    await expect(page.getByTestId('chat-widget')).toHaveCount(0);
    await openWidget(page);
    await expect(page.getByTestId('chat-msg-user')).toHaveCount(2);
    await expect(page.getByTestId('chat-msg-assistant')).toHaveCount(2);

    // «Новый чат» clears the feed back to the empty state.
    await page.getByTestId('chat-new').click();
    await expect(page.getByTestId('chat-msg-user')).toHaveCount(0);
    await expect(page.getByTestId('chat-msg-assistant')).toHaveCount(0);
    await expect(page.getByTestId('chat-empty')).toBeVisible();
  });

  /* ── 5. Esc внутри панели сворачивает; переписка И черновик выживают ──── */

  test('Esc при фокусе внутри виджета сворачивает его; переписка и черновик сохраняются; Esc вне чата не сворачивает', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('Chat-Esc'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'GigaChat-2-Pro');
    await openWidget(page);

    // One full exchange so there is a conversation to preserve.
    await sendMessage(page, 'Вопрос до сворачивания по Esc.');
    await expect(page.getByTestId('chat-msg-assistant')).toContainText(STUB_REPLY);

    // Unsent draft typed into chat-input; typing leaves focus in the textarea.
    const draft = 'Незаконченный черновик про NFR…';
    const input = page.getByTestId('chat-input');
    await input.click();
    await input.fill(draft);
    await expect(input).toBeFocused();

    // Esc with focus INSIDE the panel (task-12 fix: onKeyDown on chat-widget,
    // not a document-level listener) collapses the widget back to the FAB.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('chat-widget')).toHaveCount(0);
    await expect(page.getByTestId('chat-fab')).toBeVisible();

    // Reopen: SAME conversation AND the SAME unsent draft (both store-backed).
    await openWidget(page);
    await expect(page.getByTestId('chat-msg-user')).toHaveCount(1);
    await expect(
      page.getByTestId('chat-msg-user').filter({ hasText: 'Вопрос до сворачивания по Esc.' }),
    ).toBeVisible();
    await expect(page.getByTestId('chat-msg-assistant')).toHaveCount(1);
    await expect(input).toHaveValue(draft);
    await attachShot(page, testInfo, 'widget-esc-conversation-and-draft-restored');

    // Esc with focus OUTSIDE the chat (blurred to <body>) must NOT collapse:
    // the handler lives on the panel, so the key never reaches it.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('chat-widget')).toBeVisible();
    await expect(input).toHaveValue(draft); // draft untouched by the no-op Esc

    // Leave the page clean for neighbouring tests.
    await page.getByTestId('chat-close').click();
    await expect(page.getByTestId('chat-fab')).toBeVisible();
  });

  /* ── 6. Override модели доходит до апстрима ───────────────────────────── */

  test('выбор модели в виджете переопределяет модель проекта в запросе к апстриму', async ({
    page,
  }) => {
    await createProject(page, uniqueName('Chat-Override'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'GigaChat-2-Pro');

    await openWidget(page);
    const select = page.getByTestId('chat-model-select');
    await expect(select).toHaveValue('GigaChat-2-Pro');
    // Models loaded from the stub → the alternative is offered.
    await expect(select.locator('option[value="GigaChat-2"]')).toHaveCount(1);
    await select.selectOption('GigaChat-2');

    await sendMessage(page, 'Ответь коротко.');
    await expect(page.getByTestId('chat-msg-assistant')).toContainText(STUB_REPLY);

    // The stub saw the override, not the per-project model.
    expect(stub.lastChatRequest()?.model).toBe('GigaChat-2');
  });

  /* ── 7. Ошибка апстрима: chat-error, история не стирается ─────────────── */

  test('ошибка апстрима: читабельное сообщение в ленте, история сохраняется', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('Chat-Err'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'GigaChat-2-Pro');

    await openWidget(page);
    // Successful exchange first, so there is history to preserve.
    await sendMessage(page, 'Первый вопрос.');
    await expect(page.getByTestId('chat-msg-assistant')).toContainText(STUB_REPLY);

    stub.setChatMode('error');
    try {
      await sendMessage(page, 'Второй вопрос.');
      const error = page.getByTestId('chat-error');
      await expect(error).toBeVisible();
      // Readable and sanitized: non-empty text, the API key never leaks.
      await expect(error).not.toHaveText('');
      await expect(error).not.toContainText('sk-e2e-chat-key');

      // History intact: both user bubbles and the first assistant reply.
      await expect(page.getByTestId('chat-msg-user')).toHaveCount(2);
      await expect(page.getByTestId('chat-msg-assistant')).toHaveCount(1);
      await attachShot(page, testInfo, 'widget-upstream-error');
    } finally {
      stub.setChatMode('ok');
    }
  });
});
