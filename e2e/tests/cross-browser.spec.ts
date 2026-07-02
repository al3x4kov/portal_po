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
