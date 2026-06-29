import { expect, test } from '@playwright/test';
import { createProject, uniqueName } from './helpers/app.js';

/**
 * T-305 · Projects: create & open (FR-1, FR-2, FR-4, FR-5).
 */
test.describe('T-305 projects', () => {
  test('start → new project → main screen shows Main Path', async ({ page }) => {
    const name = uniqueName('proj-create');

    await page.goto('/');
    await expect(page.getByTestId('start-page')).toBeVisible();
    await page.getByTestId('start-new').click();

    await page.getByTestId('newproject-name').fill(name);
    await page.getByTestId('newproject-submit').click();

    // Success notification carries the created Main Path (FR-2.4).
    await expect(page.getByTestId('newproject-success')).toBeVisible();
    const mainPath = await page.getByTestId('newproject-mainpath').innerText();
    expect(mainPath).toContain(name);

    await page.getByTestId('newproject-open').click();
    await expect(page.getByTestId('main-page')).toBeVisible();
    // Main Path is always visible on top of the main screen (FR-5.1).
    await expect(page.getByTestId('main-path')).toContainText(name);
    // Both requirement sections are present (FR-5.2 / FR-6.1).
    await expect(page.getByTestId('section-function')).toBeVisible();
    await expect(page.getByTestId('section-nfr')).toBeVisible();
  });

  test('open an existing project from the list', async ({ page }) => {
    const name = uniqueName('proj-open');
    await createProject(page, name);

    await page.goto('/');
    await page.getByTestId('start-open').click();
    const list = page.getByTestId('open-list');
    await expect(list).toBeVisible();

    await list.getByText(name, { exact: true }).click();
    await expect(page.getByTestId('main-page')).toBeVisible();
    await expect(page.getByTestId('main-path')).toContainText(name);
  });
});
