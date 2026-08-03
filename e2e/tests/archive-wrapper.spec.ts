import { promises as fs } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { expect, test, type TestInfo } from '@playwright/test';
import {
  addRequirement,
  createProject,
  exportArchive,
  importArchive,
  linkRequirements,
  rowByName,
  uniqueName,
} from './helpers/app.js';

/**
 * task22 · Import of zip/tar.gz with a root wrapper directory (pilot bug #1).
 *
 * A zip made from a folder (macOS Finder, GitHub releases) puts everything
 * under a single root dir: `wrapper/openspec/...`. The server must descend
 * through such wrappers (incl. double wrappers and `__MACOSX` junk) and still
 * find `openspec/`. An archive without `openspec/` anywhere must fail with a
 * clear message and must NOT create the project.
 *
 * E2E strategy: export a real project through the UI, re-pack its contents
 * under wrapper folder(s), then import through the Import screen.
 */

/** Re-pack a zip so every entry is prefixed with `prefix` (posix path). */
function repackZipUnderPrefix(
  srcPath: string,
  prefix: string,
  destPath: string,
  opts: { addMacosx?: boolean } = {},
): void {
  const src = new AdmZip(srcPath);
  const out = new AdmZip();
  for (const entry of src.getEntries()) {
    if (entry.isDirectory) continue;
    out.addFile(path.posix.join(prefix, entry.entryName), entry.getData());
  }
  if (opts.addMacosx) {
    // Finder-style resource-fork junk next to the wrapper + a stray .DS_Store.
    out.addFile(`__MACOSX/${prefix.split('/')[0]}/._project.md`, Buffer.from([0x00, 0x05, 0x16]));
    out.addFile('.DS_Store', Buffer.from('junk'));
  }
  out.writeZip(destPath);
}

/** Re-pack a tar.gz so its contents live under a single wrapper directory. */
async function repackTargzUnderWrapper(
  srcPath: string,
  wrapper: string,
  testInfo: TestInfo,
): Promise<string> {
  const work = testInfo.outputPath(`targz-repack-${wrapper}`);
  const contentRoot = path.join(work, wrapper);
  await fs.mkdir(contentRoot, { recursive: true });
  await tar.extract({ file: srcPath, cwd: contentRoot });
  const destPath = testInfo.outputPath(`wrapped-${wrapper}.tar.gz`);
  await tar.create({ file: destPath, gzip: true, cwd: work }, [wrapper]);
  return destPath;
}

/** Create a small project with a parent→child link and an NFR; export it. */
async function buildAndExport(
  page: Parameters<typeof createProject>[0],
  format: 'zip' | 'targz',
  testInfo: TestInfo,
  names: { parent: string; child: string; nfr: string },
): Promise<string> {
  await createProject(page, uniqueName(`wrap-src-${format}`));
  await addRequirement(page, { kind: 'function', name: names.parent, criticality: 'HIGH' });
  await addRequirement(page, { kind: 'function', name: names.child });
  await addRequirement(page, { kind: 'nfr', name: names.nfr });
  await linkRequirements(page, names.child, 'CHILD_OF', names.parent);
  return exportArchive(page, format, testInfo);
}

test.describe('task22 archive root wrapper', () => {
  test('zip with a single wrapper dir imports and opens with all requirements', async ({
    page,
  }, testInfo) => {
    const names = {
      parent: uniqueName('wrap-parent'),
      child: uniqueName('wrap-child'),
      nfr: uniqueName('wrap-nfr'),
    };
    const exported = await buildAndExport(page, 'zip', testInfo, names);

    const wrapped = testInfo.outputPath('single-wrapper.zip');
    repackZipUnderPrefix(exported, 'My Project 1.19.0', wrapped);

    await importArchive(page, uniqueName('wrap-dst-zip'), wrapped);

    // Full composition survives the wrapper: 2 functions + 1 NFR, link intact.
    await expect(page.getByTestId('section-function')).toContainText('(2)');
    await expect(page.getByTestId('section-nfr')).toContainText('(1)');
    await expect(rowByName(page, names.parent)).toBeVisible();
    await expect(rowByName(page, names.child)).toBeVisible();
    await expect(rowByName(page, names.nfr)).toBeVisible();
  });

  test('zip with a double wrapper and __MACOSX junk imports', async ({ page }, testInfo) => {
    const names = {
      parent: uniqueName('wrap2-parent'),
      child: uniqueName('wrap2-child'),
      nfr: uniqueName('wrap2-nfr'),
    };
    const exported = await buildAndExport(page, 'zip', testInfo, names);

    const wrapped = testInfo.outputPath('double-wrapper.zip');
    repackZipUnderPrefix(exported, 'outer/inner', wrapped, { addMacosx: true });

    await importArchive(page, uniqueName('wrap-dst-zip2'), wrapped);

    await expect(page.getByTestId('section-function')).toContainText('(2)');
    await expect(rowByName(page, names.parent)).toBeVisible();
    await expect(rowByName(page, names.child)).toBeVisible();
    await expect(rowByName(page, names.nfr)).toBeVisible();
  });

  test('tar.gz with a wrapper dir imports and opens with all requirements', async ({
    page,
  }, testInfo) => {
    const names = {
      parent: uniqueName('wrapt-parent'),
      child: uniqueName('wrapt-child'),
      nfr: uniqueName('wrapt-nfr'),
    };
    const exported = await buildAndExport(page, 'targz', testInfo, names);

    const wrapped = await repackTargzUnderWrapper(exported, 'wrapper', testInfo);

    await importArchive(page, uniqueName('wrap-dst-targz'), wrapped);

    await expect(page.getByTestId('section-function')).toContainText('(2)');
    await expect(rowByName(page, names.parent)).toBeVisible();
    await expect(rowByName(page, names.child)).toBeVisible();
    await expect(rowByName(page, names.nfr)).toBeVisible();
  });

  test('zip without openspec/ shows a clear error and creates no project', async ({
    page,
  }, testInfo) => {
    // A structurally valid zip that simply has no openspec/ anywhere.
    const bad = testInfo.outputPath('no-openspec.zip');
    const zip = new AdmZip();
    zip.addFile('docs/readme.md', Buffer.from('# not an openspec project\n'));
    zip.writeZip(bad);

    const name = uniqueName('wrap-bad');
    await importArchive(page, name, bad, { expectError: true });

    // The error explains the expected structure (mentions openspec).
    await expect(page.getByTestId('import-error')).toContainText('openspec');
    // Still on the import screen, nothing opened.
    await expect(page.getByTestId('import-page')).toBeVisible();

    // Atomicity: the failed import must not leave a project behind.
    const res = await page.request.get('/api/projects');
    expect(res.ok()).toBe(true);
    const projects = (await res.json()) as Array<{ id: string; name: string }>;
    expect(projects.some((p) => p.name.includes(name) || p.id.includes(name))).toBe(false);
  });
});
