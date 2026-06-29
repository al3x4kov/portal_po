import { expect, test } from '@playwright/test';
import {
  addRequirement,
  createProject,
  deleteRequirement,
  expandRow,
  linkRequirements,
  renameRequirement,
  rowByName,
  uniqueName,
} from './helpers/app.js';

/**
 * T-406 · Requirements & links (FR-6, FR-7, FR-8, FR-9).
 */
test.describe('T-406 requirements', () => {
  test.beforeEach(async ({ page }) => {
    await createProject(page, uniqueName('reqs'));
  });

  test('add a functional and a non-functional requirement', async ({ page }) => {
    const ft = uniqueName('FT');
    const nfr = uniqueName('NFR');
    await addRequirement(page, { kind: 'function', name: ft, criticality: 'HIGH' });
    await addRequirement(page, { kind: 'nfr', name: nfr, criticality: 'MEDIUM' });

    await expect(page.getByTestId('section-function')).toContainText('(1)');
    await expect(page.getByTestId('section-nfr')).toContainText('(1)');
    await expect(rowByName(page, ft)).toBeVisible();
    await expect(rowByName(page, nfr)).toBeVisible();
  });

  test('conditional quarter/year fields appear only when "not implemented"', async ({ page }) => {
    await page.getByTestId('add-function').click();
    await expect(page.getByTestId('requirement-modal')).toBeVisible();

    // Default is "not implemented" → target fields shown (FR-6.2 / 2.4 §2.2).
    await expect(page.getByTestId('req-target-fields')).toBeVisible();
    await page.getByTestId('req-implemented-yes').click();
    await expect(page.getByTestId('req-target-fields')).toBeHidden();
    await page.getByTestId('req-implemented-no').click();
    await expect(page.getByTestId('req-target-fields')).toBeVisible();

    await page.getByTestId('requirement-modal-close').click();
    await expect(page.getByTestId('requirement-modal')).toBeHidden();
  });

  test('persists a not-implemented requirement with quarter and year', async ({ page }) => {
    const name = uniqueName('FT-planned');
    await addRequirement(page, {
      kind: 'function',
      name,
      implemented: false,
      quarter: 'Q3',
      year: 2027,
    });
    await expect(rowByName(page, name)).toContainText('Q3');
    await expect(rowByName(page, name)).toContainText('2027');
  });

  test('live uniqueness check blocks Apply on a duplicate name (FR-6.6)', async ({ page }) => {
    const dup = uniqueName('FT-dup');
    await addRequirement(page, { kind: 'function', name: dup });

    await page.getByTestId('add-function').click();
    await expect(page.getByTestId('requirement-modal')).toBeVisible();
    await page.getByTestId('req-name-input').fill(dup);

    // Debounced check-name returns "taken" → error shown, Apply disabled.
    await expect(page.getByTestId('req-name-error')).toBeVisible();
    await expect(page.getByTestId('req-apply')).toBeDisabled();

    // A different name clears the error and re-enables Apply.
    await page.getByTestId('req-name-input').fill(uniqueName('FT-ok'));
    await expect(page.getByTestId('req-name-ok')).toBeVisible();
    await expect(page.getByTestId('req-apply')).toBeEnabled();
    await page.getByTestId('requirement-modal-close').click();
  });

  test('edit with confirmation (FR-6.5)', async ({ page }) => {
    const before = uniqueName('FT-edit');
    const after = uniqueName('FT-edited');
    await addRequirement(page, { kind: 'function', name: before });
    await renameRequirement(page, before, after);
    await expect(rowByName(page, before)).toBeHidden();
    await expect(rowByName(page, after)).toBeVisible();
  });

  test('link two requirements; tree reflects the hierarchy (FR-7, FR-8)', async ({ page }) => {
    const parent = uniqueName('F-parent');
    const child = uniqueName('F-child');
    await addRequirement(page, { kind: 'function', name: parent });
    await addRequirement(page, { kind: 'function', name: child });

    // child CHILD_OF parent  ⇒  child nests under parent.
    await linkRequirements(page, child, 'CHILD_OF', parent);

    // Nested child is collapsed by default; parent gains an expand toggle.
    await expect(rowByName(page, child)).toBeHidden();
    await expandRow(page, parent);
    await expect(rowByName(page, child)).toBeVisible();
  });

  test('delete with confirmation (FR-9)', async ({ page }) => {
    const name = uniqueName('FT-del');
    await addRequirement(page, { kind: 'function', name });
    await deleteRequirement(page, name);
    await expect(page.getByTestId('section-function')).toContainText('(0)');
  });
});
