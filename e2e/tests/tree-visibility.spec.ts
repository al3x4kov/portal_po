import { expect, test, type Page } from '@playwright/test';
import {
  addRequirement,
  createProject,
  expandNode,
  linkRequirements,
  rowByName,
  setTreeMode,
  uniqueName,
} from './helpers/app.js';

/**
 * T-1202 · Single visibility layer (A6#4) — situation matrix S24–S30.
 *
 * Fixture per test: one root FUNCTION with two children of differing criticality,
 * one standalone FUNCTION and one NFR. All names share a unique `tag` so a search
 * for the tag matches the whole fixture, while sub-searches target one node.
 */
interface Fixture {
  tag: string;
  root: string; // CRITICAL, parent of alpha & beta
  alpha: string; // HIGH, child of root
  beta: string; // LOW, child of root
  solo: string; // MEDIUM, standalone function
  nfr: string; // MEDIUM, non-functional
}

async function buildFixture(page: Page): Promise<Fixture> {
  const tag = uniqueName('vis');
  const fx: Fixture = {
    tag,
    root: `${tag}-root`,
    alpha: `${tag}-alpha`,
    beta: `${tag}-beta`,
    solo: `${tag}-solo`,
    nfr: `${tag}-nfr`,
  };
  await createProject(page, uniqueName('vis-proj'));
  await addRequirement(page, { kind: 'function', name: fx.root, criticality: 'CRITICAL' });
  await addRequirement(page, { kind: 'function', name: fx.alpha, criticality: 'HIGH' });
  await addRequirement(page, { kind: 'function', name: fx.beta, criticality: 'LOW' });
  await addRequirement(page, { kind: 'function', name: fx.solo, criticality: 'MEDIUM' });
  await addRequirement(page, { kind: 'nfr', name: fx.nfr, criticality: 'MEDIUM' });
  await linkRequirements(page, fx.alpha, 'CHILD_OF', fx.root);
  await linkRequirements(page, fx.beta, 'CHILD_OF', fx.root);
  return fx;
}

async function applyCriticality(
  page: Page,
  opt: 'low' | 'medium' | 'high' | 'critical',
): Promise<void> {
  await page.getByTestId('criticality-filter').click();
  await expect(page.getByTestId('criticality-dropdown')).toBeVisible();
  await page.getByTestId(`crit-opt-${opt}`).click();
  await page.getByTestId('crit-apply').click();
  await expect(page.getByTestId('criticality-dropdown')).toBeHidden();
}

test.describe('T-1202 tree visibility (S24–S30)', () => {
  test('S24 "Раскрыть все" (default) shows every node', async ({ page }) => {
    const fx = await buildFixture(page);
    // Default mode is expand-all: children are visible without any manual expand.
    for (const name of [fx.root, fx.alpha, fx.beta, fx.solo, fx.nfr]) {
      await expect(rowByName(page, name)).toBeVisible();
    }
    await expect(page.getByTestId('toggle-expand-all')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('shown-count')).toContainText('Показано 5 из 5');
  });

  test('S25 "Скрыть зависимости" collapses linked children; chip re-expands', async ({ page }) => {
    const fx = await buildFixture(page);
    await setTreeMode(page, 'collapse');

    // Roots & standalone nodes stay visible; the linked children collapse away.
    await expect(rowByName(page, fx.root)).toBeVisible();
    await expect(rowByName(page, fx.solo)).toBeVisible();
    await expect(rowByName(page, fx.nfr)).toBeVisible();
    await expect(rowByName(page, fx.alpha)).toBeHidden();
    await expect(rowByName(page, fx.beta)).toBeHidden();

    // The collapsed root carries a "N зависимостей" chip that re-expands it.
    await expect(rowByName(page, fx.root).getByTestId('expand-node')).toBeVisible();
    await expandNode(page, fx.root);
    await expect(rowByName(page, fx.alpha)).toBeVisible();
    await expect(rowByName(page, fx.beta)).toBeVisible();
  });

  test('S26 search matching a child reveals the child and its ancestors', async ({ page }) => {
    const fx = await buildFixture(page);
    await page.getByTestId('search-input').fill(fx.alpha);

    // The matched child is a "match"; its parent is kept as "context" (ancestor).
    await expect(rowByName(page, fx.alpha)).toBeVisible();
    await expect(rowByName(page, fx.alpha)).toHaveAttribute('data-row-kind', 'match');
    await expect(rowByName(page, fx.root)).toBeVisible();
    await expect(rowByName(page, fx.root)).toHaveAttribute('data-row-kind', 'context');
    await expect(
      rowByName(page, fx.root).locator('[data-testid^="ancestor-label-"]'),
    ).toBeVisible();

    // Non-matching, non-ancestor nodes are hidden.
    await expect(rowByName(page, fx.beta)).toBeHidden();
    await expect(rowByName(page, fx.solo)).toBeHidden();
    await expect(rowByName(page, fx.nfr)).toBeHidden();
    await expect(page.getByTestId('search-count')).toBeVisible();
  });

  test('S27 criticality filter is a draft applied on "Применить"; shows matches + ancestors', async ({
    page,
  }) => {
    const fx = await buildFixture(page);

    // Draft selection alone must NOT change the table until "Применить".
    await page.getByTestId('criticality-filter').click();
    await page.getByTestId('crit-opt-high').click();
    await expect(rowByName(page, fx.beta)).toBeVisible(); // still unfiltered
    await expect(rowByName(page, fx.solo)).toBeVisible();
    await page.getByTestId('crit-apply').click();

    // HIGH matches only alpha; its CRITICAL parent stays as context ancestor.
    await expect(page.getByTestId('criticality-count')).toHaveText('1');
    await expect(rowByName(page, fx.alpha)).toHaveAttribute('data-row-kind', 'match');
    await expect(rowByName(page, fx.root)).toHaveAttribute('data-row-kind', 'context');
    await expect(rowByName(page, fx.beta)).toBeHidden();
    await expect(rowByName(page, fx.solo)).toBeHidden();
    await expect(rowByName(page, fx.nfr)).toBeHidden();
  });

  test('S28 search ∩ criticality ∩ collapse yields a consistent set (no orphans)', async ({
    page,
  }) => {
    const fx = await buildFixture(page);
    // Even in collapse mode, an active filter reveals matches with their ancestors.
    await setTreeMode(page, 'collapse');
    await page.getByTestId('search-input').fill(fx.tag); // matches all names
    await applyCriticality(page, 'high'); // HIGH ∩ tag ⇒ alpha only

    // alpha (match) + root (context ancestor) — never an orphan.
    await expect(rowByName(page, fx.alpha)).toHaveAttribute('data-row-kind', 'match');
    await expect(rowByName(page, fx.root)).toHaveAttribute('data-row-kind', 'context');
    // Everything else is excluded by the intersection.
    await expect(rowByName(page, fx.beta)).toBeHidden();
    await expect(rowByName(page, fx.solo)).toBeHidden();
    await expect(rowByName(page, fx.nfr)).toBeHidden();
  });

  test('S29 empty states: no-match search + a filtered-out section', async ({ page }) => {
    const fx = await buildFixture(page);

    // (a) A search that matches nothing shows the page-level empty state.
    await page.getByTestId('search-input').fill(`${fx.tag}-zzz-nomatch`);
    await expect(page.getByTestId('search-empty')).toBeVisible();

    // Clear it (button inside the empty state) to restore the full tree.
    await page.getByTestId('search-empty').getByTestId('search-clear').click();
    await expect(rowByName(page, fx.root)).toBeVisible();

    // (b) A criticality filter that no NFR matches leaves the NFR section empty.
    await applyCriticality(page, 'critical'); // only the CRITICAL root matches
    await expect(rowByName(page, fx.root)).toBeVisible();
    await expect(page.getByTestId('filtered-empty-nfr')).toBeVisible();
  });

  test('S30 clicking "Описание" opens a drawer with the full, untruncated text', async ({
    page,
  }) => {
    await createProject(page, uniqueName('desc-proj'));
    const name = uniqueName('F-desc');
    const longText = `НАЧАЛО ${'подробное описание требования '.repeat(20)} КОНЕЦ`;
    await addRequirement(page, {
      kind: 'function',
      name,
      criticality: 'MEDIUM',
      description: longText,
    });

    // Click the description cell → the side drawer opens with the whole text.
    await rowByName(page, name).getByTestId('desc-expand').click();
    const panel = page.getByTestId('desc-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('desc-panel-title')).toHaveText(name);
    await expect(page.getByTestId('desc-panel-body')).toContainText('НАЧАЛО');
    await expect(page.getByTestId('desc-panel-body')).toContainText('КОНЕЦ');

    // Esc closes the drawer (keyboard accessibility).
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });
});
