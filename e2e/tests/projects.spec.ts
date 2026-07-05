import { expect, test, type Page } from '@playwright/test';
import { createProject, uniqueName } from './helpers/app.js';

/**
 * T-305 · Projects: create & open (FR-1, FR-2, FR-4, FR-5).
 * todo_16 B1 · удаление проекта со страницы «Открыть существующий».
 * todo_16 A1 · длинный путь проекта: truncate + title, без слома сетки.
 */
test.describe('T-305 projects', () => {
  test('start → new project → main screen shows Main Path', async ({ page }) => {
    const name = uniqueName('proj-create');

    await page.goto('/');
    await expect(page.getByTestId('start-page')).toBeVisible();
    await page.getByTestId('start-new').click();

    await page.getByTestId('newproject-name').fill(name);
    await page.getByTestId('newproject-submit').click();

    // Success notification carries the created Main Path (FR-2.4).
    await expect(page.getByTestId('newproject-success')).toBeVisible();
    const mainPath = await page.getByTestId('newproject-mainpath').innerText();
    expect(mainPath).toContain(name);

    await page.getByTestId('newproject-open').click();
    await expect(page.getByTestId('main-page')).toBeVisible();
    // Main Path is always visible on top of the main screen (FR-5.1).
    await expect(page.getByTestId('main-path')).toContainText(name);
    // Both requirement sections are present (FR-5.2 / FR-6.1).
    await expect(page.getByTestId('section-function')).toBeVisible();
    await expect(page.getByTestId('section-nfr')).toBeVisible();
  });

  test('open an existing project from the list', async ({ page }) => {
    const name = uniqueName('proj-open');
    await createProject(page, name);

    await page.goto('/');
    await page.getByTestId('start-open').click();
    const list = page.getByTestId('open-list');
    await expect(list).toBeVisible();

    await list.getByText(name, { exact: true }).click();
    await expect(page.getByTestId('main-page')).toBeVisible();
    await expect(page.getByTestId('main-path')).toContainText(name);
  });
});

/** Project summary as served by `GET /api/projects` (id keys the testids). */
interface ProjectSummary {
  id: string;
  name: string;
  mainPath: string;
}

/** Resolve a project's id + mainPath by its (unique) name via the API. */
async function projectByName(page: Page, name: string): Promise<ProjectSummary> {
  const res = await page.request.get('/api/projects');
  if (!res.ok()) throw new Error(`GET /api/projects failed (${res.status()})`);
  const projects = (await res.json()) as ProjectSummary[];
  const found = projects.find((p) => p.name === name);
  if (!found) throw new Error(`project "${name}" not found in GET /api/projects`);
  return found;
}

/** Navigate to the «Открыть существующий» list from the start screen. */
async function gotoOpenList(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('start-open').click();
  await expect(page.getByTestId('open-list')).toBeVisible();
}

test.describe('todo_16 B1 · удаление проекта из списка «Открыть существующий»', () => {
  test('отмена в диалоге ничего не удаляет; проект остаётся в списке', async ({ page }) => {
    const name = uniqueName('proj-del-cancel');
    await createProject(page, name);
    const { id } = await projectByName(page, name);

    await gotoOpenList(page);
    const row = page.getByTestId(`open-project-${id}`);
    await expect(row).toBeVisible();

    await page.getByTestId(`project-delete-${id}`).click();
    const dialog = page.getByTestId('project-delete-dialog');
    await expect(dialog).toBeVisible();
    // Текст предупреждения содержит имя проекта и необратимость (spec B1).
    await expect(page.getByTestId('project-delete-dialog-message')).toContainText(name);
    await expect(page.getByTestId('project-delete-dialog-message')).toContainText('необратимо');

    await page.getByTestId('project-delete-dialog-cancel').click();
    await expect(dialog).toHaveCount(0);

    // Строка на месте, каталог на диске цел (API-истина).
    await expect(row).toBeVisible();
    const still = await projectByName(page, name);
    expect(still.id).toBe(id);
  });

  test('подтверждение удаляет проект: строка исчезает без перезагрузки, toast успеха', async ({
    page,
  }) => {
    // Второй проект — контроль, что удаление затрагивает только свою строку.
    const nameKeep = uniqueName('proj-del-keep');
    const nameGone = uniqueName('proj-del-go');
    await createProject(page, nameKeep);
    await createProject(page, nameGone);
    const keep = await projectByName(page, nameKeep);
    const gone = await projectByName(page, nameGone);

    await gotoOpenList(page);
    await expect(page.getByTestId(`open-project-${gone.id}`)).toBeVisible();

    // Маркер на window: переживёт удаление только без full-page reload.
    await page.evaluate(() => {
      (window as unknown as { __e2eNoReload: number }).__e2eNoReload = 1;
    });

    await page.getByTestId(`project-delete-${gone.id}`).click();
    await expect(page.getByTestId('project-delete-dialog')).toBeVisible();
    await page.getByTestId('project-delete-dialog-confirm').click();

    // Строка исчезла, диалог закрыт, соседний проект остался.
    await expect(page.getByTestId(`open-project-${gone.id}`)).toHaveCount(0);
    await expect(page.getByTestId('project-delete-dialog')).toHaveCount(0);
    await expect(page.getByTestId(`open-project-${keep.id}`)).toBeVisible();

    // Toast успеха с именем проекта.
    const toast = page.locator('[data-testid="toast"][data-tone="success"]');
    await expect(toast.filter({ hasText: nameGone })).toBeVisible();

    // Страница не перезагружалась.
    const marker = await page.evaluate(
      () => (window as unknown as { __e2eNoReload?: number }).__e2eNoReload,
    );
    expect(marker).toBe(1);

    // API-истина: проекта больше нет, повторный DELETE отвечает 404.
    const res = await page.request.get('/api/projects');
    const projects = (await res.json()) as ProjectSummary[];
    expect(projects.some((p) => p.id === gone.id)).toBe(false);
    const again = await page.request.delete(`/api/projects/${encodeURIComponent(gone.id)}`);
    expect(again.status()).toBe(404);
  });
});

test.describe('todo_16 A1 · длинный путь на «Открыть существующий»', () => {
  test('путь ~150 символов: truncate + полный путь в title, без горизонтального скролла', async ({
    page,
  }) => {
    // Итоговый путь = PROJECTS_ROOT (temp, десятки символов) + имя ~110 симв.
    const name = `${uniqueName('proj-long-path')}-${'x'.repeat(80)}`;
    await createProject(page, name);
    const summary = await projectByName(page, name);
    expect(summary.mainPath.length).toBeGreaterThanOrEqual(100);

    await gotoOpenList(page);
    await expect(page.getByTestId('open-container')).toBeVisible();

    const pathEl = page.getByTestId(`open-project-path-${summary.id}`);
    await expect(pathEl).toBeVisible();
    // Усечение с многоточием + полный путь в title (spec A1).
    await expect(pathEl).toHaveClass(/truncate/);
    await expect(pathEl).toHaveAttribute('title', summary.mainPath);
    // Текст действительно усечён (контент шире видимой области элемента).
    const truncated = await pathEl.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(truncated, 'длинный путь должен реально усекаться').toBe(true);

    // Имя проекта видно полностью (перенос допустим, усечения нет).
    const row = page.getByTestId(`open-project-${summary.id}`);
    await expect(row.getByText(name, { exact: true })).toBeVisible();

    // Сетка не разрушена: страница не скроллится по горизонтали.
    const noHScroll = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth <= el.clientWidth + 1;
    });
    expect(noHScroll, 'страница «Открыть существующий» скроллится вбок').toBe(true);
  });
});
