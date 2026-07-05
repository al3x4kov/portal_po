import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  apiCreateRequirement,
  createProject,
  projectIdFromUrl,
  uniqueName,
} from './helpers/app.js';

/**
 * Task 1 — Именованные группы фильтров + кейс-инсенситивный «Источник»
 * в общем компоненте RequirementPickerModal (два экрана):
 *   A) «Выбор требований для экспорта»  (Sidebar → Экспорт → ExportModal)
 *   B) «Выбор ФТ/НФТ для TaskTracker»   (Sidebar → Задачи → tracker)
 *
 * Контракт селекторов: export-filter-zone, export-filter-crit-*, export-filter-impl-*,
 * export-filter-src-*, export-toggle-all, export-item-<slug>, export-next.
 * Именованные группы: role="group" + aria-label = Критичность | Реализация | Источник | Выбор.
 */

interface Seed {
  name: string;
  kind: 'function' | 'nfr';
  criticality?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  implemented?: boolean;
  source?: string;
  quarter?: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  year?: number;
}

/** Create a project, seed requirements via API, then reload so the SPA refetches. */
async function setupProject(page: Page, prefix: string, seeds: Seed[]): Promise<string> {
  await createProject(page, uniqueName(prefix));
  const projectId = projectIdFromUrl(page);
  for (const s of seeds) {
    await apiCreateRequirement(page, projectId, {
      kind: s.kind,
      name: s.name,
      criticality: s.criticality,
      implemented: s.implemented,
      source: s.source,
      quarter: s.quarter,
      year: s.year,
    });
  }
  await page.reload();
  await expect(page.getByTestId('main-page')).toBeVisible();
  return projectId;
}

/** A visible requirement row in the picker list, matched by its (unique) name. */
function itemByName(modal: Locator, name: string): Locator {
  return modal.locator('[data-testid^="export-item-"]').filter({ hasText: name });
}

/** Open the Export picker modal (screen A). */
async function openExportPicker(page: Page): Promise<Locator> {
  await page.getByTestId('sidebar-open-export').click();
  const modal = page.getByTestId('export-modal');
  await expect(modal).toBeVisible();
  return modal;
}

/** Open the TaskTracker picker modal (screen B). */
async function openTrackerPicker(page: Page): Promise<Locator> {
  await page.getByTestId('sidebar-open-tasks').click();
  await expect(page.getByTestId('export-tasks-modal')).toBeVisible();
  await page.getByTestId('export-tasks-dir-tracker').click();
  const modal = page.getByTestId('tracker-select-modal');
  await expect(modal).toBeVisible();
  return modal;
}

// ── Screen A: Export ───────────────────────────────────────────────────────

test.describe('Task 1 · Экран «Выбор требований для экспорта»', () => {
  test('фильтры разбиты на именованные группы (role=group + aria-label)', async ({ page }) => {
    await setupProject(page, 'exp-groups', [
      { name: uniqueName('F'), kind: 'function', criticality: 'HIGH', source: 'АС21' },
      { name: uniqueName('F'), kind: 'function', criticality: 'LOW', source: 'Excel' },
    ]);
    const modal = await openExportPicker(page);

    await expect(modal.getByTestId('export-filter-zone')).toBeVisible();
    for (const label of ['Критичность', 'Реализация', 'Источник', 'Выбор']) {
      await expect(modal.getByRole('group', { name: label })).toBeVisible();
    }
  });

  test('«Источник» группирует кейс-инсенситивно и фильтр ловит оба написания', async ({ page }) => {
    const as21Upper = uniqueName('F-upper');
    const as21Lower = uniqueName('F-lower');
    const excel = uniqueName('F-excel');
    await setupProject(page, 'exp-src', [
      // АС21 создаётся первым → канонический ярлык = «АС21».
      { name: as21Upper, kind: 'function', criticality: 'HIGH', source: 'АС21' },
      { name: as21Lower, kind: 'function', criticality: 'MEDIUM', source: 'ас21' },
      { name: excel, kind: 'function', criticality: 'LOW', source: 'Excel' },
    ]);
    const modal = await openExportPicker(page);

    // Ровно ДВА чипа источника: один объединяет АС21+ас21 (регистронезависимо)
    // и один «Excel». Канонический регистр ярлыка зависит от порядка, поэтому
    // сверяем регистронезависимо — важно, что чип РОВНО ОДИН на оба написания.
    const sourceGroup = modal.getByRole('group', { name: 'Источник' });
    await expect(sourceGroup.getByRole('button')).toHaveCount(2);
    const as21Chip = sourceGroup.getByRole('button', { name: /^ас21$/i });
    await expect(as21Chip).toHaveCount(1);
    await expect(sourceGroup.getByRole('button', { name: /^excel$/i })).toHaveCount(1);

    // Фильтр по единственному чипу «АС21» ловит оба написания, «Excel» скрывается.
    await as21Chip.click();
    await expect(itemByName(modal, as21Upper)).toBeVisible();
    await expect(itemByName(modal, as21Lower)).toBeVisible();
    await expect(itemByName(modal, excel)).toHaveCount(0);

    // Снятие фильтра возвращает всё.
    await as21Chip.click();
    await expect(itemByName(modal, excel)).toBeVisible();
  });

  test('группа «Источник» скрыта при менее чем двух источниках', async ({ page }) => {
    await setupProject(page, 'exp-onesrc', [
      { name: uniqueName('F'), kind: 'function', source: 'АС21' },
      { name: uniqueName('F'), kind: 'function', source: 'ас21' }, // тот же нормализованный
    ]);
    const modal = await openExportPicker(page);
    await expect(modal.getByRole('group', { name: 'Критичность' })).toBeVisible();
    await expect(modal.getByRole('group', { name: 'Источник' })).toHaveCount(0);
  });

  test('регресс: фильтр по критичности', async ({ page }) => {
    const high = uniqueName('F-high');
    const low = uniqueName('F-low');
    await setupProject(page, 'exp-crit', [
      { name: high, kind: 'function', criticality: 'HIGH' },
      { name: low, kind: 'function', criticality: 'LOW' },
    ]);
    const modal = await openExportPicker(page);

    await modal.getByTestId('export-filter-crit-HIGH').click();
    await expect(itemByName(modal, high)).toBeVisible();
    await expect(itemByName(modal, low)).toHaveCount(0);

    await modal.getByTestId('export-filter-crit-HIGH').click();
    await expect(itemByName(modal, low)).toBeVisible();
  });

  test('регресс: фильтр по реализации (Все/Реализовано/Запланировано)', async ({ page }) => {
    const done = uniqueName('F-done');
    const planned = uniqueName('F-planned');
    await setupProject(page, 'exp-impl', [
      { name: done, kind: 'function', implemented: true },
      { name: planned, kind: 'function', implemented: false, quarter: 'Q2', year: 2027 },
    ]);
    const modal = await openExportPicker(page);

    await modal.getByTestId('export-filter-impl-done').click();
    await expect(itemByName(modal, done)).toBeVisible();
    await expect(itemByName(modal, planned)).toHaveCount(0);

    await modal.getByTestId('export-filter-impl-planned').click();
    await expect(itemByName(modal, planned)).toBeVisible();
    await expect(itemByName(modal, done)).toHaveCount(0);
    // Чипы кварталов появляются в группе «Реализация».
    await expect(modal.getByTestId('export-filter-q-Q2-2027')).toBeVisible();

    await modal.getByTestId('export-filter-impl-all').click();
    await expect(itemByName(modal, done)).toBeVisible();
    await expect(itemByName(modal, planned)).toBeVisible();
  });

  test('регресс: «Выбрать все»/«Снять выделение», счётчик и кнопка «Далее»', async ({ page }) => {
    await setupProject(page, 'exp-sel', [
      { name: uniqueName('F'), kind: 'function' },
      { name: uniqueName('F'), kind: 'function' },
      { name: uniqueName('N'), kind: 'nfr' },
    ]);
    const modal = await openExportPicker(page);

    // T4 (todo_17): две отдельные кнопки «Выбрать все» / «Снять выделение»
    // и счётчик «Выбрано N» (picker-counter).
    const selectionGroup = modal.getByRole('group', { name: 'Выбор' });
    const selectAll = modal.getByTestId('export-toggle-all');
    const deselectAll = modal.getByTestId('export-untoggle-all');
    const next = modal.getByTestId('export-next');

    // Изначально всё выбрано (3), «Далее» активна, «Выбрать все» уже не нужна.
    await expect(selectionGroup).toContainText('Выбрано 3');
    await expect(next).toBeEnabled();
    await expect(selectAll).toBeDisabled();
    await expect(deselectAll).toBeEnabled();

    // Снять выделение → 0, кнопка выключена, подсказка видна.
    await deselectAll.click();
    await expect(selectionGroup).toContainText('Выбрано 0');
    await expect(next).toBeDisabled();
    await expect(modal.getByTestId('export-next-hint')).toBeVisible();
    await expect(deselectAll).toBeDisabled();

    // Выбрать все → снова 3, кнопка активна.
    await selectAll.click();
    await expect(selectionGroup).toContainText('Выбрано 3');
    await expect(next).toBeEnabled();
  });
});

// ── Screen B: TaskTracker ────────────────────────────────────────────────────

test.describe('Task 1 · Экран «Выбор ФТ/НФТ для TaskTracker»', () => {
  test('те же именованные группы фильтров', async ({ page }) => {
    await setupProject(page, 'trk-groups', [
      { name: uniqueName('F'), kind: 'function', criticality: 'HIGH', source: 'АС21' },
      { name: uniqueName('F'), kind: 'function', criticality: 'LOW', source: 'Excel' },
    ]);
    const modal = await openTrackerPicker(page);

    await expect(modal.getByTestId('export-filter-zone')).toBeVisible();
    for (const label of ['Критичность', 'Реализация', 'Источник', 'Выбор']) {
      await expect(modal.getByRole('group', { name: label })).toBeVisible();
    }
  });

  test('кейс-инсенситивный «Источник» и фильтр ловит оба написания', async ({ page }) => {
    const as21Upper = uniqueName('F-upper');
    const as21Lower = uniqueName('F-lower');
    const excel = uniqueName('F-excel');
    await setupProject(page, 'trk-src', [
      { name: as21Upper, kind: 'function', source: 'АС21' },
      { name: as21Lower, kind: 'function', source: 'ас21' },
      { name: excel, kind: 'function', source: 'Excel' },
    ]);
    const modal = await openTrackerPicker(page);

    const sourceGroup = modal.getByRole('group', { name: 'Источник' });
    await expect(sourceGroup.getByRole('button')).toHaveCount(2);
    const as21Chip = sourceGroup.getByRole('button', { name: /^ас21$/i });
    await expect(as21Chip).toHaveCount(1);

    await as21Chip.click();
    await expect(itemByName(modal, as21Upper)).toBeVisible();
    await expect(itemByName(modal, as21Lower)).toBeVisible();
    await expect(itemByName(modal, excel)).toHaveCount(0);
  });

  test('регресс: «Выбрать все»/счётчик и кнопка «Предпросмотр»', async ({ page }) => {
    await setupProject(page, 'trk-sel', [
      { name: uniqueName('F'), kind: 'function' },
      { name: uniqueName('N'), kind: 'nfr' },
    ]);
    const modal = await openTrackerPicker(page);

    const selectionGroup = modal.getByRole('group', { name: 'Выбор' });
    const next = modal.getByTestId('export-next');

    // Подпись подтверждения на этом экране — «Предпросмотр».
    await expect(next).toContainText('Предпросмотр');
    await expect(selectionGroup).toContainText('Выбрано 2');
    await expect(next).toBeEnabled();

    // T4 (todo_17): снятие выделения — отдельной кнопкой export-untoggle-all.
    await modal.getByTestId('export-untoggle-all').click();
    await expect(selectionGroup).toContainText('Выбрано 0');
    await expect(next).toBeDisabled();
  });
});
