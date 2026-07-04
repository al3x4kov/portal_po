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
 */
async function configureAi(page: Page, id: string): Promise<void> {
  await page.goto(`/p/${id}/ai`);
  await expect(page.getByTestId('ai-page')).toBeVisible();

  await page.getByTestId('ai-baseurl-input').fill(stubBaseUrl);
  await page.getByTestId('ai-key-input').fill('sk-e2e-test-key');
  await page.getByTestId('ai-load-models').click();

  // Models loaded → success status + populated select.
  const status = page.getByTestId('ai-status');
  await expect(status.locator('[data-state="success"]')).toBeVisible();
  const select = page.getByTestId('ai-model-select');
  await expect(select).toBeVisible();
  await select.selectOption('GigaChat-2-Pro');

  await page.getByTestId('ai-save').click();
  await expect(status.locator('[data-state="success"]')).toBeVisible();
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

    await page.getByTestId('ai-load-models').click();

    const status = page.getByTestId('ai-status');
    await expect(status.locator('[data-state="success"]')).toBeVisible();

    // Both stub models are offered in the select.
    const select = page.getByTestId('ai-model-select');
    await expect(select).toBeVisible();
    for (const m of STUB_MODELS) {
      await expect(select.locator(`option[value="${m}"]`)).toHaveCount(1);
    }

    await select.selectOption('GigaChat-2-Pro');
    await page.getByTestId('ai-save').click();
    await expect(status.locator('[data-state="success"]')).toBeVisible();

    // Key persisted & masked: "saved" badge shown, input cleared (never re-shown).
    await expect(page.getByTestId('ai-key-saved')).toBeVisible();
    await expect(page.getByTestId('ai-key-input')).toHaveValue('');

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'ai-screen.png'), fullPage: true });
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

    await page.getByTestId('ai-gen-apply').click();

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
