import { expect, test } from '@playwright/test';
import {
  addRequirement,
  createProject,
  openEdit,
  projectIdFromUrl,
  rowByName,
  slugOf,
  uniqueName,
} from './helpers/app.js';

/**
 * QA-5 · stale-data & boundary inputs (Q3).
 *
 * (b) Stale data: a requirement changed by "another session" (simulated with a
 *     direct API call) must yield a clear error / consistent state on the next
 *     UI mutation — never a silent overwrite or a silently-resurrected record.
 * (c) Boundary names: empty / whitespace-only are refused (submit disabled),
 *     while max-length (200) and Unicode+emoji names are accepted.
 */

test.describe('QA-5 · stale data (edited/deleted by another session)', () => {
  test('editing a requirement deleted by another session shows an error, no silent loss', async ({
    page,
  }) => {
    await createProject(page, uniqueName('stale-edit'));
    const name = uniqueName('F-stale');
    await addRequirement(page, { kind: 'function', name });
    const projectId = projectIdFromUrl(page);
    const slug = await slugOf(page, name);

    // Open the edit modal while the row is still present…
    await openEdit(page, name);

    // …then another session deletes the same requirement out from under us.
    const del = await page.request.delete(
      `/api/projects/${encodeURIComponent(projectId)}/requirements/${encodeURIComponent(slug)}`,
    );
    expect(del.ok()).toBeTruthy();

    // Now try to save an edit: the stale PUT must fail loudly (NotFound), the
    // modal stays open with a visible error — no silent success.
    await page.getByTestId('req-name').fill(uniqueName('F-stale-renamed'));
    // T4 (todo_17): save is level-0 friction — the PUT fires immediately, no confirm.
    await page.getByTestId('req-submit').click();

    await expect(page.getByTestId('req-error')).toBeVisible();
    await expect(page.getByTestId('requirement-modal')).toBeVisible();

    // Consistency: after reloading, the requirement is gone (the failed edit did
    // not resurrect or duplicate it).
    await page.goto(`/p/${encodeURIComponent(projectId)}`);
    await expect(page.getByTestId('main-page')).toBeVisible();
    await expect(rowByName(page, name)).toHaveCount(0);
    await expect(page.getByTestId('section-function')).toContainText('(0)');
  });

  test('deleting a requirement already deleted by another session shows an error', async ({
    page,
  }) => {
    await createProject(page, uniqueName('stale-del'));
    const name = uniqueName('F-stale2');
    await addRequirement(page, { kind: 'function', name });
    const projectId = projectIdFromUrl(page);
    const slug = await slugOf(page, name);

    // Open the delete dialog, then delete the record via another session.
    await rowByName(page, name).locator('[data-testid^="delete-btn-"]').click();
    await expect(page.getByTestId('delete-dialog')).toBeVisible();
    const del = await page.request.delete(
      `/api/projects/${encodeURIComponent(projectId)}/requirements/${encodeURIComponent(slug)}`,
    );
    expect(del.ok()).toBeTruthy();

    // Confirming the now-stale delete surfaces a comprehensible error.
    await page.getByTestId('delete-dialog-confirm').click();
    await expect(page.getByTestId('delete-dialog-error')).toBeVisible();
    await page.getByTestId('delete-dialog-cancel').click();
  });
});

test.describe('QA-5 · boundary requirement names', () => {
  test('empty name keeps Save disabled', async ({ page }) => {
    await createProject(page, uniqueName('bnd-empty'));
    await page.getByTestId('add-function').click();
    await expect(page.getByTestId('requirement-modal')).toBeVisible();
    await page.getByTestId('req-name').fill('');
    await expect(page.getByTestId('req-submit')).toBeDisabled();
    await page.getByTestId('requirement-modal-close').click();
  });

  test('whitespace-only name keeps Save disabled', async ({ page }) => {
    await createProject(page, uniqueName('bnd-ws'));
    await page.getByTestId('add-function').click();
    await expect(page.getByTestId('requirement-modal')).toBeVisible();
    await page.getByTestId('req-name').fill('     ');
    await expect(page.getByTestId('req-submit')).toBeDisabled();
    await page.getByTestId('requirement-modal-close').click();
  });

  test('maximum-length (200 chars) name is accepted', async ({ page }) => {
    await createProject(page, uniqueName('bnd-max'));
    const prefix = uniqueName('MX');
    const name = prefix + 'a'.repeat(200 - prefix.length); // exactly 200 chars
    expect(name.length).toBe(200);
    await addRequirement(page, { kind: 'function', name, criticality: 'MEDIUM' });
    await expect(rowByName(page, name)).toBeVisible();
    await expect(page.getByTestId('section-function')).toContainText('(1)');
  });

  test('Unicode + emoji name is accepted and round-trips', async ({ page }) => {
    await createProject(page, uniqueName('bnd-uni'));
    const name = `${uniqueName('U')} Оплата 💳✨ 测试`;
    await addRequirement(page, { kind: 'function', name, criticality: 'HIGH' });
    await expect(rowByName(page, name)).toBeVisible();
    // The exact string survives a reload (persisted verbatim).
    const projectId = projectIdFromUrl(page);
    await page.goto(`/p/${encodeURIComponent(projectId)}`);
    await expect(rowByName(page, name)).toBeVisible();
  });
});
