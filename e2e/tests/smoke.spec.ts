import { test, expect } from '@playwright/test';

/**
 * Demo E2E (E1 skeleton). Real FR-1..FR-10 scenarios land in E7.
 * Skipped until apps/web serves a page (no webServer yet).
 */
test.skip('home page opens', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/.+/);
});
