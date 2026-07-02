import { expect, test } from '@playwright/test';
import {
  addRequirement,
  createProject,
  exportArchive,
  importArchive,
  linkRequirements,
  renameRequirement,
  rowByName,
  uniqueName,
} from './helpers/app.js';

/**
 * T-701 · End-to-end happy path across the whole DoD (DoD#1, DoD#3):
 * new project → ≥3 FT + ≥1 NFR → link into a tree → edit → export → import.
 * New UI default mode is "Раскрыть все", so nested children are visible without
 * a manual expand step.
 */
test('happy path: create, link, edit, export, re-import', async ({ page }, testInfo) => {
  const project = uniqueName('happy');
  const root = uniqueName('Auth');
  const childA = uniqueName('Login');
  const childB = uniqueName('SSO');
  const renamed = uniqueName('SSO-v2');
  const nfr = uniqueName('Perf');

  // New project; Main Path is shown on the main screen (FR-2/FR-5).
  await createProject(page, project);
  await expect(page.getByTestId('main-path')).toContainText(project);

  // ≥3 functional + ≥1 non-functional requirement (FR-6).
  await addRequirement(page, { kind: 'function', name: root, criticality: 'CRITICAL' });
  await addRequirement(page, { kind: 'function', name: childA, criticality: 'HIGH' });
  await addRequirement(page, {
    kind: 'function',
    name: childB,
    implemented: false,
    quarter: 'Q4',
    year: 2027,
  });
  await addRequirement(page, { kind: 'nfr', name: nfr, criticality: 'MEDIUM' });
  await expect(page.getByTestId('section-function')).toContainText('(3)');
  await expect(page.getByTestId('section-nfr')).toContainText('(1)');

  // Build a tree: childA and childB are children of root (FR-7/FR-8).
  await linkRequirements(page, childA, 'CHILD_OF', root);
  await linkRequirements(page, childB, 'CHILD_OF', root);
  await expect(rowByName(page, childA)).toBeVisible();
  await expect(rowByName(page, childB)).toBeVisible();

  // Edit a requirement (with confirmation) — rename childB.
  await renameRequirement(page, childB, renamed);
  await expect(rowByName(page, renamed)).toBeVisible();

  // Export → import under a new name → verify composition is preserved.
  const archive = await exportArchive(page, 'zip', testInfo);
  await importArchive(page, uniqueName('happy-copy'), archive);

  await expect(page.getByTestId('section-function')).toContainText('(3)');
  await expect(page.getByTestId('section-nfr')).toContainText('(1)');
  await expect(rowByName(page, root)).toBeVisible();
  await expect(rowByName(page, nfr)).toBeVisible();
  await expect(rowByName(page, childA)).toBeVisible();
  await expect(rowByName(page, renamed)).toBeVisible();
});
