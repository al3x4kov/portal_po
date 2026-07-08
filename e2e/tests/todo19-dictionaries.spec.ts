import { expect, test } from '@playwright/test';
import {
  addRequirement,
  createProject,
  projectIdFromUrl,
  slugOf,
  uniqueName,
} from './helpers/app.js';
import {
  addSourceCard,
  fetchDictionaries,
  fetchRequirement,
  gotoDictionaries,
  openPriorityTab,
  saveRequirementModal,
} from './helpers/todo19.js';

/**
 * Волна 3 · T-303 / T-304 (todo_19): справочники проекта и combobox источника.
 *   T-303 — новый проект = ровно один приоритет «Квартальная цель» (дефолт);
 *           добавление приоритета (имя + цвет); дубликат имени → prio-error;
 *           удаление используемого приоритета требует замену, после reassign
 *           источники переносятся.
 *   T-304 — combobox: ввод показывает совпадения из справочника; «Создать новый
 *           источник» сразу добавляет запись в справочник (видно на экране
 *           «Справочники»).
 */

test('T-303 · дефолтный приоритет, добавление, дубликат и удаление с заменой', async ({ page }) => {
  await createProject(page, uniqueName('proj-t303'));
  const projectId = projectIdFromUrl(page);

  await gotoDictionaries(page);

  // Ровно один приоритет — дефолтная «Квартальная цель».
  await expect(page.locator('[data-testid^="prio-row-"]')).toHaveCount(1);
  await expect(page.getByTestId('prio-default-default')).toBeVisible();
  await expect(page.getByTestId('prio-name-default')).toHaveValue('Квартальная цель');

  // Добавить приоритет (имя + цвет).
  await page.getByTestId('prio-add-open').click();
  await expect(page.getByTestId('prio-add-form')).toBeVisible();
  await page.getByTestId('prio-add-name').fill('Высокий приоритет');
  await page.getByTestId('prio-add-color-red').click();
  await page.getByTestId('prio-add-save').click();

  await expect(page.locator('[data-testid^="prio-row-"]')).toHaveCount(2);
  const dict = await fetchDictionaries(page, projectId);
  const added = dict.priorities.find((p) => p.name === 'Высокий приоритет');
  expect(added, 'новый приоритет создан в справочнике').toBeTruthy();
  const addedId = added!.id;
  expect(added!.color).toBe('red');
  await expect(page.getByTestId(`prio-row-${addedId}`)).toBeVisible();
  await expect(page.getByTestId(`prio-name-${addedId}`)).toHaveValue('Высокий приоритет');

  // Краевое: дубликат имени → prio-error.
  await page.getByTestId('prio-add-open').click();
  await expect(page.getByTestId('prio-add-form')).toBeVisible();
  await page.getByTestId('prio-add-name').fill('Квартальная цель');
  await page.getByTestId('prio-add-save').click();
  await expect(page.getByTestId('prio-error')).toBeVisible();
  await expect(page.locator('[data-testid^="prio-row-"]')).toHaveCount(2);

  // Использовать новый приоритет в источнике требования.
  await page.getByTestId('sidebar-nav-requirements').click();
  await expect(page.getByTestId('main-page')).toBeVisible();
  const req = uniqueName('req-uses-prio');
  await addRequirement(page, { kind: 'function', name: req, criticality: 'HIGH' });
  await openPriorityTab(page, req);
  await addSourceCard(page, 0, {
    type: 'CLIENT',
    name: uniqueName('Заказчик'),
    priorityId: addedId,
  });
  await expect(page.getByTestId('src-priority-0')).toHaveValue(addedId);
  await saveRequirementModal(page);
  const slug = await slugOf(page, req);

  // Удаление используемого приоритета — требует замену (reassign), затем удаляется.
  await gotoDictionaries(page);
  await page.getByTestId(`prio-delete-${addedId}`).click();
  await expect(page.getByTestId(`prio-delete-panel-${addedId}`)).toBeVisible();
  // Пока замена не выбрана — подтверждение заблокировано.
  await expect(page.getByTestId(`prio-delete-confirm-${addedId}`)).toBeDisabled();
  await page.getByTestId(`prio-reassign-${addedId}`).selectOption('default');
  await page.getByTestId(`prio-delete-confirm-${addedId}`).click();

  await expect(page.getByTestId(`prio-row-${addedId}`)).toBeHidden();
  await expect(page.locator('[data-testid^="prio-row-"]')).toHaveCount(1);

  // Источник требования перенесён на дефолтный приоритет (не «висячий» id).
  const after = await fetchRequirement(page, projectId, slug);
  expect(after.sources?.[0]?.priorityId).toBe('default');
});

test('T-304 · combobox источника: поиск по справочнику и автосбор нового имени', async ({
  page,
}) => {
  await createProject(page, uniqueName('proj-t304'));
  const projectId = projectIdFromUrl(page);

  // Наполнить справочник источников одним элементом вручную.
  await gotoDictionaries(page);
  await page.getByTestId('source-add-open').click();
  await expect(page.getByTestId('source-add-form')).toBeVisible();
  const existing = 'Клиент Альфа';
  await page.getByTestId('source-add-name').fill(existing);
  await page.getByTestId('source-add-type').selectOption('CLIENT');
  await page.getByTestId('source-add-save').click();
  // Успех мутации закрывает форму; после этого запись есть в справочнике.
  await expect(page.getByTestId('source-add-form')).toBeHidden();

  await expect(async () => {
    const d = await fetchDictionaries(page, projectId);
    expect(d.sources.map((s) => s.name)).toContain(existing);
  }).toPass();
  const dict1 = await fetchDictionaries(page, projectId);
  const existingId = dict1.sources.find((s) => s.name === existing)!.id;

  // Открыть требование → combobox показывает совпадение при вводе части имени.
  await page.getByTestId('sidebar-nav-requirements').click();
  await expect(page.getByTestId('main-page')).toBeVisible();
  const req = uniqueName('req-combo');
  await addRequirement(page, { kind: 'function', name: req, criticality: 'MEDIUM' });

  await openPriorityTab(page, req);
  await page.getByTestId('src-add').click();
  const input = page.getByTestId('src-name-0-input');
  await input.click();
  await input.fill('Альф');
  await expect(page.getByTestId('src-name-0-menu')).toBeVisible();
  const option = page.getByTestId(`src-name-0-opt-${existingId}`);
  await expect(option).toBeVisible();
  await option.click();
  await expect(input).toHaveValue(existing);

  // Автосбор: ввод нового имени → «Создать новый источник» сразу пишет в справочник.
  await page.getByTestId('src-add').click();
  const input2 = page.getByTestId('src-name-1-input');
  const brandNew = 'Совет Директоров ПАО';
  await input2.click();
  await input2.fill(brandNew);
  await expect(page.getByTestId('src-name-1-create')).toBeVisible();
  await page.getByTestId('src-name-1-create').click();
  await expect(input2).toHaveValue(brandNew);

  // Новое имя появилось в справочнике проекта немедленно (до сохранения требования).
  await expect(async () => {
    const d = await fetchDictionaries(page, projectId);
    expect(d.sources.map((s) => s.name)).toContain(brandNew);
  }).toPass();

  const dict2 = await fetchDictionaries(page, projectId);
  const created = dict2.sources.find((s) => s.name === brandNew)!;

  // Закрываем модалку (правки не сохраняем — источник уже в справочнике).
  await page.getByTestId('req-cancel').click();
  await expect(page.getByTestId('requirement-modal')).toBeHidden();

  await gotoDictionaries(page);
  await expect(page.getByTestId(`source-row-${created.id}`)).toBeVisible();
  await expect(page.getByTestId(`source-name-${created.id}`)).toHaveValue(brandNew);
});
