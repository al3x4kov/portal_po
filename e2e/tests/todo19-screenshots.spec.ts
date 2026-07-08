import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { addRequirement, createProject, rowByName, uniqueName } from './helpers/app.js';
import {
  addSourceCard,
  gotoDictionaries,
  openPriorityTab,
  saveRequirementModal,
} from './helpers/todo19.js';

/**
 * Волна 3 · T-307 (todo_19): обновление эталонных документационных скриншотов
 * под look-n-feel и новые поверхности todo_19.
 *
 * В проекте нет baseline-снапшотов Playwright (нет `toHaveScreenshot` / каталогов
 * `*-snapshots`); «эталонные скриншоты» здесь — это документационные PNG в
 * `e2e/screenshots/`, которые пишут ai-hub/export-спеки. Этот спек добавляет/
 * обновляет reference-изображения ЛЕГИТИМНО изменившихся поверхностей:
 *   • справочники проекта (новый пункт меню);
 *   • шапка вкладок модалки требования + вкладка «Приоритизация» (источники/RICE);
 *   • дерево с новыми колонками (RICE, источники, двухуровневый срок);
 *   • срез «По источникам».
 * Снимки не сравниваются попиксельно — они не маскируют регрессы; поведенческие
 * проверки остаются в T-301…T-306.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

const RICE = { reach: '4', impact: '3', confidence: '0.8', effort: '3' };

test('T-307 · обновление эталонных скриншотов новых поверхностей todo_19', async ({ page }) => {
  await createProject(page, uniqueName('proj-shots'));

  // Наполняем проект, чтобы снимки были содержательными.
  const reqA = uniqueName('Экспорт-в-XLSX');
  const reqB = uniqueName('Импорт-архива');
  await addRequirement(page, {
    kind: 'function',
    name: reqA,
    criticality: 'HIGH',
    implemented: false,
    quarter: 'Q3',
    year: 2026,
  });
  await addRequirement(page, {
    kind: 'function',
    name: reqB,
    criticality: 'MEDIUM',
    implemented: true,
  });

  // reqA: два источника с RICE → богатая вкладка «Приоритизация».
  await openPriorityTab(page, reqA);
  await addSourceCard(page, 0, { type: 'CLIENT', name: uniqueName('Клиент'), rice: RICE });
  await addSourceCard(page, 1, { type: 'STANDARD', name: uniqueName('ГОСТ') });
  await page.getByTestId('po-release-date').fill('2026-09-20');
  // Снимок вкладки «Приоритизация» (источники, RICE, агрегат, решение PO).
  await expect(page.getByTestId('req-priority-tab')).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'todo19-req-priority-tab.png'),
    fullPage: true,
  });

  // Снимок шапки вкладок модалки (вкладка «Основное»).
  await page.getByTestId('req-tab-main').click();
  await expect(page.getByTestId('req-name')).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'todo19-req-modal-tabs.png'),
    fullPage: true,
  });
  await saveRequirementModal(page);

  // Снимок дерева с новыми колонками (RICE, источники, двухуровневый срок).
  await expect(rowByName(page, reqA).getByTestId('req-rice-cell')).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'todo19-tree-columns.png'),
    fullPage: true,
  });

  // Снимок среза «По источникам».
  await page.getByTestId('main-view-sources').click();
  await expect(page.getByTestId('source-slice')).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'todo19-source-slice.png'),
    fullPage: true,
  });

  // Снимок экрана «Справочники проекта».
  await gotoDictionaries(page);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'todo19-dictionaries.png'),
    fullPage: true,
  });
});
