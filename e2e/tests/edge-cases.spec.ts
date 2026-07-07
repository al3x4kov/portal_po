import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  addRequirement,
  createProject,
  deleteRequirement,
  linkRequirements,
  rowByName,
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

  test('S22 project name with OS-forbidden characters is rejected', async ({ page }) => {
    // A name made solely of reserved/path characters sanitizes to empty ⇒ the
    // server rejects it (ValidationError) and the UI surfaces newproject-error.
    await page.goto('/');
    await page.getByTestId('start-new').click();
    await page.getByTestId('newproject-name').fill('<>:"/\\|?*');
    await page.getByTestId('newproject-submit').click();
    await expect(page.getByTestId('newproject-error')).toBeVisible();
    // Still on the new-project screen; no project was created.
    await expect(page.getByTestId('newproject-page')).toBeVisible();
  });

  test('S8 duplicate requirement name in the same type is blocked (2.4.1)', async ({ page }) => {
    await createProject(page, uniqueName('dup-req'));
    const dup = uniqueName('FT');
    await addRequirement(page, { kind: 'function', name: dup });

    await page.getByTestId('add-function').click();
    await page.getByTestId('req-name').fill(dup);
    // Live check (case-insensitive uniqueness) flags the name as taken…
    await expect(page.getByTestId('req-name-status')).toHaveAttribute('data-state', 'taken');
    // …and the same name upper-cased is still rejected (case-insensitive).
    await page.getByTestId('req-name').fill(dup.toUpperCase());
    await expect(page.getByTestId('req-name-status')).toHaveAttribute('data-state', 'taken');
    // Submit stays disabled while the name is taken.
    await expect(page.getByTestId('req-submit')).toBeDisabled();
    await page.getByTestId('requirement-modal-close').click();
  });

  test('cycle in hierarchy is prevented in the LinkModal (2.4.3, UX-4)', async ({ page }) => {
    await createProject(page, uniqueName('cycle'));
    const a = uniqueName('F-a');
    const b = uniqueName('F-b');
    await addRequirement(page, { kind: 'function', name: a });
    await addRequirement(page, { kind: 'function', name: b });

    await linkRequirements(page, a, 'CHILD_OF', b); // a → child of b
    // b → child of a would close the loop a→b→a. UX-4: the target is offered
    // but disabled with a "создаст цикл" reason and submit is blocked.
    await linkRequirements(page, b, 'CHILD_OF', a, { expectBlocked: true });
  });

  test('a second parent is prevented in the LinkModal (2.4.4, UX-4)', async ({ page }) => {
    await createProject(page, uniqueName('two-parents'));
    const child = uniqueName('F-child');
    const p1 = uniqueName('F-p1');
    const p2 = uniqueName('F-p2');
    await addRequirement(page, { kind: 'function', name: child });
    await addRequirement(page, { kind: 'function', name: p1 });
    await addRequirement(page, { kind: 'function', name: p2 });

    await linkRequirements(page, child, 'CHILD_OF', p1);
    // Giving the child a second parent via p2 PARENT_OF child must be prevented.
    // UX-4: the child is disabled as a target with "у цели уже есть родитель".
    await linkRequirements(page, p2, 'PARENT_OF', child, { expectBlocked: true });
  });

  test('importing a corrupt archive shows an error (FR-3.4, §5)', async ({ page }, testInfo) => {
    const bad = await writeBrokenArchive(testInfo, 'broken.tar.gz');
    await page.goto('/');
    await page.getByTestId('start-import').click();
    // T2 (todo_17): файл выбираем ПЕРВЫМ (выбор перезаписывает имя автоименем).
    await page.getByTestId('import-file').setInputFiles(bad);
    await page.getByTestId('import-name').fill(uniqueName('imp-bad'));
    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('import-error')).toBeVisible();
    await expect(page.getByTestId('import-page')).toBeVisible();
  });

  test('S19 importing an .xlsx is not supported (rejected client-side)', async ({
    page,
  }, testInfo) => {
    // Excel is export-only; the import dropzone accepts .zip/.tar.gz/.tgz only.
    const xlsx = testInfo.outputPath('requirements.xlsx');
    await fs.writeFile(xlsx, Buffer.from('PK not really a workbook'));
    await page.goto('/');
    await page.getByTestId('start-import').click();
    await page.getByTestId('import-file').setInputFiles(xlsx);
    await expect(page.getByTestId('import-error')).toBeVisible();
    // The chosen file is rejected: no file chip, submit stays disabled.
    await expect(page.getByTestId('import-file-name')).toHaveCount(0);
    await expect(page.getByTestId('import-submit')).toBeDisabled();
  });

  test('unknown archive format is rejected client-side (§5)', async ({ page }, testInfo) => {
    const txt = testInfo.outputPath('notanarchive.txt');
    await fs.writeFile(txt, 'plain text');
    await page.goto('/');
    await page.getByTestId('start-import').click();
    await page.getByTestId('import-file').setInputFiles(txt);
    await expect(page.getByTestId('import-error')).toBeVisible();
  });

  test('S15 deleting a node with children requires cascade confirmation (UX-2)', async ({
    page,
  }) => {
    await createProject(page, uniqueName('has-children'));
    const parent = uniqueName('F-parent');
    const child = uniqueName('F-child');
    await addRequirement(page, { kind: 'function', name: parent });
    await addRequirement(page, { kind: 'function', name: child });
    await linkRequirements(page, child, 'CHILD_OF', parent);

    // UX-2: удаление узла с детьми больше НЕ блокируется — кнопка активна и
    // открывает каскадный диалог с усиленным подтверждением (type-to-confirm).
    // Полный сценарий фактического удаления покрыт cascade-delete.spec.ts;
    // здесь фиксируем, что вместо блокировки доступен путь каскада.
    const parentRow = rowByName(page, parent);
    await parentRow.hover();
    await parentRow.locator('[data-testid^="delete-btn-"]').click();
    await expect(page.getByTestId('delete-dialog')).toBeVisible();

    // Каскадный блок присутствует с корректным N (1 потомок).
    await expect(page.getByTestId('delete-dialog-cascade')).toContainText('1 требование');

    // Подтверждение заблокировано без ввода имени и активируется после точного ввода.
    const confirm = page.getByTestId('delete-dialog-confirm');
    await expect(confirm).toBeDisabled();
    await page.getByTestId('delete-dialog-input').fill(parent);
    await expect(confirm).toBeEnabled();

    // Сам факт удаления здесь не подтверждаем (покрыто cascade-delete.spec.ts).
    await page.getByTestId('delete-dialog-cancel').click();
    await expect(page.getByTestId('delete-dialog')).toBeHidden();
  });

  test('S14 deleting a requirement cleans up reverse links', async ({ page }) => {
    await createProject(page, uniqueName('reverse-links'));
    const parent = uniqueName('F-parent');
    const child = uniqueName('F-child');
    await addRequirement(page, { kind: 'function', name: parent });
    await addRequirement(page, { kind: 'function', name: child });
    // child CHILD_OF parent ⇒ parent gains a PARENT_OF reverse link.
    await linkRequirements(page, child, 'CHILD_OF', parent);

    // Delete the leaf child; this must cascade-clean parent's PARENT_OF link.
    await deleteRequirement(page, child);

    // Parent now has no children: its delete opens the plain (non-cascade)
    // dialog — proving the reverse PARENT_OF link was cleaned up (otherwise the
    // dialog would show the cascade block / require type-to-confirm).
    // Hover the row first so the action column is visible, then click delete.
    const parentRow = rowByName(page, parent);
    await parentRow.hover();
    await parentRow.locator('[data-testid^="delete-btn-"]').click();
    await expect(page.getByTestId('delete-dialog')).toBeVisible();
    // No leftover children ⇒ no cascade block, no name-input, safe note shown.
    await expect(page.getByTestId('delete-dialog-cascade')).toHaveCount(0);
    await expect(page.getByTestId('delete-dialog-input')).toHaveCount(0);
    // T4 (todo_17): текст заметки по макету confirm-dialog.html.
    await expect(page.getByTestId('delete-dialog-note')).toContainText(
      'Вложенных требований нет — удаление безопасно',
    );
    await page.getByTestId('delete-dialog-confirm').click();
    await expect(page.getByTestId('delete-dialog')).toBeHidden();
    await expect(rowByName(page, parent)).toBeHidden();
  });

  test('S23 Projects/ is recreated automatically when missing (DoD#4, FR-2.3)', async ({
    page,
  }) => {
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
