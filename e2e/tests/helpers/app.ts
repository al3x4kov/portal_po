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

/** Extract the current project id from the `/p/:id` main-screen URL. */
export function projectIdFromUrl(page: Page): string {
  const m = /\/p\/([^/?#]+)/.exec(page.url());
  if (!m) throw new Error(`Not on a project page: ${page.url()}`);
  return decodeURIComponent(m[1]);
}

/**
 * Seed a requirement straight through the REST API (fast bulk fixtures for the
 * scale test, QA-2). Uses the page's request context so it shares the server
 * origin. Returns the created requirement's slug.
 */
export async function apiCreateRequirement(
  page: Page,
  projectId: string,
  opts: RequirementOptions,
): Promise<string> {
  const implemented = opts.implemented ?? true;
  const body: Record<string, unknown> = {
    type: opts.kind === 'function' ? 'FUNCTION' : 'NFR',
    name: opts.name,
    criticality: opts.criticality ?? 'MEDIUM',
    implemented,
  };
  if (!implemented) {
    body.targetQuarter = opts.quarter ?? 'Q1';
    body.targetYear = opts.year ?? 2027;
  }
  if (opts.description) body.description = opts.description;

  const res = await page.request.post(
    `/api/projects/${encodeURIComponent(projectId)}/requirements`,
    { data: body },
  );
  if (!res.ok()) {
    throw new Error(`apiCreateRequirement failed (${res.status()}): ${await res.text()}`);
  }
  const created = (await res.json()) as { slug: string };
  return created.slug;
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

/** Locate a requirement row by its (type-unique) name (new UI: data-req-name on <tr>). */
export function rowByName(page: Page, name: string): Locator {
  return page.locator(`tr[data-req-name="${name}"]`);
}

/**
 * Add a functional or non-functional requirement via the modal (FR-6).
 * New UI: name input testid `req-name`, criticality is a radiogroup
 * (`req-criticality-<low..critical>`), submit is `req-submit`, and conditional
 * target fields live under `req-target`.
 */
export async function addRequirement(page: Page, opts: RequirementOptions): Promise<void> {
  const implemented = opts.implemented ?? true;
  await page.getByTestId(`add-${opts.kind}`).click();
  const modal = page.getByTestId('requirement-modal');
  await expect(modal).toBeVisible();

  await page.getByTestId('req-name').fill(opts.name);
  if (opts.criticality) {
    await page.getByTestId(`req-criticality-${opts.criticality.toLowerCase()}`).click();
  }

  if (implemented) {
    await page.getByTestId('req-implemented-yes').click();
    await expect(page.getByTestId('req-target')).toBeHidden();
  } else {
    await page.getByTestId('req-implemented-no').click();
    await expect(page.getByTestId('req-target')).toBeVisible();
    await page.getByTestId('req-quarter').selectOption(opts.quarter ?? 'Q1');
    await page.getByTestId('req-year').fill(String(opts.year ?? 2027));
  }

  if (opts.description) await page.getByTestId('req-description').fill(opts.description);

  await page.getByTestId('req-submit').click();
  await expect(modal).toBeHidden();
  await expect(rowByName(page, opts.name)).toBeVisible();
}

/**
 * Resolve the stable `slug` of a requirement from its row's `tree-row-<slug>`
 * testid. Several E15 testids are keyed by slug (`req-link-<slug>`,
 * `req-link-del-<slug>`, `rel-chip-<src>-<tgt>`), so tests need the slug.
 */
export async function slugOf(page: Page, name: string): Promise<string> {
  const testid = await rowByName(page, name).getAttribute('data-testid');
  if (!testid) throw new Error(`No row found for requirement "${name}"`);
  return testid.replace(/^tree-row-/, '');
}

/** Open the edit modal for a requirement by clicking its name button. */
export async function openEdit(page: Page, name: string): Promise<Locator> {
  await rowByName(page, name).locator('[data-testid^="req-name-"]').click();
  const modal = page.getByTestId('requirement-modal');
  await expect(modal).toBeVisible();
  return modal;
}

/** Edit an existing requirement's name, going through the save confirmation. */
export async function renameRequirement(
  page: Page,
  oldName: string,
  newName: string,
): Promise<void> {
  const modal = await openEdit(page, oldName);
  await page.getByTestId('req-name').fill(newName);
  await page.getByTestId('req-submit').click();
  // Editing requires explicit confirmation (FR-6.5).
  await expect(page.getByTestId('req-save-confirm')).toBeVisible();
  await page.getByTestId('req-save-confirm-confirm').click();
  await expect(modal).toBeHidden();
  await expect(rowByName(page, newName)).toBeVisible();
}

/**
 * Create a link between two requirements (FR-8).
 *
 * - `expectBlocked` (UX-4): the target is incompatible (cycle / second parent /
 *   type mismatch); the LinkModal keeps it visible but *disabled* with a reason
 *   (`data-disabled="true"`, `link-result-reason-<slug>`) and blocks submit —
 *   the client prevents the invalid pick, the server stays the last line.
 * - `expectError`: a server-side rejection still surfaces in `link-error`.
 */
export async function linkRequirements(
  page: Page,
  sourceName: string,
  type: LinkType,
  targetName: string,
  opts: { expectError?: boolean; expectBlocked?: boolean } = {},
): Promise<void> {
  await rowByName(page, sourceName).locator('[data-testid^="link-btn-"]').click();
  const modal = page.getByTestId('link-modal');
  await expect(modal).toBeVisible();
  await page.getByTestId('link-type').selectOption(type);
  await page.getByTestId('link-search').fill(targetName);

  const candidate = page
    .getByTestId('link-results')
    .locator('[data-testid^="link-result-"]')
    .filter({ hasText: targetName })
    .first();

  if (opts.expectBlocked) {
    // Incompatible target: disabled with a reason, and submit stays disabled.
    await expect(candidate).toHaveAttribute('data-disabled', 'true');
    await expect(candidate).toBeDisabled();
    await expect(
      candidate.locator('[data-testid^="link-result-reason-"]'),
    ).toBeVisible();
    await expect(page.getByTestId('link-submit')).toBeDisabled();
    await page.getByTestId('link-cancel').click();
    await expect(modal).toBeHidden();
    return;
  }

  await candidate.click();
  await page.getByTestId('link-submit').click();

  if (opts.expectError) {
    await expect(page.getByTestId('link-error')).toBeVisible();
    await page.getByTestId('link-cancel').click();
  }
  await expect(modal).toBeHidden();
}

/** Switch the tree toolbar display mode (B1). */
export async function setTreeMode(page: Page, mode: 'expand-all' | 'collapse'): Promise<void> {
  const testid = mode === 'expand-all' ? 'toggle-expand-all' : 'toggle-collapse';
  const btn = page.getByTestId(testid);
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
}

/**
 * In "Скрыть зависимости" (collapse) mode, expand a collapsed branch by clicking
 * its "N зависимостей" chip (`expand-node`) inside the parent's row.
 */
export async function expandNode(page: Page, parentName: string): Promise<void> {
  const chip = rowByName(page, parentName).getByTestId('expand-node');
  await expect(chip).toBeVisible();
  await chip.click();
}

/** Delete a leaf requirement through the confirmation dialog (FR-9). */
export async function deleteRequirement(page: Page, name: string): Promise<void> {
  await rowByName(page, name).locator('[data-testid^="delete-btn-"]').click();
  await expect(page.getByTestId('delete-dialog')).toBeVisible();
  await page.getByTestId('delete-dialog-confirm').click();
  await expect(page.getByTestId('delete-dialog')).toBeHidden();
  await expect(rowByName(page, name)).toBeHidden();
}

/**
 * Attempt to delete a node that still has children; expect it to be blocked
 * (UX-3, S15): the dialog warns about the children *and* the destructive
 * confirm is disabled up-front — the click that would fail server-side never
 * happens. Cancel leaves the requirement intact.
 */
export async function expectDeleteBlocked(page: Page, name: string): Promise<void> {
  await rowByName(page, name).locator('[data-testid^="delete-btn-"]').click();
  const dialog = page.getByTestId('delete-dialog');
  await expect(dialog).toBeVisible();
  // The dialog warns about children up-front (danger note).
  await expect(page.getByTestId('delete-dialog-note')).toContainText('дочерних');
  // UX-3: the destructive action is disabled while children exist.
  await expect(page.getByTestId('delete-dialog-confirm')).toBeDisabled();
  await page.getByTestId('delete-dialog-cancel').click();
  await expect(dialog).toBeHidden();
  await expect(rowByName(page, name)).toBeVisible();
}

/** Download a .zip / .tar.gz export archive and return the saved file path. */
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
