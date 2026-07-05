import { expect, test } from '@playwright/test';
import { addRequirement, createProject, rowByName, uniqueName } from './helpers/app.js';

/**
 * QA-9 · cross-browser / responsive smoke (@smoke). These titles carry the
 * `@smoke` tag so the WebKit/Firefox projects (when installed) run exactly this
 * slice, while Chromium runs it as part of the full suite. Kept intentionally
 * thin and framework-agnostic — no engine-specific selectors.
 */

test('@smoke happy path: create a project and add a requirement', async ({ page }) => {
  const project = uniqueName('smoke');
  const ft = uniqueName('F-smoke');
  await createProject(page, project);
  await expect(page.getByTestId('main-path')).toContainText(project);

  await addRequirement(page, { kind: 'function', name: ft, criticality: 'HIGH' });
  await expect(rowByName(page, ft)).toBeVisible();
  await expect(page.getByTestId('section-function')).toContainText('(1)');
});

test('@smoke no horizontal page scroll on a narrow viewport', async ({ page }) => {
  await createProject(page, uniqueName('smoke-narrow'));
  await addRequirement(page, { kind: 'function', name: uniqueName('F-n'), criticality: 'HIGH' });
  await addRequirement(page, { kind: 'nfr', name: uniqueName('N-n'), criticality: 'MEDIUM' });

  // Desktop-oriented app, but the page itself must never scroll sideways on a
  // narrow (tablet) width: wide tables scroll inside their own container.
  for (const size of [
    { width: 768, height: 900 }, // tablet
    { width: 1024, height: 900 }, // small laptop
  ]) {
    await page.setViewportSize(size);
    await expect(page.getByTestId('section-function')).toBeVisible();
    const noHScroll = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth <= el.clientWidth + 1;
    });
    expect(noHScroll, `page scrolls horizontally at width ${size.width}`).toBe(true);
  }
});

test('@smoke start screen renders its three primary actions', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('start-page')).toBeVisible();
  await expect(page.getByTestId('start-new')).toBeVisible();
  await expect(page.getByTestId('start-import')).toBeVisible();
  await expect(page.getByTestId('start-open')).toBeVisible();
});

/* Task 12 Q-3 (PO-T6): AI surfaces must not silently break outside Chromium —
 * the chat FAB drives pointer-event drag/click logic and the AI screen is the
 * key-config entry point. Thin checks only; the deep flows stay Chromium. */

test('@smoke AI chat FAB is visible and a click opens the widget', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('start-page')).toBeVisible();

  // The widget is mounted globally, so the FAB is already on the start screen.
  const fab = page.getByTestId('chat-fab');
  await expect(fab).toBeVisible();

  // A plain click (pointer travel < 5px) expands the widget and hides the FAB.
  await fab.click();
  await expect(page.getByTestId('chat-widget')).toBeVisible();
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await expect(fab).toHaveCount(0);

  // ✕ collapses back to the FAB (conversation kept in the store).
  await page.getByTestId('chat-close').click();
  await expect(page.getByTestId('chat-widget')).toHaveCount(0);
  await expect(fab).toBeVisible();
});

test('@smoke AI screen renders: heading and API-key field', async ({ page }) => {
  await createProject(page, uniqueName('smoke-ai'));

  await page.getByTestId('sidebar-nav-ai').click();
  await expect(page.getByTestId('ai-page')).toBeVisible();
  // T5 (todo_17): benefit-first heading «Подключение AI» (было «Экран „AI“»).
  await expect(page.getByRole('heading', { name: 'Подключение AI' })).toBeVisible();
  await expect(page.getByTestId('ai-key-input')).toBeVisible();
  await expect(page.getByTestId('ai-key-input')).toHaveAttribute('type', 'password');
  await expect(page.getByTestId('ai-baseurl-input')).toBeVisible();
});
