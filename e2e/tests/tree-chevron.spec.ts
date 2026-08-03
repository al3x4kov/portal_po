import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  addRequirement,
  createProject,
  linkRequirements,
  rowByName,
  setTreeMode,
  uniqueName,
} from './helpers/app.js';

/**
 * task23 · Per-node chevron works in BOTH tree modes (pilot bug #2).
 *
 * Previously the chevron (`toggle-node`) was decorative in the default
 * «Раскрыть все» (expand-all) mode. Now:
 *  - expand-all: clicking the chevron collapses just that branch (local
 *    override), clicking again re-expands it;
 *  - «Раскрыть все» / «Свернуть все» reset the per-node overrides;
 *  - collapse mode: the chevron point-expands a branch as before.
 *
 * Fixture: root (parent of alpha & beta) + a standalone node that must never
 * be affected by branch toggling.
 */
interface Fixture {
  root: string;
  alpha: string;
  beta: string;
  solo: string;
}

async function buildFixture(page: Page): Promise<Fixture> {
  const tag = uniqueName('chev');
  const fx: Fixture = {
    root: `${tag}-root`,
    alpha: `${tag}-alpha`,
    beta: `${tag}-beta`,
    solo: `${tag}-solo`,
  };
  await createProject(page, uniqueName('chev-proj'));
  await addRequirement(page, { kind: 'function', name: fx.root, criticality: 'HIGH' });
  await addRequirement(page, { kind: 'function', name: fx.alpha });
  await addRequirement(page, { kind: 'function', name: fx.beta });
  await addRequirement(page, { kind: 'function', name: fx.solo });
  await linkRequirements(page, fx.alpha, 'CHILD_OF', fx.root);
  await linkRequirements(page, fx.beta, 'CHILD_OF', fx.root);
  return fx;
}

function chevronOf(page: Page, name: string): Locator {
  return rowByName(page, name).getByTestId('toggle-node');
}

test.describe('task23 tree chevron', () => {
  test('expand-all (default): chevron collapses a branch and re-expands it', async ({ page }) => {
    const fx = await buildFixture(page);

    // Fresh load: default mode is expand-all, branch is open.
    await expect(page.getByTestId('toggle-expand-all')).toHaveAttribute('aria-pressed', 'true');
    const chevron = chevronOf(page, fx.root);
    await expect(chevron).toHaveAttribute('aria-expanded', 'true');
    await expect(rowByName(page, fx.alpha)).toBeVisible();
    await expect(rowByName(page, fx.beta)).toBeVisible();

    // Click: the branch collapses — children hidden, aria reflects the state.
    await chevron.click();
    await expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await expect(rowByName(page, fx.alpha)).toBeHidden();
    await expect(rowByName(page, fx.beta)).toBeHidden();
    // The rest of the tree is untouched.
    await expect(rowByName(page, fx.root)).toBeVisible();
    await expect(rowByName(page, fx.solo)).toBeVisible();
    // Still in expand-all mode: a local override, not a mode switch.
    await expect(page.getByTestId('toggle-expand-all')).toHaveAttribute('aria-pressed', 'true');

    // Second click: the branch re-expands.
    await chevron.click();
    await expect(chevron).toHaveAttribute('aria-expanded', 'true');
    await expect(rowByName(page, fx.alpha)).toBeVisible();
    await expect(rowByName(page, fx.beta)).toBeVisible();
  });

  test('«Раскрыть все» resets manual per-branch collapses', async ({ page }) => {
    const fx = await buildFixture(page);

    await chevronOf(page, fx.root).click();
    await expect(rowByName(page, fx.alpha)).toBeHidden();

    // Explicit "expand all" wipes the override — everything is visible again.
    await setTreeMode(page, 'expand-all');
    await expect(chevronOf(page, fx.root)).toHaveAttribute('aria-expanded', 'true');
    await expect(rowByName(page, fx.alpha)).toBeVisible();
    await expect(rowByName(page, fx.beta)).toBeVisible();
  });

  test('collapse mode: chevron point-expands a branch as before', async ({ page }) => {
    const fx = await buildFixture(page);

    await setTreeMode(page, 'collapse');
    const chevron = chevronOf(page, fx.root);
    await expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await expect(rowByName(page, fx.alpha)).toBeHidden();
    await expect(rowByName(page, fx.beta)).toBeHidden();

    // Point expansion via the chevron.
    await chevron.click();
    await expect(chevron).toHaveAttribute('aria-expanded', 'true');
    await expect(rowByName(page, fx.alpha)).toBeVisible();
    await expect(rowByName(page, fx.beta)).toBeVisible();

    // And collapse it back.
    await chevron.click();
    await expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await expect(rowByName(page, fx.alpha)).toBeHidden();
  });

  test('collapse mode after a manual override starts from a clean slate', async ({ page }) => {
    const fx = await buildFixture(page);

    // Manually collapse the branch in expand-all mode…
    await chevronOf(page, fx.root).click();
    await expect(rowByName(page, fx.alpha)).toBeHidden();

    // …then switch to collapse mode: overrides are reset, everything collapsed.
    await setTreeMode(page, 'collapse');
    await expect(rowByName(page, fx.alpha)).toBeHidden();
    await expect(chevronOf(page, fx.root)).toHaveAttribute('aria-expanded', 'false');

    // Point expansion still works from the clean collapsed state.
    await chevronOf(page, fx.root).click();
    await expect(rowByName(page, fx.alpha)).toBeVisible();
    await expect(rowByName(page, fx.beta)).toBeVisible();
  });
});
