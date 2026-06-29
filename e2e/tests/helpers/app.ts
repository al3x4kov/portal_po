import { promises as fs } from 'node:fs';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

export type LinkType = 'CHILD_OF' | 'PARENT_OF' | 'RELATES_TO' | 'DEPENDS_ON' | 'BLOCKED_BY';
export type ReqKind = 'function' | 'nfr';
export type Criticality = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4';

let counter = 0;

/** Collision-free name (unique per type within a project) for test isolation. */
export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export interface RequirementOptions {
  kind: ReqKind;
  name: string;
  criticality?: Criticality;
  implemented?: boolean;
  quarter?: Quarter;
  year?: number;
  description?: string;
}

/** Start screen → create a project → open it; ends on the main screen. */
export async function createProject(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('start-new').click();
  await page.getByTestId('newproject-name').fill(name);
  await page.getByTestId('newproject-submit').click();
  await expect(page.getByTestId('newproject-success')).toBeVisible();
  await page.getByTestId('newproject-open').click();
  await expect(page.getByTestId('main-page')).toBeVisible();
}

/** Open an existing project by name from the "Open existing" list. */
export async function openExistingProject(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('start-open').click();
  await page.getByTestId('open-list').getByText(name, { exact: true }).click();
  await expect(page.getByTestId('main-page')).toBeVisible();
}

/** Locate a requirement row by its (type-unique) name. */
export function rowByName(page: Page, name: string): Locator {
  return page.locator(`tr[data-req-name="${name}"]`);
}

/** Add a functional or non-functional requirement via the modal (FR-6). */
export async function addRequirement(page: Page, opts: RequirementOptions): Promise<void> {
  const implemented = opts.implemented ?? true;
  await page.getByTestId(`add-${opts.kind}`).click();
  const modal = page.getByTestId('requirement-modal');
  await expect(modal).toBeVisible();

  await page.getByTestId('req-name-input').fill(opts.name);
  if (opts.criticality) await page.getByTestId('req-criticality').selectOption(opts.criticality);

  if (implemented) {
    await page.getByTestId('req-implemented-yes').click();
    await expect(page.getByTestId('req-target-fields')).toBeHidden();
  } else {
    await page.getByTestId('req-implemented-no').click();
    await expect(page.getByTestId('req-target-fields')).toBeVisible();
    await page.getByTestId('req-quarter').selectOption(opts.quarter ?? 'Q1');
    await page.getByTestId('req-year').fill(String(opts.year ?? 2027));
  }

  if (opts.description) await page.getByTestId('req-description').fill(opts.description);

  await page.getByTestId('req-apply').click();
  await expect(modal).toBeHidden();
  await expect(rowByName(page, opts.name)).toBeVisible();
}

/** Edit an existing requirement's name, going through the save confirmation. */
export async function renameRequirement(
  page: Page,
  oldName: string,
  newName: string,
): Promise<void> {
  await rowByName(page, oldName).locator('[data-testid^="req-name-"]').click();
  const modal = page.getByTestId('requirement-modal');
  await expect(modal).toBeVisible();
  await page.getByTestId('req-name-input').fill(newName);
  await page.getByTestId('req-apply').click();
  // Editing requires explicit confirmation (FR-6.5).
  await expect(page.getByTestId('req-save-confirm')).toBeVisible();
  await page.getByTestId('req-save-confirm-confirm').click();
  await expect(modal).toBeHidden();
  await expect(rowByName(page, newName)).toBeVisible();
}

/** Create a link between two requirements (FR-8). */
export async function linkRequirements(
  page: Page,
  sourceName: string,
  type: LinkType,
  targetName: string,
  opts: { expectError?: boolean } = {},
): Promise<void> {
  await rowByName(page, sourceName).locator('[data-testid^="link-btn-"]').click();
  const modal = page.getByTestId('link-modal');
  await expect(modal).toBeVisible();
  await page.getByTestId('link-type').selectOption(type);
  await page.getByTestId('link-search').fill(targetName);
  await page
    .getByTestId('link-results')
    .locator('[data-testid^="link-result-"]')
    .filter({ hasText: targetName })
    .first()
    .click();
  await page.getByTestId('link-submit').click();

  if (opts.expectError) {
    await expect(page.getByTestId('link-error')).toBeVisible();
    await page.getByTestId('link-cancel').click();
  }
  await expect(modal).toBeHidden();
}

/** Expand a tree node so its children become visible. */
export async function expandRow(page: Page, name: string): Promise<void> {
  const toggle = rowByName(page, name).locator('[data-testid^="tree-toggle-"]');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/** Delete a leaf requirement through the confirmation dialog (FR-9). */
export async function deleteRequirement(page: Page, name: string): Promise<void> {
  await rowByName(page, name).locator('[data-testid^="delete-btn-"]').click();
  await expect(page.getByTestId('delete-dialog')).toBeVisible();
  await page.getByTestId('delete-dialog-confirm').click();
  await expect(page.getByTestId('delete-dialog')).toBeHidden();
  await expect(rowByName(page, name)).toBeHidden();
}

/** Attempt to delete a node that still has children; expect it to be blocked. */
export async function expectDeleteBlocked(page: Page, name: string): Promise<void> {
  await rowByName(page, name).locator('[data-testid^="delete-btn-"]').click();
  const dialog = page.getByTestId('delete-dialog');
  await expect(dialog).toBeVisible();
  // The dialog warns about children up-front (danger note).
  await expect(page.getByTestId('delete-dialog-note')).toContainText('дочерних');
  await page.getByTestId('delete-dialog-confirm').click();
  // Server rejects (HAS_CHILDREN) and the error is surfaced in the dialog.
  await expect(page.getByTestId('delete-dialog-error')).toBeVisible();
  await page.getByTestId('delete-dialog-cancel').click();
  await expect(dialog).toBeHidden();
  await expect(rowByName(page, name)).toBeVisible();
}

/** Download an export archive and return the saved file path. */
export async function exportArchive(
  page: Page,
  format: 'zip' | 'targz',
  testInfo: TestInfo,
): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(format === 'zip' ? 'export-zip' : 'export-targz').click(),
  ]);
  const target = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(target);
  return target;
}

/** Import an archive under a new project name (FR-3). */
export async function importArchive(
  page: Page,
  name: string,
  filePath: string,
  opts: { expectError?: boolean } = {},
): Promise<void> {
  await page.goto('/');
  await page.getByTestId('start-import').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-file').setInputFiles(filePath);
  await page.getByTestId('import-submit').click();
  if (opts.expectError) {
    await expect(page.getByTestId('import-error')).toBeVisible();
  } else {
    await expect(page.getByTestId('main-page')).toBeVisible();
  }
}

/** Write a deliberately corrupt archive file and return its path. */
export async function writeBrokenArchive(testInfo: TestInfo, filename: string): Promise<string> {
  const p = testInfo.outputPath(filename);
  await fs.writeFile(p, Buffer.from('this is not a valid archive at all'));
  return p;
}
