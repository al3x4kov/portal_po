import { expect, test } from '@playwright/test';
import {
  addRequirement,
  createProject,
  projectIdFromUrl,
  rowByName,
  slugOf,
  uniqueName,
} from './helpers/app.js';
import {
  addSourceCard,
  fetchDictionaries,
  gotoDictionaries,
  openPriorityTab,
  saveRequirementModal,
} from './helpers/todo19.js';

/**
 * Волна 3 · T-305 / T-306 (todo_19): валидация сроков и представление в дереве.
 *   T-305 — дата вне квартала (срок источника или releaseDate PO) → бледное
 *           предупреждение, сохранение проходит; releaseDate скрыт при
 *           implemented=true (есть po-implemented-note).
 *   T-306 — дерево: двухуровневая колонка срока (квартал/год + «выпуск …» /
 *           «Реализовано»); срез «По источникам» — требование с 2 источниками
 *           в 2 группах со своим приоритетом.
 *
 * Инвариант: сентябрь ∈ Q3 (без предупреждения); ноябрь при Q3 → предупреждение.
 */

test('T-305 · срок источника вне квартала: предупреждение, сохранение проходит', async ({
  page,
}) => {
  await createProject(page, uniqueName('proj-t305a'));
  const req = uniqueName('req-srcdate');
  await addRequirement(page, {
    kind: 'function',
    name: req,
    criticality: 'HIGH',
    implemented: false,
    quarter: 'Q3',
    year: 2026,
  });

  await openPriorityTab(page, req);
  // Ноябрь при квартале Q3 → бледное предупреждение (сохранить можно).
  await addSourceCard(page, 0, {
    type: 'CLIENT',
    name: uniqueName('Заказчик'),
    quarter: 'Q3',
    year: '2026',
    date: '2026-11-15',
  });
  await expect(page.getByTestId('src-date-warning-0')).toBeVisible();

  // Сентябрь ∈ Q3 → предупреждение исчезает.
  await page.getByTestId('src-date-0').fill('2026-09-15');
  await expect(page.getByTestId('src-date-warning-0')).toBeHidden();

  // Возвращаем дату вне квартала и убеждаемся, что сохранение всё равно проходит.
  await page.getByTestId('src-date-0').fill('2026-11-15');
  await expect(page.getByTestId('src-date-warning-0')).toBeVisible();
  await saveRequirementModal(page);
  await expect(rowByName(page, req)).toBeVisible();
});

test('T-305 · releaseDate: предупреждение вне квартала и скрытие при implemented=true', async ({
  page,
}) => {
  await createProject(page, uniqueName('proj-t305b'));

  // Планируемое требование: releaseDate виден в блоке «Решение PO».
  const planned = uniqueName('req-planned');
  await addRequirement(page, {
    kind: 'function',
    name: planned,
    criticality: 'HIGH',
    implemented: false,
    quarter: 'Q3',
    year: 2026,
  });
  await openPriorityTab(page, planned);
  await expect(page.getByTestId('po-quarter')).toHaveValue('Q3');
  await expect(page.getByTestId('po-year')).toHaveValue('2026');
  // Дата выпуска в ноябре при Q3 → бледное предупреждение.
  await page.getByTestId('po-release-date').fill('2026-11-20');
  await expect(page.getByTestId('po-release-warning')).toBeVisible();
  // Сентябрь ∈ Q3 → предупреждение исчезает; сохранение проходит.
  await page.getByTestId('po-release-date').fill('2026-09-20');
  await expect(page.getByTestId('po-release-warning')).toBeHidden();
  await saveRequirementModal(page);

  // Реализованное требование: releaseDate скрыт, есть примечание.
  const done = uniqueName('req-done');
  await addRequirement(page, {
    kind: 'function',
    name: done,
    criticality: 'MEDIUM',
    implemented: true,
  });
  await openPriorityTab(page, done);
  await expect(page.getByTestId('po-implemented-note')).toBeVisible();
  await expect(page.getByTestId('po-release-date')).toHaveCount(0);
  await expect(page.getByTestId('po-quarter')).toHaveCount(0);
});

test('T-306 · дерево: двухуровневая колонка срока и срез «По источникам»', async ({ page }) => {
  await createProject(page, uniqueName('proj-t306'));
  const projectId = projectIdFromUrl(page);

  // Второй приоритет для демонстрации «своего» приоритета у источника.
  await gotoDictionaries(page);
  await page.getByTestId('prio-add-open').click();
  await page.getByTestId('prio-add-name').fill('Пожелание');
  await page.getByTestId('prio-add-color-amber').click();
  await page.getByTestId('prio-add-save').click();
  // Ждём, пока приоритет реально сохранится (UI-строка появляется после рефетча).
  await expect(page.locator('[data-testid^="prio-row-"]')).toHaveCount(2);
  await expect(async () => {
    const d = await fetchDictionaries(page, projectId);
    expect(d.priorities.map((p) => p.name)).toContain('Пожелание');
  }).toPass();
  const dict = await fetchDictionaries(page, projectId);
  const p2 = dict.priorities.find((p) => p.name === 'Пожелание')!;

  await page.getByTestId('sidebar-nav-requirements').click();
  await expect(page.getByTestId('main-page')).toBeVisible();

  // Планируемое требование с releaseDate → в колонке срока «квартал/год» + «выпуск …».
  const planned = uniqueName('req-term');
  await addRequirement(page, {
    kind: 'function',
    name: planned,
    criticality: 'HIGH',
    implemented: false,
    quarter: 'Q3',
    year: 2026,
  });
  await openPriorityTab(page, planned);
  await page.getByTestId('po-release-date').fill('2026-09-20');
  await expect(page.getByTestId('po-release-warning')).toBeHidden();
  await saveRequirementModal(page);

  // Реализованное требование → «Реализовано».
  const done = uniqueName('req-realized');
  await addRequirement(page, {
    kind: 'function',
    name: done,
    criticality: 'MEDIUM',
    implemented: true,
  });

  // Требование с двумя источниками, каждый со своим приоритетом.
  const twoSrc = uniqueName('req-2groups');
  const srcA = uniqueName('Клиент-А');
  const srcB = uniqueName('Регулятор-Б');
  await addRequirement(page, { kind: 'function', name: twoSrc, criticality: 'HIGH' });
  await openPriorityTab(page, twoSrc);
  await addSourceCard(page, 0, { type: 'CLIENT', name: srcA }); // default priority
  await addSourceCard(page, 1, { type: 'STANDARD', name: srcB, priorityId: p2.id });
  await saveRequirementModal(page);

  // Slug фиксируем в режиме дерева — в срезе строк tr[data-req-name] уже нет.
  const reqSlug = await slugOf(page, twoSrc);

  // Колонка срока — двухуровневая.
  const plannedTerm = rowByName(page, planned).getByTestId('req-term-cell');
  await expect(plannedTerm).toContainText('Q3 2026');
  await expect(plannedTerm).toContainText('выпуск 2026-09-20');
  await expect(rowByName(page, done).getByTestId('req-term-cell')).toContainText('Реализовано');

  // Срез «По источникам»: требование с 2 источниками — в 2 группах, каждая со своим приоритетом.
  await page.getByTestId('main-view-sources').click();
  await expect(page.getByTestId('source-slice')).toBeVisible();

  const groupA = page.getByTestId(`slice-group-${srcA}`);
  const groupB = page.getByTestId(`slice-group-${srcB}`);
  await expect(groupA).toBeVisible();
  await expect(groupB).toBeVisible();

  await expect(page.getByTestId(`slice-item-${srcA}-${reqSlug}`)).toBeVisible();
  await expect(page.getByTestId(`slice-item-${srcB}-${reqSlug}`)).toBeVisible();

  // Приоритет источника A = дефолт «Квартальная цель»; источника B = «Пожелание».
  await expect(page.getByTestId(`slice-item-prio-${srcA}-${reqSlug}`)).toHaveText(
    /Квартальная цель/,
  );
  await expect(page.getByTestId(`slice-item-prio-${srcB}-${reqSlug}`)).toHaveText(/Пожелание/);
});
