import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startAiStub, type AiStub } from './helpers/ai-stub.js';
import { createProject, uniqueName } from './helpers/app.js';

/**
 * T-804 · E2E for the AI Hub feature (Task 8).
 *
 * The real external AI Hub is unreachable from CI, and the app's AI client
 * always uses the `baseURL` from the SAVED config (`PUT /api/ai/config`) — an
 * `openai`-SDK wrapper that does `GET <baseURL>/models` and
 * `POST <baseURL>/chat/completions`. So we stand up a tiny OpenAI-compatible
 * HTTP stub on 127.0.0.1 and point the UI's Base URL at it. The app server runs
 * as a separate process on the same host, so it reaches the stub over loopback.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

// Fixed model list and description the stub returns — assertions key off these.
const STUB_MODELS = ['GigaChat-2-Pro', 'GigaChat-2'];
const STUB_DESC =
  'Система должна валидировать вводимые данные и отображать понятное сообщение об ошибке при некорректном вводе.';

let stub: AiStub;
let stubBaseUrl: string;

test.beforeAll(async () => {
  // Shared stub helper (e2e/tests/helpers/ai-stub.ts); also used by task 9.
  stub = await startAiStub({ models: STUB_MODELS, reply: STUB_DESC });
  stubBaseUrl = stub.baseUrl;
});

test.afterAll(async () => {
  await stub.close();
});

/** id from a `/p/:id/...` URL (works on AI/dashboard/main routes). */
function projectId(page: Page): string {
  const m = /\/p\/([^/?#]+)/.exec(page.url());
  if (!m) throw new Error(`Not on a project page: ${page.url()}`);
  return decodeURIComponent(m[1]);
}

/**
 * Full AI-Hub setup for the CURRENT project: open the AI screen, enter the stub
 * Base URL + a key, load models, pick a model and save. Leaves the page on the
 * AI screen with the config persisted (key global, model per-project).
 *
 * T5 (todo_17): the dedicated «Сохранить и загрузить модели» button is gone —
 * «Обновить список» (ai-models-refresh) with a freshly typed key saves the
 * config first and then loads the models; the ONE «Сохранить» (ai-save) writes
 * key + model + base URL together.
 */
async function configureAi(page: Page, id: string): Promise<void> {
  await page.goto(`/p/${id}/ai`);
  await expect(page.getByTestId('ai-page')).toBeVisible();

  await page.getByTestId('ai-baseurl-input').fill(stubBaseUrl);
  await page.getByTestId('ai-key-input').fill('sk-e2e-test-key');
  await page.getByTestId('ai-models-refresh').click();

  // Key saved + models loaded → success status under the save button.
  const status = page.getByTestId('ai-status');
  await expect(status.locator('[data-state="success"]')).toBeVisible();
  await expect(status).toContainText('Подключение успешно');
  const select = page.getByTestId('ai-model-select');
  await expect(select).toBeVisible();
  await select.selectOption('GigaChat-2-Pro');

  await page.getByTestId('ai-save').click();
  await expect(status.locator('[data-state="success"]')).toContainText('Настройки сохранены');
  // Key is now stored and never echoed back.
  await expect(page.getByTestId('ai-key-saved')).toBeVisible();
}

/** Open the "add requirement" modal and fill name + criticality (+opt. description). */
async function openNewRequirement(
  page: Page,
  opts: { name: string; description?: string },
): Promise<void> {
  await page.getByTestId('add-function').click();
  await expect(page.getByTestId('requirement-modal')).toBeVisible();
  await page.getByTestId('req-name').fill(opts.name);
  await page.getByTestId('req-criticality-high').click();
  if (opts.description) await page.getByTestId('req-description').fill(opts.description);
}

test.describe('Task 8 · AI Hub', () => {
  test('навигация: пункт меню AI открывает экран AI', async ({ page }) => {
    const name = uniqueName('AI-Nav');
    await createProject(page, name);

    await page.getByTestId('sidebar-nav-ai').click();
    await expect(page.getByTestId('ai-page')).toBeVisible();
    // T5 (todo_17): benefit-first title instead of the technical «Экран „AI“».
    await expect(page.getByRole('heading', { name: 'Подключение AI' })).toBeVisible();
    // Empty state before any key is entered.
    await expect(page.getByTestId('ai-status').locator('[data-state="empty"]')).toBeVisible();
  });

  test('конфигурация: сохранение ключа/baseURL, загрузка моделей, выбор и сохранение', async ({
    page,
  }) => {
    const name = uniqueName('AI-Config');
    await createProject(page, name);
    const id = projectId(page);

    await page.goto(`/p/${id}/ai`);
    await expect(page.getByTestId('ai-page')).toBeVisible();

    // Before a key: no "saved" badge, status shows the empty hint.
    await expect(page.getByTestId('ai-key-saved')).toHaveCount(0);

    await page.getByTestId('ai-baseurl-input').fill(stubBaseUrl);
    await page.getByTestId('ai-key-input').fill('sk-e2e-secret');
    // Key field is a password (masked) until toggled.
    await expect(page.getByTestId('ai-key-input')).toHaveAttribute('type', 'password');

    // T5 (todo_17): «Обновить список» with a freshly typed key saves the
    // config first (PUT /api/ai/config) and then loads the models.
    await page.getByTestId('ai-models-refresh').click();

    const status = page.getByTestId('ai-status');
    await expect(status.locator('[data-state="success"]')).toBeVisible();
    await expect(status).toContainText('Подключение успешно');
    await expect(status).toContainText('загружено 2');

    // Both stub models are offered in the select.
    const select = page.getByTestId('ai-model-select');
    await expect(select).toBeVisible();
    for (const m of STUB_MODELS) {
      await expect(select.locator(`option[value="${m}"]`)).toHaveCount(1);
    }

    await select.selectOption('GigaChat-2-Pro');
    await page.getByTestId('ai-save').click();
    await expect(status.locator('[data-state="success"]')).toContainText('Настройки сохранены');

    // Key persisted & masked: "saved" badge shown, input cleared (never re-shown).
    await expect(page.getByTestId('ai-key-saved')).toBeVisible();
    await expect(page.getByTestId('ai-key-input')).toHaveValue('');

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'ai-screen.png'), fullPage: true });
  });

  /* T5 (todo_17) · единое сохранение: ОДНА кнопка «Сохранить» пишет ключ +
     модель + base URL вместе; статус — сразу ПОД кнопкой. */

  test('единое сохранение: одна кнопка «Сохранить» пишет ключ+модель+baseURL, статус под кнопкой', async ({
    page,
  }) => {
    // Clean global config so the empty state is deterministic.
    const reset = await page.request.put('/api/ai/config', { data: { apiKey: null } });
    expect(reset.ok()).toBe(true);

    const name = uniqueName('AI-OneSave');
    await createProject(page, name);
    const id = projectId(page);
    await page.goto(`/p/${id}/ai`);
    await expect(page.getByTestId('ai-page')).toBeVisible();

    // The old separate «загрузить модели» button is gone for good.
    await expect(page.getByTestId('ai-load-models')).toHaveCount(0);
    await expect(page.getByTestId('ai-status').locator('[data-state="empty"]')).toBeVisible();

    await page.getByTestId('ai-baseurl-input').fill(stubBaseUrl);
    await page.getByTestId('ai-key-input').fill('sk-e2e-one-save');
    // No model list loaded yet → the manual model input is offered.
    await page.getByTestId('ai-model-manual').fill('GigaChat-2');

    await page.getByTestId('ai-save').click();

    // Success status with the mandated text, positioned UNDER the button.
    const status = page.getByTestId('ai-status');
    await expect(status.locator('[data-state="success"]')).toBeVisible();
    await expect(status).toContainText('Настройки сохранены');
    const saveBox = await page.getByTestId('ai-save').boundingBox();
    const statusBox = await status.boundingBox();
    expect(saveBox && statusBox && statusBox.y > saveBox.y, 'status must sit under Save').toBe(
      true,
    );

    // Key stored (badge, input cleared) — all three fields went in one PUT.
    await expect(page.getByTestId('ai-key-saved')).toBeVisible();
    await expect(page.getByTestId('ai-key-input')).toHaveValue('');
    const res = await page.request.get(`/api/ai/config?projectId=${encodeURIComponent(id)}`);
    expect(res.ok()).toBe(true);
    const view = (await res.json()) as { hasApiKey: boolean; model?: string; baseURL?: string };
    expect(view.hasApiKey).toBe(true);
    expect(view.model).toBe('GigaChat-2');
    expect(view.baseURL).toBe(stubBaseUrl);
  });

  /* T5 (todo_17) · «Обновить список» с непустым ключом: сначала сохраняет
     конфиг (PUT), затем грузит модели (GET) — статус «Подключение успешно». */

  test('«Обновить список» с непустым ключом: сохраняет конфиг, затем грузит модели', async ({
    page,
  }) => {
    const reset = await page.request.put('/api/ai/config', { data: { apiKey: null } });
    expect(reset.ok()).toBe(true);

    const name = uniqueName('AI-RefreshSave');
    await createProject(page, name);
    const id = projectId(page);
    await page.goto(`/p/${id}/ai`);
    await expect(page.getByTestId('ai-page')).toBeVisible();

    await page.getByTestId('ai-baseurl-input').fill(stubBaseUrl);
    await page.getByTestId('ai-key-input').fill('sk-e2e-refresh-saves');

    // One click → the config PUT goes out first, then the models GET.
    const [putRes, getRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'PUT' && r.url().includes('/api/ai/config'),
      ),
      page.waitForResponse(
        (r) => r.request().method() === 'GET' && r.url().includes('/api/ai/models'),
      ),
      page.getByTestId('ai-models-refresh').click(),
    ]);
    expect(putRes.ok()).toBe(true);
    expect(getRes.status()).toBe(200);

    // Status under the button: connection verified + models counted.
    const status = page.getByTestId('ai-status');
    await expect(status.locator('[data-state="success"]')).toBeVisible();
    await expect(status).toContainText('Подключение успешно');
    await expect(status).toContainText('загружено 2');

    // Models offered; nothing was chosen before → the first one auto-selected.
    const select = page.getByTestId('ai-model-select');
    await expect(select).toBeVisible();
    for (const m of STUB_MODELS) {
      await expect(select.locator(`option[value="${m}"]`)).toHaveCount(1);
    }

    // The key is genuinely SAVED by the refresh flow (badge + API truth).
    await expect(page.getByTestId('ai-key-saved')).toBeVisible();
    await expect(page.getByTestId('ai-key-input')).toHaveValue('');
    const res = await page.request.get('/api/ai/config');
    expect(res.ok()).toBe(true);
    expect(((await res.json()) as { hasApiKey: boolean }).hasApiKey).toBe(true);
  });

  test('генерация: превью описания и применение (append, исходное сохраняется)', async ({
    page,
  }) => {
    const name = uniqueName('AI-Gen');
    await createProject(page, name);
    const id = projectId(page);
    await configureAi(page, id);

    // Back to requirements.
    await page.getByTestId('sidebar-nav-requirements').click();
    await expect(page.getByTestId('main-page')).toBeVisible();

    const initial = 'Исходное описание, введённое пользователем.';
    await openNewRequirement(page, { name: uniqueName('Req'), description: initial });

    // Config resolves → generate button becomes enabled (not the disabled stub).
    const genOpen = page.getByTestId('ai-gen-open');
    await expect(genOpen).toBeEnabled();
    await genOpen.click();

    // Hint panel → submit.
    await expect(page.getByTestId('ai-gen-hint')).toBeVisible();
    await page.getByTestId('ai-gen-submit').click();

    // Preview contains the stub text.
    const preview = page.getByTestId('ai-gen-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(STUB_DESC);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ai-generation.png'),
      fullPage: true,
    });

    // T4 (todo_17): «Дополнить» (ai-gen-append) appends; «Заменить описание»
    // (ai-gen-apply) would replace the text wholesale.
    await page.getByTestId('ai-gen-append').click();

    // Applied = appended after the original, on a new line — original preserved.
    await expect(page.getByTestId('req-description')).toHaveValue(`${initial}\n${STUB_DESC}`);
  });

  test('без конфига: кнопка генерации отключена и показывает ссылку на настройку', async ({
    page,
  }) => {
    // Fresh project: the API key may be global, but the per-project model is
    // absent, so the feature is not ready → button disabled + setup link.
    const name = uniqueName('AI-NoCfg');
    await createProject(page, name);

    await openNewRequirement(page, { name: uniqueName('Req') });

    await expect(page.getByTestId('ai-gen-open')).toBeDisabled();
    await expect(page.getByTestId('ai-gen-setup-link')).toBeVisible();
  });

  test('ошибка апстрима: описание не меняется, показано сообщение об ошибке', async ({ page }) => {
    const name = uniqueName('AI-Err');
    await createProject(page, name);
    const id = projectId(page);
    await configureAi(page, id);

    await page.getByTestId('sidebar-nav-requirements').click();
    await expect(page.getByTestId('main-page')).toBeVisible();

    const initial = 'Описание до попытки генерации.';
    await openNewRequirement(page, { name: uniqueName('Req'), description: initial });

    stub.setChatMode('error');
    try {
      await expect(page.getByTestId('ai-gen-open')).toBeEnabled();
      await page.getByTestId('ai-gen-open').click();
      await page.getByTestId('ai-gen-submit').click();

      await expect(page.getByTestId('ai-gen-error')).toBeVisible();
      // Description untouched.
      await expect(page.getByTestId('req-description')).toHaveValue(initial);
    } finally {
      stub.setChatMode('ok');
    }
  });
});

test.describe('Task 10 · удаление API-ключа', () => {
  test('удаление ключа: подтверждение → пустое состояние экрана AI и серый чат', async ({
    page,
  }) => {
    const name = uniqueName('AI-DelKey');
    await createProject(page, name);
    const id = projectId(page);
    await configureAi(page, id);

    // Key stored → the delete button is offered next to the «saved» badge.
    await expect(page.getByTestId('ai-delete-key')).toBeVisible();
    await page.getByTestId('ai-delete-key').click();

    // ConfirmDialog → confirm.
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-confirm').click();

    // Toast + the dialog is gone.
    await expect(page.getByTestId('toast').filter({ hasText: 'API-ключ удалён' })).toBeVisible();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

    // AI screen back to the empty state: no badge, no delete button, empty hint.
    await expect(page.getByTestId('ai-key-saved')).toHaveCount(0);
    await expect(page.getByTestId('ai-delete-key')).toHaveCount(0);
    await expect(page.getByTestId('ai-status').locator('[data-state="empty"]')).toBeVisible();

    // API view: hasApiKey=false, but the per-project model SURVIVES (spec:
    // modelByProject stays untouched so the model is back once a key returns).
    const res = await page.request.get(`/api/ai/config?projectId=${encodeURIComponent(id)}`);
    expect(res.ok()).toBe(true);
    const view = (await res.json()) as { hasApiKey: boolean; model?: string };
    expect(view.hasApiKey).toBe(false);
    expect(view.model).toBe('GigaChat-2-Pro');

    // Chat widget (task 9) greys out immediately — the shared config query is
    // invalidated: disabled model select + tooltip hint + disabled send.
    await page.getByTestId('chat-fab').click();
    await expect(page.getByTestId('chat-widget')).toBeVisible();
    await expect(page.getByTestId('chat-model-select')).toBeDisabled();
    await expect(page.getByTestId('chat-model-hint')).toBeVisible();
    // T5 (todo_17): without a key the composer input itself is disabled.
    await expect(page.getByTestId('chat-input')).toBeDisabled();
    await expect(page.getByTestId('chat-send')).toBeDisabled();

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'ai-key-deleted.png'),
      fullPage: true,
    });
  });

  test('отмена удаления: ключ остаётся сохранённым', async ({ page }) => {
    const name = uniqueName('AI-DelCancel');
    await createProject(page, name);
    const id = projectId(page);
    await configureAi(page, id);

    await page.getByTestId('ai-delete-key').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

    // Key intact: badge and delete button still there, no empty-state hint.
    await expect(page.getByTestId('ai-key-saved')).toBeVisible();
    await expect(page.getByTestId('ai-delete-key')).toBeVisible();
    await expect(page.getByTestId('ai-status').locator('[data-state="empty"]')).toHaveCount(0);

    const res = await page.request.get('/api/ai/config');
    expect(res.ok()).toBe(true);
    expect(((await res.json()) as { hasApiKey: boolean }).hasApiKey).toBe(true);
  });

  test('API: apiKey="" не трогает ключ, apiKey=null удаляет его', async ({ request }) => {
    const getHasKey = async (): Promise<boolean> => {
      const res = await request.get('/api/ai/config');
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { hasApiKey: boolean }).hasApiKey;
    };

    // Arrange: store a key via the API.
    const saved = await request.put('/api/ai/config', {
      data: { baseURL: stubBaseUrl, apiKey: 'sk-e2e-task10' },
    });
    expect(saved.ok()).toBe(true);
    expect(((await saved.json()) as { hasApiKey: boolean }).hasApiKey).toBe(true);

    // '' keeps the task-8 semantics: the stored key is NOT touched.
    const blank = await request.put('/api/ai/config', { data: { apiKey: '' } });
    expect(blank.ok()).toBe(true);
    expect(((await blank.json()) as { hasApiKey: boolean }).hasApiKey).toBe(true);
    expect(await getHasKey()).toBe(true);

    // Explicit null deletes the key (task 10).
    const del = await request.put('/api/ai/config', { data: { apiKey: null } });
    expect(del.ok()).toBe(true);
    expect(((await del.json()) as { hasApiKey: boolean }).hasApiKey).toBe(false);
    expect(await getHasKey()).toBe(false);
  });
});

/* ── todo_16 A3 · повторный запрос списка моделей на экране AI ───────────── */

test.describe('todo_16 A3 · экран AI: обновление списка моделей', () => {
  test('кнопка обновления перезапрашивает GET /api/ai/models; выбор сохраняется/сбрасывается; смена модели сохраняется в конфиг', async ({
    page,
  }) => {
    const name = uniqueName('AI-Refresh');
    await createProject(page, name);
    const id = projectId(page);
    // UI-флоу задачи 8: ключ+baseURL сохранены, модели загружены,
    // выбрана и сохранена 'GigaChat-2-Pro'.
    await configureAi(page, id);

    const select = page.getByTestId('ai-model-select');
    const refresh = page.getByTestId('ai-models-refresh');
    await expect(refresh).toBeEnabled();

    try {
      // 1) Список не менялся → refetch реально уходит, выбор сохраняется,
      //    уведомления нет.
      const [first] = await Promise.all([
        page.waitForResponse(
          (r) => r.request().method() === 'GET' && r.url().includes('/api/ai/models'),
        ),
        refresh.click(),
      ]);
      expect(first.status()).toBe(200);
      await expect(select).toHaveValue('GigaChat-2-Pro');
      await expect(select.locator('option[value="GigaChat-2"]')).toHaveCount(1);
      await expect(page.getByTestId('ai-models-notice')).toHaveCount(0);

      // 2) Список изменился, выбранная модель исчезла → options обновлены,
      //    выбрана первая из нового списка (сервер сортирует ids по алфавиту:
      //    'GigaChat-2' < 'GigaChat-3-Max'), показано ненавязчивое уведомление.
      stub.setModels(['GigaChat-3-Max', 'GigaChat-2']);
      const [second] = await Promise.all([
        page.waitForResponse(
          (r) => r.request().method() === 'GET' && r.url().includes('/api/ai/models'),
        ),
        refresh.click(),
      ]);
      expect(second.status()).toBe(200);
      await expect(select.locator('option[value="GigaChat-3-Max"]')).toHaveCount(1);
      await expect(select).toHaveValue('GigaChat-2');
      const notice = page.getByTestId('ai-models-notice');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('GigaChat-2-Pro');
      await expect(notice).toContainText('больше недоступна');

      // 3) Селект остаётся активным: смена модели + сохранение применяются
      //    к последующим запросам (модель проекта в конфиге).
      await select.selectOption('GigaChat-3-Max');
      await page.getByTestId('ai-save').click();
      await expect(page.getByTestId('ai-status').locator('[data-state="success"]')).toBeVisible();
      const cfg = await page.request.get(`/api/ai/config?projectId=${encodeURIComponent(id)}`);
      expect(cfg.ok()).toBe(true);
      expect(((await cfg.json()) as { model?: string }).model).toBe('GigaChat-3-Max');
    } finally {
      stub.setModels(null); // общий стаб — вернуть список задачи 8
    }
  });
});
