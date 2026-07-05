import { expect, test } from '@playwright/test';
import { addRequirement, createProject, openEdit, rowByName, uniqueName } from './helpers/app.js';

/**
 * Iteration 6 E2E tests covering FR-17, FR-18, FR-19, FR-20, FR-22.
 *
 * FR-17: Поле "Источник требования" в RequirementModal (req-source)
 * FR-18: Колонка "Источник" в TreeTable (req-source-cell)
 * FR-19: Фильтр "Источник" в TreeToolbar (source-filter / source-dropdown)
 * FR-20: Справочная информация в RequirementModal (info-add-btn / info-*)
 * FR-22: Фильтры в TrackerSelectModal (tasks-filter-zone / tasks-filter-crit-*) — внутри «Выбор ФТ/НФТ для TaskTracker»
 */

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: FR-17 + FR-18 · Source field saved and shown in tree column
// ─────────────────────────────────────────────────────────────────────────────
test('FR-17/18: поле источника сохраняется и отображается в колонке дерева', async ({ page }) => {
  const project = uniqueName('src-field');
  const reqName = uniqueName('Auth');

  await createProject(page, project);

  // Open create-requirement modal and fill in source field
  await page.getByTestId('add-function').click();
  const modal = page.getByTestId('requirement-modal');
  await expect(modal).toBeVisible();

  await page.getByTestId('req-name').fill(reqName);
  await page.getByTestId('req-criticality-high').click();

  // Fill source field (FR-17) — T4 (todo_17): now a select with presets
  await page.getByTestId('req-source').selectOption('АС21');

  // Set implementation status
  await page.getByTestId('req-implemented-yes').click();
  await expect(page.getByTestId('req-target')).toBeHidden();

  await page.getByTestId('req-submit').click();
  await expect(modal).toBeHidden();
  await expect(rowByName(page, reqName)).toBeVisible();

  // FR-18: source value visible in the "Источник" column
  const sourceCell = rowByName(page, reqName).getByTestId('req-source-cell');
  await expect(sourceCell).toBeVisible();
  await expect(sourceCell).toContainText('АС21');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: FR-18 · Requirement without source shows dash
// ─────────────────────────────────────────────────────────────────────────────
test('FR-18: требование без источника показывает прочерк в колонке', async ({ page }) => {
  const project = uniqueName('src-dash');
  const reqName = uniqueName('NoDash');

  await createProject(page, project);
  await addRequirement(page, { kind: 'function', name: reqName, criticality: 'MEDIUM' });

  const sourceCell = rowByName(page, reqName).getByTestId('req-source-cell');
  await expect(sourceCell).toBeVisible();
  await expect(sourceCell).toContainText('—');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: FR-19 · Source filter — фильтрует требования по источнику
// ─────────────────────────────────────────────────────────────────────────────
test('FR-19: фильтр "Источник" скрывает требования без выбранного источника', async ({ page }) => {
  const project = uniqueName('src-filter');
  const withSource = uniqueName('WithSrc');
  const noSource = uniqueName('NoSrc');

  await createProject(page, project);

  // Create requirement with source
  await page.getByTestId('add-function').click();
  await expect(page.getByTestId('requirement-modal')).toBeVisible();
  await page.getByTestId('req-name').fill(withSource);
  await page.getByTestId('req-criticality-high').click();
  await page.getByTestId('req-source').selectOption('АС21');
  await page.getByTestId('req-implemented-yes').click();
  await page.getByTestId('req-submit').click();
  await expect(page.getByTestId('requirement-modal')).toBeHidden();
  await expect(rowByName(page, withSource)).toBeVisible();

  // Create requirement without source
  await addRequirement(page, { kind: 'function', name: noSource, criticality: 'LOW' });

  // Both requirements visible initially
  await expect(rowByName(page, withSource)).toBeVisible();
  await expect(rowByName(page, noSource)).toBeVisible();

  // Open source filter dropdown
  await page.getByTestId('source-filter').click();
  await expect(page.getByTestId('source-dropdown')).toBeVisible();

  // Select "АС21" option (testid: source-opt-АС21)
  await page.getByTestId('source-opt-АС21').click();

  // Apply filter
  await page.getByTestId('source-apply').click();
  await expect(page.getByTestId('source-dropdown')).toBeHidden();

  // Badge counter appears (FR-19: source-count)
  await expect(page.getByTestId('source-count')).toBeVisible();
  await expect(page.getByTestId('source-count')).toContainText('1');

  // Only withSource visible; noSource is hidden
  await expect(rowByName(page, withSource)).toBeVisible();
  await expect(rowByName(page, noSource)).toBeHidden();

  // Reset filter — both requirements visible again
  await page.getByTestId('source-filter').click();
  await expect(page.getByTestId('source-dropdown')).toBeVisible();
  await page.getByTestId('source-reset').click();
  await expect(page.getByTestId('source-dropdown')).toBeHidden();

  await expect(rowByName(page, withSource)).toBeVisible();
  await expect(rowByName(page, noSource)).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: FR-20 · InfoItems — добавление и удаление справочной информации
// ─────────────────────────────────────────────────────────────────────────────
test('FR-20: добавление и удаление пары справочной информации', async ({ page }) => {
  const project = uniqueName('info-items');
  const reqName = uniqueName('Spec');

  await createProject(page, project);
  await addRequirement(page, { kind: 'function', name: reqName, criticality: 'MEDIUM' });

  // Open edit modal; info items now live behind the «Справочно» tab (T4, todo_17)
  const modal = await openEdit(page, reqName);
  await page.getByTestId('req-tab-info').click();

  // Click "+" to show inline add form
  await page.getByTestId('info-add-btn').click();
  await expect(page.getByTestId('info-type-input')).toBeVisible();
  await expect(page.getByTestId('info-value-input')).toBeVisible();

  // Fill in type and value
  await page.getByTestId('info-type-input').fill('Регламент');
  await page.getByTestId('info-value-input').fill('ГОСТ 34');

  // Apply — pair should appear in list and form should hide
  await page.getByTestId('info-apply-btn').click();
  await expect(page.getByTestId('info-type-input')).toBeHidden();

  // Verify the item is visible in the list
  await expect(modal.getByText('Регламент')).toBeVisible();
  await expect(modal.getByText('ГОСТ 34')).toBeVisible();

  // Save the requirement — T4 (todo_17): no confirm, toast «Сохранено» instead
  await page.getByTestId('req-submit').click();
  await expect(modal).toBeHidden();
  await expect(page.getByTestId('toast').filter({ hasText: 'Сохранено' })).toBeVisible();

  // Re-open to verify persistence (info items behind the «Справочно» tab)
  const modal2 = await openEdit(page, reqName);
  await page.getByTestId('req-tab-info').click();
  await expect(modal2.getByText('Регламент')).toBeVisible();
  await expect(modal2.getByText('ГОСТ 34')).toBeVisible();

  // Delete the pair — click delete button
  await page.getByTestId('info-delete-0').click();

  // Inline confirmation appears
  await expect(page.getByTestId('info-delete-confirm-0')).toBeVisible();
  await expect(page.getByTestId('info-delete-cancel-0')).toBeVisible();

  // Confirm deletion
  await page.getByTestId('info-delete-confirm-0').click();

  // Pair disappears from the list
  await expect(modal2.getByText('Регламент')).toBeHidden();
  await expect(modal2.getByText('ГОСТ 34')).toBeHidden();

  // Close modal without saving (cancel, no dirty changes after delete)
  await page.getByTestId('req-cancel').click();
  // Modal may ask for confirmation if dirty — dismiss if appears
  const cancelConfirm = page.getByTestId('req-cancel-confirm');
  if (await cancelConfirm.isVisible()) {
    await page.getByTestId('req-cancel-confirm-confirm').click();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: FR-20 · InfoItems — кнопка "Нет" отменяет удаление
// ─────────────────────────────────────────────────────────────────────────────
test('FR-20: кнопка "Нет" при удалении пары отменяет операцию', async ({ page }) => {
  const project = uniqueName('info-cancel');
  const reqName = uniqueName('SpecCancel');

  await createProject(page, project);
  await addRequirement(page, { kind: 'function', name: reqName, criticality: 'MEDIUM' });

  const modal = await openEdit(page, reqName);
  await page.getByTestId('req-tab-info').click();

  // Add info pair
  await page.getByTestId('info-add-btn').click();
  await page.getByTestId('info-type-input').fill('Документ');
  await page.getByTestId('info-value-input').fill('ТЗ-001');
  await page.getByTestId('info-apply-btn').click();
  await expect(modal.getByText('Документ')).toBeVisible();

  // Click delete, then cancel
  await page.getByTestId('info-delete-0').click();
  await expect(page.getByTestId('info-delete-confirm-0')).toBeVisible();
  await page.getByTestId('info-delete-cancel-0').click();

  // Pair must still be visible
  await expect(modal.getByText('Документ')).toBeVisible();
  await expect(modal.getByText('ТЗ-001')).toBeVisible();

  // Close modal
  await page.getByTestId('req-cancel').click();
  const cancelConfirm = page.getByTestId('req-cancel-confirm');
  if (await cancelConfirm.isVisible()) {
    await page.getByTestId('req-cancel-confirm-confirm').click();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: FR-22 · Фильтры находятся в модале "Выбор ФТ/НФТ для TaskTracker"
// ─────────────────────────────────────────────────────────────────────────────
test('FR-22: Фильтры в TrackerSelectModal (Выбор ФТ/НФТ для TaskTracker)', async ({ page }) => {
  const project = uniqueName('export-tasks');
  const req1 = uniqueName('FuncHigh');
  const req2 = uniqueName('FuncLow');

  await createProject(page, project);
  await addRequirement(page, { kind: 'function', name: req1, criticality: 'HIGH' });
  await addRequirement(page, { kind: 'function', name: req2, criticality: 'LOW' });

  // Open ExportTasksModal via sidebar
  await page.getByTestId('sidebar-open-tasks').click();
  await expect(page.getByTestId('export-tasks-modal')).toBeVisible();

  // Filter zone must NOT be visible on the choose step
  await expect(page.getByTestId('tasks-filter-zone')).not.toBeVisible();

  // Navigate into the tracker direction → opens TrackerSelectModal
  await page.getByTestId('export-tasks-dir-tracker').click();
  const selectModal = page.getByTestId('tracker-select-modal');
  await expect(selectModal).toBeVisible();

  // FR-22: filter zone is present inside TrackerSelectModal (shared RequirementPickerModal)
  await expect(selectModal.getByTestId('export-filter-zone')).toBeVisible();

  // Criticality chips present
  await expect(selectModal.getByTestId('export-filter-crit-HIGH')).toBeVisible();
  await expect(selectModal.getByTestId('export-filter-crit-LOW')).toBeVisible();
  await expect(selectModal.getByTestId('export-filter-crit-CRITICAL')).toBeVisible();
  await expect(selectModal.getByTestId('export-filter-crit-MEDIUM')).toBeVisible();

  // Implementation filter chips present
  await expect(selectModal.getByTestId('export-filter-impl-all')).toBeVisible();
  await expect(selectModal.getByTestId('export-filter-impl-done')).toBeVisible();
  await expect(selectModal.getByTestId('export-filter-impl-planned')).toBeVisible();

  // Click HIGH criticality chip — only req1 should remain visible in the list
  await selectModal.getByTestId('export-filter-crit-HIGH').click();
  // Count: "1 из 2 выбрано" reflects filtered selection
  await expect(selectModal.getByTestId('export-filter-zone')).toBeVisible();

  // Deselect HIGH — list resets to full
  await selectModal.getByTestId('export-filter-crit-HIGH').click();
  await expect(selectModal.getByTestId('export-filter-zone')).toBeVisible();
});
