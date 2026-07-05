import AdmZip from 'adm-zip';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { expectNoSeriousA11y, focusInside } from './helpers/a11y.js';
import { startAiStub, type AiStub } from './helpers/ai-stub.js';
import { addRequirement, createProject, projectIdFromUrl, uniqueName } from './helpers/app.js';

/**
 * Task 12 Q-1 (PO-T3) · a11y of the NEW AI surfaces, same policy as a11y.spec.ts
 * (shared helper, WCAG 2.1 AA tags, zero serious/critical, empty baseline):
 *  (a) axe scans: AI screen (/p/:id/ai, empty + models-loaded states), the open
 *      chat widget, the open AI-import modal, the open export modal;
 *  (b) keyboard access to the chat FAB/widget: the FAB is Tab-reachable and
 *      opens with Enter AND Space; the widget content is Tab-reachable; closing
 *      is keyboard-operable BOTH ways: Escape pressed with focus inside the
 *      panel collapses the widget (onKeyDown on chat-widget itself, task-12
 *      fix — conversation and draft are kept in the store; the draft round-trip
 *      is covered in chat-widget.spec.ts), and the ✕ button (chat-close)
 *      closes via Tab+Enter. The widget stays a NON-modal floating panel:
 *      no focus trap, and Esc with focus OUTSIDE the panel does nothing.
 *  (c) focus-trap of the AI-import modal in the RUNNING state: X opens the
 *      «Прекратить автоматизацию?» ConfirmDialog, focus lands on the SAFE
 *      button («Продолжить анализ»), Tab/Shift+Tab cycle inside the dialog.
 *
 * Upstream AI Hub is the shared stub (helpers/ai-stub.ts); the AI config
 * (.ai-config.json in PROJECTS_ROOT) is global, so every test configures it
 * explicitly via `PUT /api/ai/config` — same discipline as chat-widget.spec.ts.
 */

const STUB_MODELS = ['GigaChat-2-Pro', 'GigaChat-2'];
const STUB_REPLY = 'Стабовый ответ ассистента для a11y-сканов.';

let stub: AiStub;

test.beforeAll(async () => {
  stub = await startAiStub({ models: STUB_MODELS, reply: STUB_REPLY });
});

test.afterAll(async ({ playwright }) => {
  // The API key is GLOBAL (.ai-config.json in PROJECTS_ROOT) and this file
  // runs alphabetically BEFORE ai-hub.spec.ts, whose first tests assert the
  // pristine "no key" empty state — so leave no trace behind (official reset,
  // task-10 semantics: `apiKey: null` deletes the stored key).
  const ctx = await playwright.request.newContext({
    baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 41730}`,
  });
  const res = await ctx.put('/api/ai/config', { data: { apiKey: null } });
  if (!res.ok()) throw new Error(`afterAll AI-config reset failed (${res.status()})`);
  await ctx.dispose();
  await stub.close();
});

/** Store key+baseURL (global) and the model for `projectId` via the API. */
async function configureAi(page: Page, projectId: string, model: string): Promise<void> {
  const res = await page.request.put('/api/ai/config', {
    data: { baseURL: stub.baseUrl, apiKey: 'sk-e2e-a11y-key', projectId, model },
  });
  if (!res.ok()) throw new Error(`PUT /api/ai/config failed (${res.status()})`);
}

/** Attach a full-page screenshot to the test artifacts. */
async function attachShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

/** Build a small zip archive of markdown docs; returns its on-disk path. */
function makeDocsZip(testInfo: TestInfo, name: string, files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [entry, content] of Object.entries(files)) {
    zip.addFile(entry, Buffer.from(content, 'utf8'));
  }
  const target = testInfo.outputPath(name);
  zip.writeZip(target);
  return target;
}

/** Press Tab up to `max` times until `predicate` holds; returns success. */
async function tabUntil(
  page: Page,
  max: number,
  predicate: () => Promise<boolean>,
): Promise<boolean> {
  for (let i = 0; i < max; i += 1) {
    if (await predicate()) return true;
    await page.keyboard.press('Tab');
  }
  return predicate();
}

test.describe('Q-1 · axe-сканы новых AI-поверхностей (0 serious/critical)', () => {
  test('экран AI: пустое состояние и состояние с загруженными моделями', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('a11y-ai'));
    const id = projectIdFromUrl(page);

    await page.goto(`/p/${id}/ai`);
    await expect(page.getByTestId('ai-page')).toBeVisible();
    await expectNoSeriousA11y(page, 'AiPage (empty)');

    // Models loaded → select + success status rendered; scan the richer state.
    // T5 (todo_17): «Обновить список» with a typed key saves + loads models.
    await page.getByTestId('ai-baseurl-input').fill(stub.baseUrl);
    await page.getByTestId('ai-key-input').fill('sk-e2e-a11y-key');
    await page.getByTestId('ai-models-refresh').click();
    await expect(page.getByTestId('ai-status').locator('[data-state="success"]')).toBeVisible();
    await expect(page.getByTestId('ai-model-select')).toBeVisible();
    await expectNoSeriousA11y(page, 'AiPage (models loaded)');
    await attachShot(page, testInfo, 'ai-page-models-loaded');
  });

  test('открытый чат-виджет (настроенный AI): без нарушений', async ({ page }, testInfo) => {
    await createProject(page, uniqueName('a11y-chat'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'GigaChat-2-Pro');

    await page.getByTestId('chat-fab').click();
    await expect(page.getByTestId('chat-widget')).toBeVisible();
    // Configured state: enabled model select + composer — the full surface.
    await expect(page.getByTestId('chat-model-select')).toBeEnabled();
    await expectNoSeriousA11y(page, 'ChatWidget (open, configured)');
    await attachShot(page, testInfo, 'chat-widget-open');
  });

  test('открытая модалка AI-импорта: без нарушений', async ({ page }, testInfo) => {
    await createProject(page, uniqueName('a11y-aiimp'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'GigaChat-2-Pro');
    await page.reload(); // pick up fresh AI config in the UI
    await expect(page.getByTestId('main-page')).toBeVisible();

    await page.getByTestId('footer-ai-import').click();
    await expect(page.getByTestId('ai-import')).toBeVisible();
    await expect(page.getByTestId('ai-import-drop')).toBeVisible();
    await expectNoSeriousA11y(page, 'AiImportModal (idle)');
    await attachShot(page, testInfo, 'ai-import-modal-idle');

    // Idle state closes silently (no confirm) — leave the page clean.
    await page.getByTestId('ai-import-close').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);
  });

  test('открытая модалка экспорта: без нарушений', async ({ page }, testInfo) => {
    await createProject(page, uniqueName('a11y-exp'));
    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('F-a11y-exp'),
      criticality: 'HIGH',
    });

    await page.getByTestId('sidebar-open-export').click();
    await expect(page.getByTestId('export-modal')).toBeVisible();
    await expectNoSeriousA11y(page, 'ExportModal (fields step)');
    await attachShot(page, testInfo, 'export-modal-open');

    await page.getByTestId('export-modal-close').click();
    await expect(page.getByTestId('export-modal')).toHaveCount(0);
  });
});

test.describe('Q-1 · клавиатурный доступ к чат-виджету', () => {
  test('FAB достижим Tab’ом, открывается Enter и Space; фокус достижим внутри виджета; ✕ закрывает с клавиатуры', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    await expect(page.getByTestId('start-page')).toBeVisible();

    // (1) The FAB is reachable with Tab alone (real <button>, natural order).
    const fab = page.getByTestId('chat-fab');
    const fabReached = await tabUntil(page, 30, () =>
      fab.evaluate((el) => el === document.activeElement).catch(() => Promise.resolve(false)),
    );
    expect(fabReached, 'chat-fab is not reachable via Tab within 30 presses').toBe(true);

    // (2) Enter opens the widget (native button activation, no drag involved).
    await page.keyboard.press('Enter');
    const widget = page.getByTestId('chat-widget');
    await expect(widget).toBeVisible();
    await expect(fab).toHaveCount(0);

    // (3) Focus can travel INTO the widget with the keyboard.
    const inside = await tabUntil(page, 40, () => focusInside(page, 'chat-widget'));
    expect(inside, 'focus never entered chat-widget within 40 Tab presses').toBe(true);
    await attachShot(page, testInfo, 'chat-widget-keyboard-focus');

    // (4) Esc with focus INSIDE the panel collapses the widget (task-12 fix:
    // onKeyDown on chat-widget itself, not a global listener). Focus is inside
    // after step (3), so Escape must close and return the FAB.
    await page.keyboard.press('Escape');
    await expect(widget).toHaveCount(0);
    await expect(fab).toBeVisible();

    // Esc with focus OUTSIDE the panel must do nothing to the widget: reopen,
    // move focus to <body>, press Escape — the panel stays (non-modal contract).
    await fab.focus();
    await page.keyboard.press('Enter');
    await expect(widget).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await expect(widget).toBeVisible();

    // (5) Second closing contract, keyboard-operated: Tab to ✕ and press Enter.
    const closeBtn = page.getByTestId('chat-close');
    const closeReached = await tabUntil(page, 40, () =>
      closeBtn.evaluate((el) => el === document.activeElement).catch(() => Promise.resolve(false)),
    );
    expect(closeReached, 'chat-close is not reachable via Tab').toBe(true);
    await page.keyboard.press('Enter');
    await expect(widget).toHaveCount(0);
    await expect(fab).toBeVisible();

    // (6) Space also activates the focused FAB (WCAG 2.1.1 button semantics).
    await fab.focus();
    await page.keyboard.press('Space');
    await expect(widget).toBeVisible();
    await page.getByTestId('chat-close').click();
    await expect(fab).toBeVisible();
  });
});

test.describe('Q-1 · focus-trap модалки AI-импорта (running)', () => {
  test('X при running открывает ConfirmDialog: фокус на безопасной кнопке, Tab циклится внутри', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('a11y-trap'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'GigaChat-2-Pro');
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    // 3 doc files × 2 s per extraction call ≈ 6 s guaranteed running window.
    const zip = makeDocsZip(testInfo, 'a11y-docs.zip', {
      'one.md': '# Один\n\nТребование раз.\n',
      'two.md': '# Два\n\nТребование два.\n',
      'three.md': '# Три\n\nТребование три.\n',
    });
    stub.setExtractionDelay(2000);
    try {
      await page.getByTestId('footer-ai-import').click();
      await expect(page.getByTestId('ai-import')).toBeVisible();
      await page.getByTestId('ai-import-file').setInputFiles(zip);
      await expect(page.getByTestId('ai-import-file-name')).toContainText('a11y-docs.zip');
      await page.getByTestId('ai-import-start').click();
      await expect(page.getByTestId('ai-import-stop')).toBeVisible({ timeout: 30_000 });

      // Bonus scan: the running modal state is also an AI surface. The work
      // log is deliberately INSIDE the scan area — its timestamp contrast was
      // fixed in task 12 (#94a3b8 on #0f172a, ≈6.96:1), so the running state
      // must pass with NO exclusions. Assert the log has rendered content
      // first so the scan cannot silently pass on an empty container.
      const log = page.getByTestId('ai-import-log');
      await expect(log).toBeVisible();
      await expect(log.locator(':scope *').first()).toBeVisible(); // log lines present
      await expectNoSeriousA11y(page, 'AiImportModal (running)');

      // X while running → ConfirmDialog INSTEAD of closing.
      await page.getByTestId('ai-import-close').click();
      const confirm = page.getByTestId('ai-import-confirm');
      await expect(confirm).toBeVisible();

      // UX-5: destructive dialog opens with focus on the SAFE button.
      await expect(page.getByTestId('ai-import-confirm-cancel')).toBeFocused();
      await attachShot(page, testInfo, 'ai-import-confirm-running');

      // Tab cycles inside the ConfirmDialog (forward and backward wrap).
      for (let i = 0; i < 8; i += 1) {
        await page.keyboard.press('Tab');
        expect(await focusInside(page, 'ai-import-confirm'), `Tab #${i} escaped`).toBe(true);
      }
      for (let i = 0; i < 3; i += 1) {
        await page.keyboard.press('Shift+Tab');
        expect(await focusInside(page, 'ai-import-confirm'), `Shift+Tab #${i} escaped`).toBe(true);
      }

      // «Остановить и закрыть» — stop the job and leave the page clean.
      await page.getByTestId('ai-import-confirm-confirm').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);
    } finally {
      stub.setExtractionDelay(0);
    }
  });
});
