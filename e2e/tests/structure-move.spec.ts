import { expect, test } from '@playwright/test';
import {
  addRequirement,
  createProject,
  linkRequirements,
  rowByName,
  uniqueName,
} from './helpers/app.js';

/**
 * Режим структуры: перемещение строки по дереву против ЖИВОГО сервера.
 * Проверяется главное обещание — меняется одна связь «родитель — ребёнок», и
 * результат виден в дереве после перечитывания требований с диска.
 */
test('режим структуры переносит строку в соседнюю ветку и отменяет перенос', async ({ page }) => {
  const project = uniqueName('move');
  const feed = uniqueName('Лента');
  const infinite = uniqueName('Прокрутка');
  const dm = uniqueName('Сообщения');

  await createProject(page, project);
  await addRequirement(page, { kind: 'function', name: feed, criticality: 'HIGH' });
  await addRequirement(page, { kind: 'function', name: infinite, criticality: 'LOW' });
  await addRequirement(page, { kind: 'function', name: dm, criticality: 'MEDIUM' });
  // Прокрутка — ребёнок Ленты.
  await linkRequirements(page, infinite, 'CHILD_OF', feed);

  // Режим структуры включается тумблером; в обычном режиме ручек нет.
  await expect(rowByName(page, infinite).getByTestId('move-grip')).toHaveCount(0);
  await page.getByTestId('toggle-structure-mode').click();
  await expect(page.getByTestId('structure-bar')).toBeVisible();

  // Выбираем строку и переносим её стрелкой в следующий раздел.
  await rowByName(page, infinite).getByTestId('move-grip').click();
  await expect(page.getByTestId('structure-current-parent')).toHaveText(feed);

  const down = page.getByTestId('move-op-down');
  await expect(down).toBeVisible();
  await down.click();

  // Дерево перечитано с диска: новый родитель виден в панели.
  await expect(page.getByTestId('structure-current-parent')).toHaveText(dm, { timeout: 10_000 });

  // Отмена возвращает строку прежнему родителю.
  await page.getByTestId('structure-undo').click();
  await expect(page.getByTestId('structure-current-parent')).toHaveText(feed, { timeout: 10_000 });
});

test('запрет виден до отпускания: строку нельзя вложить в собственного потомка', async ({
  page,
}) => {
  const project = uniqueName('deny');
  const parent = uniqueName('Раздел');
  const child = uniqueName('Дочерняя');

  await createProject(page, project);
  await addRequirement(page, { kind: 'function', name: parent, criticality: 'HIGH' });
  await addRequirement(page, { kind: 'function', name: child, criticality: 'LOW' });
  await linkRequirements(page, child, 'CHILD_OF', parent);

  await page.getByTestId('toggle-structure-mode').click();
  await rowByName(page, parent).getByTestId('move-grip').click();

  // «Вложить в строку выше» недоступно: выше нет строки того же уровня, и
  // причина названа словами, а не молчаливым гашением.
  const indent = page.getByTestId('move-op-indent');
  await expect(indent).toHaveAttribute('data-blocked', 'true');
  await expect(indent).toHaveAttribute('aria-label', /Недоступно/);
});
