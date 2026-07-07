import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import {
  addRequirement,
  corruptRequirementFile,
  createProject,
  deleteRequirement,
  exportArchive,
  importArchive,
  openEdit,
  projectIdFromUrl,
  rowByName,
  slugOf,
  uniqueName,
} from './helpers/app.js';

// adm-zip is a server dependency, resolvable from the repo root; used only to
// forge a *valid* archive that carries one unparseable spec (case 3).
const require = createRequire(import.meta.url);

/**
 * QA-5 · SA-4 — resilience to corrupt `.md` on disk and the "broken files"
 * viewer in the UI (ТЗ §2.5, DoD краевые случаи «битый импорт»).
 *
 * On-disk layout the server reads (ADR-001, verified in FsRequirementRepo):
 *   PROJECTS_ROOT/<projectId>/openspec/specs/{functions|nfr}/<slug>.md
 *
 * Corruption strategy (see `corruptRequirementFile`): overwrite exactly one
 * requirement file with content that lacks the required
 * `### Requirement: <name>` header, so `parse()` throws a deterministic
 * `ParseError`. The server keeps healthy requirements and reports the bad file
 * via `broken[]`; the UI renders it in the `broken-panel`.
 */
test.describe('QA-5 · SA-4 broken .md resilience', () => {
  test('битый .md на диске: панель показывает файл и причину, здоровое требование работает', async ({
    page,
  }) => {
    const project = uniqueName('broken-disk');
    await createProject(page, project);
    const projectId = projectIdFromUrl(page);

    // Two healthy requirements: one stays valid, one gets corrupted on disk.
    const healthy = uniqueName('healthy-fn');
    const victim = uniqueName('victim-fn');
    await addRequirement(page, { kind: 'function', name: healthy });
    await addRequirement(page, { kind: 'function', name: victim });
    const victimSlug = await slugOf(page, victim);

    // Corrupt exactly one file directly under PROJECTS_ROOT, then reload so the
    // server re-reads the folder and the client refetches.
    const relFile = await corruptRequirementFile(projectId, 'function', victimSlug);
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    // The broken panel is visible with a count of exactly 1.
    const panel = page.getByTestId('broken-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Битые файлы требований (1)');

    // The single broken item names the file and carries a non-empty reason.
    const items = page.getByTestId('broken-item');
    await expect(items).toHaveCount(1);
    const item = items.first();
    await expect(item).toContainText(`${victimSlug}.md`);
    const itemText = (await item.innerText()).trim();
    // There must be a reason beyond the bare filename (SA-4: "причина непустая").
    expect(itemText.length).toBeGreaterThan(relFile.length + 2);

    // The app did not crash: the healthy requirement is still in the tree,
    // the corrupted one is hidden, and the healthy card still opens.
    await expect(rowByName(page, healthy)).toBeVisible();
    await expect(rowByName(page, victim)).toHaveCount(0);
    const modal = await openEdit(page, healthy);
    await expect(page.getByTestId('req-name')).toHaveValue(healthy);
    await page.getByTestId('req-cancel').click();
    await expect(modal).toBeHidden();
  });

  test('здоровые CRUD-операции работают при наличии битого файла', async ({ page }) => {
    const project = uniqueName('broken-crud');
    await createProject(page, project);
    const projectId = projectIdFromUrl(page);

    const keep = uniqueName('keep-fn');
    const removable = uniqueName('remove-fn');
    const victim = uniqueName('victim-fn');
    await addRequirement(page, { kind: 'function', name: keep });
    await addRequirement(page, { kind: 'function', name: removable });
    await addRequirement(page, { kind: 'function', name: victim });
    const victimSlug = await slugOf(page, victim);

    await corruptRequirementFile(projectId, 'function', victimSlug);
    await page.reload();
    await expect(page.getByTestId('broken-panel')).toBeVisible();

    // Create a fresh requirement while a broken file is present.
    const created = uniqueName('new-fn');
    await addRequirement(page, { kind: 'function', name: created });
    await expect(rowByName(page, created)).toBeVisible();

    // Delete an unrelated healthy requirement successfully.
    await deleteRequirement(page, removable);

    // Open the surviving healthy card — still fully functional.
    const modal = await openEdit(page, keep);
    await expect(page.getByTestId('req-name')).toHaveValue(keep);
    await page.getByTestId('req-cancel').click();
    await expect(modal).toBeHidden();

    // The broken panel persisted through all healthy operations.
    await expect(page.getByTestId('broken-panel')).toBeVisible();
    await expect(page.getByTestId('broken-item')).toHaveCount(1);
  });

  test('импорт валидного архива с одним непарсируемым .md отклоняется (FR-3.4)', async ({
    page,
  }, testInfo) => {
    // Build a genuinely valid archive first (real manifest + valid spec), then
    // poison exactly one spec entry so the archive itself is well-formed but
    // carries a broken requirement — a different path than the "corrupt bytes"
    // case already covered in edge-cases.spec.ts (writeBrokenArchive).
    const source = uniqueName('exp-src');
    await createProject(page, source);
    await addRequirement(page, { kind: 'function', name: uniqueName('exp-fn') });
    const zipPath = await exportArchive(page, 'zip', testInfo);

    const AdmZip = require('adm-zip') as new (p?: string) => {
      getEntries(): { entryName: string }[];
      updateFile(name: string, data: Buffer): void;
      writeZip(p: string): void;
    };
    const zip = new AdmZip(zipPath);
    const specEntry = zip
      .getEntries()
      .find((e) => /openspec\/specs\/(functions|nfr)\/.+\.md$/.test(e.entryName));
    expect(specEntry, 'archive must contain a spec .md to poison').toBeTruthy();
    zip.updateFile(specEntry!.entryName, Buffer.from('NOT A VALID REQUIREMENT — no header.\n'));
    const poisonedPath = testInfo.outputPath('poisoned.zip');
    zip.writeZip(poisonedPath);
    // Sanity: the poisoned archive is still a readable zip (not corrupt bytes).
    expect((await fs.stat(poisonedPath)).size).toBeGreaterThan(0);

    // Import must be rejected with a clear error; the project is not created.
    const target = uniqueName('imp-broken');
    await importArchive(page, target, poisonedPath, { expectError: true });
    await expect(page.getByTestId('import-error')).toBeVisible();
  });
});
