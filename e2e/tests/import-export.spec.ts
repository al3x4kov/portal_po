import { expect, test } from '@playwright/test';
import {
  addRequirement,
  createProject,
  exportArchive,
  expandNode,
  importArchive,
  linkRequirements,
  rowByName,
  setTreeMode,
  uniqueName,
  writeBrokenArchive,
} from './helpers/app.js';

/**
 * T-504 · Round-trip export → import (FR-3, FR-10, DoD#3).
 * S17 (zip round-trip) and S20 (tar.gz round-trip) from the situation matrix.
 */
test.describe('T-504 import/export', () => {
  for (const format of ['zip', 'targz'] as const) {
    const sid = format === 'zip' ? 'S17' : 'S20';
    test(`${sid} round-trip preserves requirements and links (.${format})`, async ({
      page,
    }, testInfo) => {
      const parent = uniqueName('RT-parent');
      const child = uniqueName('RT-child');
      const nfr = uniqueName('RT-nfr');

      await createProject(page, uniqueName(`rt-src-${format}`));
      await addRequirement(page, { kind: 'function', name: parent, criticality: 'HIGH' });
      await addRequirement(page, { kind: 'function', name: child });
      await addRequirement(page, { kind: 'nfr', name: nfr });
      await linkRequirements(page, child, 'CHILD_OF', parent);

      const archive = await exportArchive(page, format, testInfo);

      // Re-import under a brand new name (FR-3.2).
      await importArchive(page, uniqueName(`rt-dst-${format}`), archive);

      // Composition identical: both functions + the NFR survive.
      await expect(page.getByTestId('section-function')).toContainText('(2)');
      await expect(page.getByTestId('section-nfr')).toContainText('(1)');
      await expect(rowByName(page, parent)).toBeVisible();
      await expect(rowByName(page, nfr)).toBeVisible();

      // Links identical: the parent/child hierarchy is intact. In "Раскрыть все"
      // the child is visible; collapsing hides it, and the chip re-expands it.
      await expect(rowByName(page, child)).toBeVisible();
      await setTreeMode(page, 'collapse');
      await expect(rowByName(page, child)).toBeHidden();
      await expandNode(page, parent);
      await expect(rowByName(page, child)).toBeVisible();
    });
  }

  test('importing a corrupt archive shows an error in the UI (FR-3.4)', async ({
    page,
  }, testInfo) => {
    const bad = await writeBrokenArchive(testInfo, 'corrupt.zip');
    await importArchive(page, uniqueName('rt-bad'), bad, { expectError: true });
    // Still on the import screen; no project opened.
    await expect(page.getByTestId('import-page')).toBeVisible();
  });
});
