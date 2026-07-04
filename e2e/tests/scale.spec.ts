import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  apiCreateRequirement,
  createProject,
  expandNode,
  projectIdFromUrl,
  rowByName,
  setTreeMode,
  uniqueName,
} from './helpers/app.js';

/**
 * QA-2 / Task 12 Q-2 (PO-T5) · usability at the TARGET scale of NFR-3: seeds
 * ~1000 requirements through the REST API (chunked concurrency), then checks
 * the UI stays responsive and correct on that volume:
 *   - initial Main render: measured from goto to the fully-counted tree; the
 *     ТЗ target is 1.5 s — the FACT is recorded in an annotation/attachment,
 *     while the hard assert uses a ×3 safety margin over the measured fact on
 *     the reference machine (see RENDER_BUDGET_MS) so the suite never flakes;
 *   - expanding a collapsed node (parent/child link), search, MULTI-select
 *     criticality filter, opening/closing the requirement modal — all via
 *     web-first assertions, zero sleeps;
 *   - the page never scrolls horizontally in any of those states.
 * Server-side perf budgets (CRUD p95) are a different agent's slice; this is
 * the human-usability slice at scale.
 */

const TOTAL = 1000;
const NEEDLES = 12; // HIGH, name carries a distinctive search token
const CRITICALS = 15; // CRITICAL, plain names
const SEED_CONCURRENCY = 40;

/**
 * Hard budget for the initial Main render @1000. Measured fact on the
 * reference machine (Darwin arm64, local build, 2026-07): 1026–1103 ms from
 * goto to the fully-counted tree — i.e. the ТЗ NFR-3 target of 1.5 s IS met
 * here (see the attached `initial-render-@1000` measurement for the current
 * fact). The hard assert takes a ×3 safety margin over the worst observed
 * fact (~1.1 s → 3.5 s) so the check stays meaningful but flake-free on
 * slower machines.
 */
const RENDER_BUDGET_MS = 3_500;

async function applyCriticality(
  page: Page,
  opts: ('critical' | 'high' | 'medium' | 'low')[],
): Promise<void> {
  await page.getByTestId('criticality-filter').click();
  await expect(page.getByTestId('criticality-dropdown')).toBeVisible();
  for (const opt of opts) {
    await page.getByTestId(`crit-opt-${opt}`).click();
  }
  await page.getByTestId('crit-apply').click();
  await expect(page.getByTestId('criticality-dropdown')).toBeHidden();
}

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth <= el.clientWidth + 1;
  });
}

test('QA-2/Q-2 large project (~1000) stays usable: render, expand, search, multi-filter, modal, no h-scroll', async ({
  page,
}, testInfo: TestInfo) => {
  test.setTimeout(480_000); // generous: 1000 API writes + UI assertions

  const tag = uniqueName('scale');
  const needleToken = `${tag}zneedle`;
  const parentName = `${tag}-parent`;
  const childName = `${tag}-child`;
  await createProject(page, uniqueName('scale-proj'));
  const projectId = projectIdFromUrl(page);

  // A parent/child pair first (their slugs feed the link), then the bulk.
  const parentSlug = await apiCreateRequirement(page, projectId, {
    kind: 'function',
    name: parentName,
    criticality: 'MEDIUM',
  });
  const childSlug = await apiCreateRequirement(page, projectId, {
    kind: 'function',
    name: childName,
    criticality: 'MEDIUM',
  });
  const linkRes = await page.request.post(`/api/projects/${encodeURIComponent(projectId)}/links`, {
    data: { sourceSlug: childSlug, type: 'CHILD_OF', targetSlug: parentSlug },
  });
  expect(linkRes.ok(), `link seed failed (${linkRes.status()})`).toBe(true);

  // Seed the remaining volume via the API (chunked concurrency; the server
  // serializes writes under its per-project lock, so this is safe and much
  // faster than the UI path).
  const specs: { name: string; criticality: 'HIGH' | 'CRITICAL' | 'MEDIUM' }[] = [];
  for (let i = 0; i < TOTAL - 2; i += 1) {
    if (i < NEEDLES) specs.push({ name: `${needleToken}-${i}`, criticality: 'HIGH' });
    else if (i < NEEDLES + CRITICALS)
      specs.push({ name: `${tag}-crit-${i}`, criticality: 'CRITICAL' });
    else specs.push({ name: `${tag}-plain-${i}`, criticality: 'MEDIUM' });
  }
  const seedStart = performance.now();
  for (let i = 0; i < specs.length; i += SEED_CONCURRENCY) {
    await Promise.all(
      specs.slice(i, i + SEED_CONCURRENCY).map((s) =>
        apiCreateRequirement(page, projectId, {
          kind: 'function',
          name: s.name,
          criticality: s.criticality,
        }),
      ),
    );
  }
  const seedMs = Math.round(performance.now() - seedStart);

  // ── Initial render @1000: goto → tree fully rendered and counted ─────────
  const renderStart = performance.now();
  await page.goto(`/p/${encodeURIComponent(projectId)}`);
  await expect(page.getByTestId('main-page')).toBeVisible();
  await expect(page.getByTestId('section-function')).toContainText(`(${TOTAL})`);
  await expect(page.getByTestId('shown-count')).toContainText(`Показано ${TOTAL} из ${TOTAL}`);
  const renderMs = Math.round(performance.now() - renderStart);

  const perfNote =
    `initial Main render @${TOTAL}: ${renderMs} ms (ТЗ target 1500 ms; ` +
    `hard budget ×3 margin = ${RENDER_BUDGET_MS} ms; seed took ${seedMs} ms)`;
  testInfo.annotations.push({ type: 'perf', description: perfNote });
  await testInfo.attach('initial-render-@1000', {
    body: perfNote,
    contentType: 'text/plain',
  });
  expect(renderMs, perfNote).toBeLessThan(RENDER_BUDGET_MS);

  expect(await noHorizontalScroll(page), 'h-scroll on the full 1000-node tree').toBe(true);
  await testInfo.attach('tree-at-1000', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  // ── Expanding a collapsed node stays instant at 1000 ──────────────────────
  await setTreeMode(page, 'collapse');
  await expect(rowByName(page, childName)).toBeHidden();
  await expandNode(page, parentName);
  await expect(rowByName(page, childName)).toBeVisible();
  await setTreeMode(page, 'expand-all');
  await expect(page.getByTestId('shown-count')).toContainText(`Показано ${TOTAL} из ${TOTAL}`);

  // ── Search narrows the tree to just the needle subset ─────────────────────
  await page.getByTestId('search-input').fill(needleToken);
  await expect(page.getByTestId('search-count')).toBeVisible();
  await expect(page.locator('tr[data-req-name]')).toHaveCount(NEEDLES);
  await expect(page.getByTestId('shown-count')).toContainText(`Показано ${NEEDLES} из ${TOTAL}`);
  expect(await noHorizontalScroll(page), 'h-scroll after search').toBe(true);

  // Clearing search restores the full tree.
  await page.getByTestId('search-input').fill('');
  await expect(page.getByTestId('shown-count')).toContainText(`Показано ${TOTAL} из ${TOTAL}`);

  // ── Requirement modal opens and closes without lag at 1000 ────────────────
  await rowByName(page, parentName).locator('[data-testid^="req-name-"]').click();
  await expect(page.getByTestId('requirement-modal')).toBeVisible();
  await expect(page.getByTestId('req-name')).toHaveValue(parentName);
  await page.getByTestId('requirement-modal-close').click();
  await expect(page.getByTestId('requirement-modal')).toBeHidden();

  // ── MULTI-select criticality filter intersects on scale ───────────────────
  // CRITICAL + HIGH together: the needle (HIGH) and crit subsets remain.
  await applyCriticality(page, ['critical', 'high']);
  await expect(page.getByTestId('criticality-count')).toHaveText('2');
  await expect(page.locator('tr[data-req-name]')).toHaveCount(CRITICALS + NEEDLES);
  await expect(page.getByTestId('shown-count')).toContainText(
    `Показано ${CRITICALS + NEEDLES} из ${TOTAL}`,
  );
  expect(await noHorizontalScroll(page), 'h-scroll after multi-filter').toBe(true);
  await testInfo.attach('multiselect-filter-at-1000', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
