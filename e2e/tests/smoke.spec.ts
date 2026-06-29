import { test, expect } from '@playwright/test';

/** Smoke check: the built SPA is served and the start screen renders (FR-1). */
test('start page opens with the three actions', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/.+/);
  await expect(page.getByTestId('start-page')).toBeVisible();
  await expect(page.getByTestId('start-new')).toBeVisible();
  await expect(page.getByTestId('start-import')).toBeVisible();
  await expect(page.getByTestId('start-open')).toBeVisible();
});

test('healthz endpoint is up', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toEqual({ status: 'ok' });
});
