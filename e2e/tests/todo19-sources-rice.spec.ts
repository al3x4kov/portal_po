import { expect, test } from '@playwright/test';
import {
  addRequirement,
  createProject,
  projectIdFromUrl,
  rowByName,
  uniqueName,
} from './helpers/app.js';
import { addSourceCard, openPriorityTab, saveRequirementModal } from './helpers/todo19.js';

/**
 * Волна 3 · T-301 / T-302 (todo_19): множественные источники требования и
 * RICE-скоринг на источник.
 *   T-301 — 2 источника с типом/именем/приоритетом/RICE → сохранить → переоткрыть
 *           (lossless round-trip, все поля на месте).
 *   T-302 — score источника = 3.2 (инвариант reach4·impact3·conf0.8·effort3);
 *           агрегат требования = max по источникам; колонка «RICE» дерева
 *           показывает агрегат; сортировка по RICE упорядочивает, «—» в конец.
 *
 * Изоляция: свежий проект + уникальные имена на каждый тест (серийный прогон).
 */

// RICE-инвариант из макета: reach 4 · impact 3 · confidence 0.8 · effort 3 → 3.2.
const RICE_32 = { reach: '4', impact: '3', confidence: '0.8', effort: '3' };
// reach 5 · impact 2 · confidence 1 · effort 2 → 5.0.
const RICE_50 = { reach: '5', impact: '2', confidence: '1', effort: '2' };
// reach 2 · impact 1 · confidence 0.8 · effort 2 → 0.8.
const RICE_08 = { reach: '2', impact: '1', confidence: '0.8', effort: '2' };

test('T-301 · два источника с полями сохраняются и переоткрываются без потерь', async ({
  page,
}) => {
  await createProject(page, uniqueName('proj-t301'));
  const req = uniqueName('req-2src');
  await addRequirement(page, { kind: 'function', name: req, criticality: 'HIGH' });

  const src1 = uniqueName('Клиент');
  const src2 = uniqueName('Регулятор');

  await openPriorityTab(page, req);
  await addSourceCard(page, 0, { type: 'CLIENT', name: src1, rice: RICE_32 });
  await addSourceCard(page, 1, { type: 'STANDARD', name: src2, rice: RICE_50 });

  // Live score/aggregate visible before save.
  await expect(page.getByTestId('src-score-0')).toHaveText('3.2');
  await expect(page.getByTestId('src-score-1')).toHaveText('5.0');
  await expect(page.getByTestId('req-aggregate-rice')).toHaveText('5.0');

  await saveRequirementModal(page);

  // Reopen → both cards restored with every field intact (round-trip).
  await openPriorityTab(page, req);
  await expect(page.getByTestId('src-card-0')).toBeVisible();
  await expect(page.getByTestId('src-card-1')).toBeVisible();

  await expect(page.getByTestId('src-name-0-input')).toHaveValue(src1);
  await expect(page.getByTestId('src-type-0')).toHaveValue('CLIENT');
  await expect(page.getByTestId('src-priority-0')).toHaveValue('default');
  await expect(page.getByTestId('src-rice-reach-0')).toHaveValue('4');
  await expect(page.getByTestId('src-rice-impact-0')).toHaveValue('3');
  await expect(page.getByTestId('src-rice-confidence-0')).toHaveValue('0.8');
  await expect(page.getByTestId('src-rice-effort-0')).toHaveValue('3');
  await expect(page.getByTestId('src-score-0')).toHaveText('3.2');

  await expect(page.getByTestId('src-name-1-input')).toHaveValue(src2);
  await expect(page.getByTestId('src-type-1')).toHaveValue('STANDARD');
  await expect(page.getByTestId('src-rice-reach-1')).toHaveValue('5');
  await expect(page.getByTestId('src-score-1')).toHaveText('5.0');

  await expect(page.getByTestId('req-aggregate-rice')).toHaveText('5.0');
});

test('T-302 · RICE: score, агрегат=max, колонка дерева и сортировка', async ({ page }) => {
  await createProject(page, uniqueName('proj-t302'));
  const projectId = projectIdFromUrl(page);

  const reqHigh = uniqueName('req-high');
  const reqMid = uniqueName('req-mid');
  const reqNone = uniqueName('req-none');

  await addRequirement(page, { kind: 'function', name: reqHigh, criticality: 'MEDIUM' });
  await addRequirement(page, { kind: 'function', name: reqMid, criticality: 'MEDIUM' });
  await addRequirement(page, { kind: 'function', name: reqNone, criticality: 'MEDIUM' });

  // reqHigh: single source, score 5.0.
  await openPriorityTab(page, reqHigh);
  await addSourceCard(page, 0, { type: 'CLIENT', name: uniqueName('Alpha'), rice: RICE_50 });
  await expect(page.getByTestId('src-score-0')).toHaveText('5.0');
  await expect(page.getByTestId('req-aggregate-rice')).toHaveText('5.0');
  await saveRequirementModal(page);

  // reqMid: two sources 3.2 and 0.8 → aggregate is the MAX (3.2).
  await openPriorityTab(page, reqMid);
  await addSourceCard(page, 0, { type: 'CLIENT', name: uniqueName('Beta'), rice: RICE_32 });
  await addSourceCard(page, 1, { type: 'STAKEHOLDER', name: uniqueName('Gamma'), rice: RICE_08 });
  await expect(page.getByTestId('src-score-0')).toHaveText('3.2');
  await expect(page.getByTestId('src-score-1')).toHaveText('0.8');
  await expect(page.getByTestId('req-aggregate-rice')).toHaveText('3.2');
  await saveRequirementModal(page);

  // Tree RICE cell reflects the aggregate; reqNone has no estimate («—»).
  await expect(rowByName(page, reqHigh).getByTestId('req-rice-cell')).toHaveAttribute(
    'data-rice',
    '5',
  );
  await expect(rowByName(page, reqMid).getByTestId('req-rice-cell')).toHaveAttribute(
    'data-rice',
    '3.2',
  );
  await expect(rowByName(page, reqNone).getByTestId('req-rice-cell')).toHaveAttribute(
    'data-rice',
    '',
  );

  // Sort by RICE descending: 5.0, 3.2, then «—» (undefined) sinks to the end.
  const sortHeader = page.getByTestId('sort-rice-function');
  await sortHeader.click();
  await expect(sortHeader).toHaveAttribute('data-sort', 'desc');

  const order = await page
    .locator('[data-testid="table-function"] tr[data-req-name]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-req-name')));
  expect(order.indexOf(reqHigh)).toBeLessThan(order.indexOf(reqMid));
  expect(order.indexOf(reqMid)).toBeLessThan(order.indexOf(reqNone));
  // «—» row is last.
  expect(order[order.length - 1]).toBe(reqNone);

  expect(projectId).toBeTruthy();
});
