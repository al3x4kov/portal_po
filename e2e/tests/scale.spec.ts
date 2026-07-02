import { expect, test, type Page } from '@playwright/test';
import {
  apiCreateRequirement,
  createProject,
  projectIdFromUrl,
  uniqueName,
} from './helpers/app.js';

/**
 * QA-2 (e2e part) · usability at scale. Seeds a large project (~300 functional
 * requirements) through the REST API, then checks the UI stays responsive and
 * correct on that volume: search narrows the tree, the criticality filter
 * intersects, and the page never scrolls horizontally. Unit/integration perf
 * budgets are handled by a separate agent; this is the human-usability slice.
 */

const TOTAL = 300;
const NEEDLES = 12; // HIGH, name carries a distinctive token
const CRITICALS = 15; // CRITICAL, plain names

async function applyCriticality(page: Page, opt: 'critical' | 'high'): Promise<void> {
  await page.getByTestId('criticality-filter').click();
  await expect(page.getByTestId('criticality-dropdown')).toBeVisible();
  await page.getByTestId(`crit-opt-${opt}`).click();
  await page.getByTestId('crit-apply').click();
  await expect(page.getByTestId('criticality-dropdown')).toBeHidden();
}

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth <= el.clientWidth + 1;
  });
}

test('QA-2 large project (~300) stays usable: search, filter, no h-scroll', async ({ page }) => {
  test.setTimeout(180_000); // generous: 300 API writes + UI assertions

  const tag = uniqueName('scale');
  const needleToken = `${tag}zneedle`;
  await createProject(page, uniqueName('scale-proj'));
  const projectId = projectIdFromUrl(page);

  // Seed via API (chunked concurrency; the server serializes writes under its
  // per-project lock, so this is safe and much faster than the UI path).
  const specs: { name: string; criticality: 'HIGH' | 'CRITICAL' | 'MEDIUM' }[] = [];
  for (let i = 0; i < TOTAL; i += 1) {
    if (i < NEEDLES) specs.push({ name: `${needleToken}-${i}`, criticality: 'HIGH' });
    else if (i < NEEDLES + CRITICALS)
      specs.push({ name: `${tag}-crit-${i}`, criticality: 'CRITICAL' });
    else specs.push({ name: `${tag}-plain-${i}`, criticality: 'MEDIUM' });
  }
  const CHUNK = 20;
  for (let i = 0; i < specs.length; i += CHUNK) {
    await Promise.all(
      specs.slice(i, i + CHUNK).map((s) =>
        apiCreateRequirement(page, projectId, {
          kind: 'function',
          name: s.name,
          criticality: s.criticality,
        }),
      ),
    );
  }

  // Load the freshly-seeded project and confirm the full volume rendered.
  await page.goto(`/p/${encodeURIComponent(projectId)}`);
  await expect(page.getByTestId('main-page')).toBeVisible();
  await expect(page.getByTestId('section-function')).toContainText(`(${TOTAL})`);
  await expect(page.getByTestId('shown-count')).toContainText(`Показано ${TOTAL} из ${TOTAL}`);
  expect(await noHorizontalScroll(page), 'h-scroll on the full 300-node tree').toBe(true);

  // Search narrows the tree to just the needle subset (responsive filtering).
  await page.getByTestId('search-input').fill(needleToken);
  await expect(page.getByTestId('search-count')).toBeVisible();
  await expect(page.locator('tr[data-req-name]')).toHaveCount(NEEDLES);
  await expect(page.getByTestId('shown-count')).toContainText(`Показано ${NEEDLES} из ${TOTAL}`);
  expect(await noHorizontalScroll(page), 'h-scroll after search').toBe(true);

  // Clearing search restores the full tree.
  await page.getByTestId('search-input').fill('');
  await expect(page.getByTestId('shown-count')).toContainText(`Показано ${TOTAL} из ${TOTAL}`);

  // Criticality filter intersects on scale: only the CRITICAL subset remains.
  await applyCriticality(page, 'critical');
  await expect(page.getByTestId('criticality-count')).toHaveText('1');
  await expect(page.locator('tr[data-req-name]')).toHaveCount(CRITICALS);
  await expect(page.getByTestId('shown-count')).toContainText(`Показано ${CRITICALS} из ${TOTAL}`);
  expect(await noHorizontalScroll(page), 'h-scroll after filter').toBe(true);
});
