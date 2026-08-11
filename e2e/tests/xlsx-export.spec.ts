import { promises as fs } from 'node:fs';
import { expect, test } from '@playwright/test';
import { addRequirement, createProject, uniqueName } from './helpers/app.js';

/**
 * T-1202 · S18 — Excel export on the full-screen export route (sidebar-open-export → xlsx).
 * The downloaded file must be a valid, non-empty .xlsx (ZIP container, magic PK).
 */
test('S18 Excel export downloads a valid non-empty .xlsx (PK signature)', async ({
  page,
}, testInfo) => {
  await createProject(page, uniqueName('xlsx-proj'));
  await addRequirement(page, { kind: 'function', name: uniqueName('F-x'), criticality: 'HIGH' });
  await addRequirement(page, { kind: 'nfr', name: uniqueName('N-x'), criticality: 'MEDIUM' });

  // Открыть полноэкранный экспорт, выбрать формат и запустить выгрузку.
  await page.getByTestId('sidebar-open-export').click();
  await page.getByTestId('export-fmt-xlsx').click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-run').click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  const savedPath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(savedPath);

  const buf = await fs.readFile(savedPath);
  // Non-empty and starts with the ZIP local-file-header magic (xlsx is a ZIP).
  expect(buf.byteLength).toBeGreaterThan(0);
  expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
});
