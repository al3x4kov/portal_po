import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  addRequirement,
  createProject,
  expectDeleteBlocked,
  linkRequirements,
  uniqueName,
  writeBrokenArchive,
} from './helpers/app.js';

const PROJECTS_ROOT = process.env.E2E_PROJECTS_ROOT ?? path.join(os.tmpdir(), 'po-e2e-projects');

/**
 * T-702 · Edge cases & error handling (ТЗ §5, DoD#4, DoD#5).
 */
test.describe('T-702 edge cases', () => {
  test('duplicate project name is rejected (FR-2.5)', async ({ page }) => {
    const name = uniqueName('dup-proj');
    await createProject(page, name);

    await page.goto('/');
    await page.getByTestId('start-new').click();
    await page.getByTestId('newproject-name').fill(name);
    await page.getByTestId('newproject-submit').click();
    await expect(page.getByTestId('newproject-error')).toBeVisible();
  });

  test('duplicate requirement name is blocked (2.4.1)', async ({ page }) => {
    await createProject(page, uniqueName('dup-req'));
    const dup = uniqueName('FT');
    await addRequirement(page, { kind: 'function', name: dup });

    await page.getByTestId('add-function').click();
    await page.getByTestId('req-name-input').fill(dup);
    await expect(page.getByTestId('req-name-error')).toBeVisible();
    await expect(page.getByTestId('req-apply')).toBeDisabled();
    await page.getByTestId('requirement-modal-close').click();
  });

  test('cycle in hierarchy is rejected with a UI error (2.4.3)', async ({ page }) => {
    await createProject(page, uniqueName('cycle'));
    const a = uniqueName('F-a');
    const b = uniqueName('F-b');
    await addRequirement(page, { kind: 'function', name: a });
    await addRequirement(page, { kind: 'function', name: b });

    await linkRequirements(page, a, 'CHILD_OF', b); // a → child of b
    // b → child of a would close the loop a→b→a.
    await linkRequirements(page, b, 'CHILD_OF', a, { expectError: true });
  });

  test('a second parent is rejected with a UI error (2.4.4)', async ({ page }) => {
    await createProject(page, uniqueName('two-parents'));
    const child = uniqueName('F-child');
    const p1 = uniqueName('F-p1');
    const p2 = uniqueName('F-p2');
    await addRequirement(page, { kind: 'function', name: child });
    await addRequirement(page, { kind: 'function', name: p1 });
    await addRequirement(page, { kind: 'function', name: p2 });

    await linkRequirements(page, child, 'CHILD_OF', p1);
    // Giving the child a second parent via p2 PARENT_OF child must fail.
    await linkRequirements(page, p2, 'PARENT_OF', child, { expectError: true });
  });

  test('importing a corrupt archive shows an error (FR-3.4, §5)', async ({ page }, testInfo) => {
    const bad = await writeBrokenArchive(testInfo, 'broken.tar.gz');
    await page.goto('/');
    await page.getByTestId('start-import').click();
    await page.getByTestId('import-name').fill(uniqueName('imp-bad'));
    await page.getByTestId('import-file').setInputFiles(bad);
    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('import-error')).toBeVisible();
    await expect(page.getByTestId('import-page')).toBeVisible();
  });

  test('unknown archive format is rejected client-side (§5)', async ({ page }, testInfo) => {
    const txt = testInfo.outputPath('notanarchive.txt');
    await fs.writeFile(txt, 'plain text');
    await page.goto('/');
    await page.getByTestId('start-import').click();
    await page.getByTestId('import-file').setInputFiles(txt);
    await expect(page.getByTestId('import-error')).toBeVisible();
  });

  test('deleting a node with children is blocked (FR-9.3)', async ({ page }) => {
    await createProject(page, uniqueName('has-children'));
    const parent = uniqueName('F-parent');
    const child = uniqueName('F-child');
    await addRequirement(page, { kind: 'function', name: parent });
    await addRequirement(page, { kind: 'function', name: child });
    await linkRequirements(page, child, 'CHILD_OF', parent);

    await expectDeleteBlocked(page, parent);
  });

  test('Projects/ is recreated automatically when missing (DoD#4, FR-2.3)', async ({ page }) => {
    // Remove the portal directory out from under the running server.
    await fs.rm(PROJECTS_ROOT, { recursive: true, force: true });
    expect(await fs.stat(PROJECTS_ROOT).catch(() => null)).toBeNull();

    // Creating a project must transparently recreate Projects/.
    const name = uniqueName('recreated');
    await createProject(page, name);
    await expect(page.getByTestId('main-path')).toContainText(name);

    const stat = await fs.stat(PROJECTS_ROOT);
    expect(stat.isDirectory()).toBeTruthy();
  });
});
