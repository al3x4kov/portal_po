import { expect, test, type Page } from '@playwright/test';
import {
  addRequirement,
  createProject,
  linkRequirements,
  rowByName,
  uniqueName,
} from './helpers/app.js';

/**
 * UX-2 · Каскадное удаление требования с усиленным подтверждением.
 *
 * Прежнее поведение (UX-3): удаление узла с детьми было ЗАПРЕЩЕНО (кнопка
 * disabled). Теперь узел с детьми удаляется каскадом (узел + все потомки) через
 * type-to-confirm — ввод точного имени требования. Лист удаляется обычным
 * подтверждением, без поля ввода.
 *
 * Контракт data-testid от фронтенда:
 * - `delete-btn-{slug}` — кнопка удаления в строке (активна и для родителей);
 * - `delete-dialog` — модалка; `delete-dialog-cascade` — блок с числом (ТОЛЬКО
 *   в каскадном варианте); `delete-dialog-input` — поле ввода имени (только
 *   каскад); `delete-dialog-confirm` — «Удалить N требования» (disabled, пока
 *   имя не введено точно); `delete-dialog-cancel`;
 * - `toast` — «Удалено N требований».
 *
 * Изоляция общего PROJECTS_ROOT — уникальные имена проекта/требований на тест.
 */

/** Открыть диалог удаления по имени строки (кнопка активна для листа и родителя). */
async function openDeleteDialog(page: Page, name: string): Promise<void> {
  const row = rowByName(page, name);
  await row.hover();
  await row.locator('[data-testid^="delete-btn-"]').click();
  await expect(page.getByTestId('delete-dialog')).toBeVisible();
}

test.describe('UX-2 · каскадное удаление', () => {
  test('лист: обычное подтверждение без поля ввода, тост «Удалено 1 требование»', async ({
    page,
  }) => {
    const project = uniqueName('cascade-leaf');
    const leaf = uniqueName('Leaf');

    await createProject(page, project);
    await addRequirement(page, { kind: 'function', name: leaf, criticality: 'MEDIUM' });
    await expect(rowByName(page, leaf)).toBeVisible();

    await openDeleteDialog(page, leaf);

    // Лист: каскадного блока и поля ввода имени нет — обычное подтверждение.
    await expect(page.getByTestId('delete-dialog-cascade')).toHaveCount(0);
    await expect(page.getByTestId('delete-dialog-input')).toHaveCount(0);

    // Confirm активен сразу (нет type-to-confirm).
    const confirm = page.getByTestId('delete-dialog-confirm');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    // Плюрализация: ровно одно требование → «Удалено 1 требование».
    await expect(
      page.getByTestId('toast').filter({ hasText: 'Удалено 1 требование' }),
    ).toBeVisible();

    await expect(page.getByTestId('delete-dialog')).toBeHidden();
    await expect(rowByName(page, leaf)).toBeHidden();
  });

  test('каскад: type-to-confirm удаляет родителя и всех потомков, соседи целы', async ({
    page,
  }) => {
    const project = uniqueName('cascade-tree');
    const parent = uniqueName('Parent');
    const child = uniqueName('Child');
    const grandchild = uniqueName('Grandchild');
    const bystander = uniqueName('Bystander');

    await createProject(page, project);

    // Дерево из 2 уровней потомков: parent → child → grandchild.
    await addRequirement(page, { kind: 'function', name: parent, criticality: 'HIGH' });
    await addRequirement(page, { kind: 'function', name: child, criticality: 'MEDIUM' });
    await addRequirement(page, { kind: 'function', name: grandchild, criticality: 'LOW' });
    // Независимое требование — должно уцелеть после каскада.
    await addRequirement(page, { kind: 'function', name: bystander, criticality: 'MEDIUM' });

    await linkRequirements(page, child, 'CHILD_OF', parent);
    await linkRequirements(page, grandchild, 'CHILD_OF', child);

    // Дефолтный режим «Раскрыть все» — потомки видны без ручного раскрытия.
    await expect(rowByName(page, child)).toBeVisible();
    await expect(rowByName(page, grandchild)).toBeVisible();

    await openDeleteDialog(page, parent);

    // Каскадный вариант: присутствует блок с числом потомков (N = 2).
    const cascade = page.getByTestId('delete-dialog-cascade');
    await expect(cascade).toBeVisible();
    await expect(cascade).toContainText('2 требования');

    // Confirm-кнопка отражает полное число удаляемых (родитель + 2 потомка = 3).
    const confirm = page.getByTestId('delete-dialog-confirm');
    await expect(confirm).toHaveText(/Удалить\s+3\s+требования/);

    const input = page.getByTestId('delete-dialog-input');
    await expect(input).toBeVisible();

    // Пока имя не введено — подтверждение заблокировано.
    await expect(confirm).toBeDisabled();

    // Неверное имя — всё ещё заблокировано.
    await input.fill(`${parent}-неверно`);
    await expect(confirm).toBeDisabled();

    // Точное имя родителя — подтверждение активируется.
    await input.fill(parent);
    await expect(confirm).toBeEnabled();

    await confirm.click();

    // Реальное число удалённых приходит с сервера: 3.
    await expect(
      page.getByTestId('toast').filter({ hasText: 'Удалено 3 требования' }),
    ).toBeVisible();

    await expect(page.getByTestId('delete-dialog')).toBeHidden();

    // Родитель и ВСЕ потомки исчезли из дерева.
    await expect(rowByName(page, parent)).toBeHidden();
    await expect(rowByName(page, child)).toBeHidden();
    await expect(rowByName(page, grandchild)).toBeHidden();

    // Независимое требование не тронуто.
    await expect(rowByName(page, bystander)).toBeVisible();
  });

  test('отмена: кнопкой «Отменить» и Escape — ничего не удалено', async ({ page }) => {
    const project = uniqueName('cascade-cancel');
    const parent = uniqueName('Parent');
    const child = uniqueName('Child');

    await createProject(page, project);
    await addRequirement(page, { kind: 'function', name: parent, criticality: 'HIGH' });
    await addRequirement(page, { kind: 'function', name: child, criticality: 'MEDIUM' });
    await linkRequirements(page, child, 'CHILD_OF', parent);
    await expect(rowByName(page, child)).toBeVisible();

    // 1) Отмена кнопкой «Отменить».
    await openDeleteDialog(page, parent);
    await expect(page.getByTestId('delete-dialog-cascade')).toBeVisible();
    await page.getByTestId('delete-dialog-cancel').click();
    await expect(page.getByTestId('delete-dialog')).toBeHidden();
    await expect(rowByName(page, parent)).toBeVisible();
    await expect(rowByName(page, child)).toBeVisible();

    // 2) Отмена клавишей Escape.
    await openDeleteDialog(page, parent);
    await expect(page.getByTestId('delete-dialog-cascade')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('delete-dialog')).toBeHidden();

    // Ни одно требование не удалено.
    await expect(rowByName(page, parent)).toBeVisible();
    await expect(rowByName(page, child)).toBeVisible();
  });
});
