import { expect, test } from '@playwright/test';
import { addRequirement, createProject, rowByName, uniqueName } from './helpers/app.js';

/**
 * T3 (todo_17) · Главный экран после редизайна (new_design/screens/main-tree.html):
 * шапка с копированием пути, «Проекты» → Start, sidebar («Граф связей», логотип PO),
 * строка «Показано X из Y · Сбросить фильтры», «+ Описание» у требования без
 * описания и рабочая область на всю ширину окна (правка PO поверх макета).
 */

test.describe('T3 · шапка главного экрана', () => {
  test('клик по пути в шапке копирует его в буфер и показывает toast «Путь скопирован»', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'clipboard permissions — только Chromium');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const name = uniqueName('copy-path-proj');
    await createProject(page, name);

    // Подпись-подсказка и сам путь видны в шапке (ждём загрузки проекта).
    await expect(page.getByTestId('copy-path')).toContainText('· копируется по клику');
    await expect(page.getByTestId('main-path')).toContainText(name);
    const mainPath = (await page.getByTestId('main-path').textContent()) ?? '';

    await page.getByTestId('main-path').click();

    await expect(page.getByTestId('toast').filter({ hasText: 'Путь скопирован' })).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(mainPath);
  });

  test('кнопка «Проекты» возвращает на стартовый экран', async ({ page }) => {
    await createProject(page, uniqueName('back-proj'));

    const back = page.getByTestId('main-back');
    await expect(back).toHaveText(/Проекты/);
    await back.click();

    await expect(page.getByTestId('start-page')).toBeVisible();
  });

  test('логотип PO в sidebar («К списку проектов») возвращает на стартовый экран', async ({
    page,
  }) => {
    await createProject(page, uniqueName('home-proj'));

    const home = page.getByTestId('sidebar-home');
    await expect(home).toHaveAttribute('aria-label', 'К списку проектов');
    await home.click();

    await expect(page.getByTestId('start-page')).toBeVisible();
  });
});

test.describe('T3 · sidebar: навигация и действия', () => {
  test('пункт «Граф связей» включает режим графа; «Требования» возвращает дерево', async ({
    page,
  }) => {
    await createProject(page, uniqueName('graph-nav-proj'));
    await addRequirement(page, { kind: 'function', name: uniqueName('graph-nav-ft') });

    const graphNav = page.getByTestId('sidebar-nav-graph');
    await expect(graphNav).toHaveAttribute('aria-label', 'Граф связей');
    await graphNav.click();

    // Переключатель вида в тулбаре отражает активный граф.
    await expect(page.getByTestId('toggle-graph')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('toggle-tree')).toHaveAttribute('aria-pressed', 'false');
    await expect(graphNav).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('graph-canvas')).toBeVisible();
    // Кнопки «Раскрыть/Свернуть все уровни» скрыты в режиме графа.
    await expect(page.getByTestId('toggle-expand-all')).toBeHidden();

    // Обратно в дерево через пункт «Требования».
    await page.getByTestId('sidebar-nav-requirements').click();
    await expect(page.getByTestId('toggle-tree')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('sidebar-nav-graph')).not.toHaveAttribute('aria-current', 'page');
  });

  test('зона действий подписана «Действия»: «Экспорт проекта» и «Генерация задач»', async ({
    page,
  }) => {
    await createProject(page, uniqueName('actions-proj'));

    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toContainText('Действия');
    await expect(page.getByTestId('sidebar-open-export')).toHaveAttribute(
      'aria-label',
      'Экспорт проекта',
    );
    await expect(page.getByTestId('sidebar-open-tasks')).toHaveAttribute(
      'aria-label',
      'Генерация задач',
    );
    await expect(page.getByTestId('sidebar-nav-ai')).toHaveAttribute('aria-label', 'Настройка AI');
  });
});

test.describe('T3 · тулбар дерева', () => {
  test('«Сбросить фильтры» в строке счётчика возвращает полное дерево и исчезает', async ({
    page,
  }) => {
    const tag = uniqueName('reset');
    await createProject(page, uniqueName('reset-proj'));
    await addRequirement(page, { kind: 'function', name: `${tag}-high`, criticality: 'HIGH' });
    await addRequirement(page, { kind: 'function', name: `${tag}-low`, criticality: 'LOW' });

    const shownCount = page.getByTestId('shown-count');
    await expect(shownCount).toContainText('Показано 2 из 2');
    // Без фильтров кнопки сброса в строке счётчика нет.
    await expect(page.getByTestId('toolbar-reset-filters')).toBeHidden();

    // Применяем фильтр критичности: остаётся только HIGH.
    await page.getByTestId('criticality-filter').click();
    await page.getByTestId('crit-opt-high').click();
    await page.getByTestId('crit-apply').click();
    await expect(rowByName(page, `${tag}-high`)).toBeVisible();
    await expect(rowByName(page, `${tag}-low`)).toBeHidden();
    await expect(shownCount).toContainText('Показано 1 из 2');

    // Сбрасываем из строки счётчика.
    await page.getByTestId('toolbar-reset-filters').click();
    await expect(rowByName(page, `${tag}-low`)).toBeVisible();
    await expect(shownCount).toContainText('Показано 2 из 2');
    await expect(page.getByTestId('toolbar-reset-filters')).toBeHidden();
  });

  test('placeholder поиска — «Поиск по имени…»; тумблеры уровней — иконки с aria-label', async ({
    page,
  }) => {
    await createProject(page, uniqueName('toolbar-proj'));

    await expect(page.getByTestId('search-input')).toHaveAttribute(
      'placeholder',
      'Поиск по имени…',
    );
    await expect(page.getByTestId('toggle-expand-all')).toHaveAttribute(
      'aria-label',
      'Раскрыть все уровни',
    );
    await expect(page.getByTestId('toggle-collapse')).toHaveAttribute(
      'aria-label',
      'Свернуть все уровни',
    );
    // Режим по умолчанию — «Раскрыть все».
    await expect(page.getByTestId('toggle-expand-all')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('toggle-collapse')).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('T3 · описание в строке дерева', () => {
  test('«+ Описание» у требования без описания открывает модалку с фокусом на описании', async ({
    page,
  }) => {
    const name = uniqueName('nodesc-ft');
    await createProject(page, uniqueName('desc-add-proj'));
    await addRequirement(page, { kind: 'function', name });

    const row = rowByName(page, name);
    // Пустое описание: кнопки раскрытия нет, есть «+ Описание».
    await expect(row.getByTestId('desc-expand')).toHaveCount(0);
    const addDesc = row.getByTestId('desc-add');
    await expect(addDesc).toContainText('+ Описание');
    await addDesc.click();

    const modal = page.getByTestId('requirement-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('req-description')).toBeFocused();
  });

  test('у требования с описанием — desc-expand (без «+ Описание»)', async ({ page }) => {
    const name = uniqueName('desc-ft');
    await createProject(page, uniqueName('desc-exp-proj'));
    await addRequirement(page, {
      kind: 'function',
      name,
      description: 'Краткое описание для проверки',
    });

    const row = rowByName(page, name);
    await expect(row.getByTestId('desc-add')).toHaveCount(0);
    await row.getByTestId('desc-expand').click();
    await expect(page.getByTestId('desc-panel')).toBeVisible();
    await expect(page.getByTestId('desc-panel-title')).toHaveText(name);
  });
});

test.describe('T3 · рабочая область на всю ширину (правка PO)', () => {
  test.use({ viewport: { width: 1600, height: 1000 } });

  test('main занимает всю ширину окна за вычетом sidebar; max-width не ограничен', async ({
    page,
  }) => {
    await createProject(page, uniqueName('wide-proj'));
    await addRequirement(page, { kind: 'function', name: uniqueName('wide-ft') });

    const main = page.getByTestId('main-page').locator('main');
    await expect(main).toBeVisible();

    const sidebarBox = await page.getByTestId('sidebar').boundingBox();
    const mainBox = await main.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(mainBox).not.toBeNull();

    // Фактическая ширина окна без вертикального скроллбара (если он есть).
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(clientWidth).toBeGreaterThanOrEqual(1580);

    // Рабочая область начинается сразу после sidebar и тянется до правого края окна.
    const sidebarWidth = sidebarBox!.width;
    expect(mainBox!.x).toBeCloseTo(sidebarWidth, 0);
    expect(mainBox!.width).toBeGreaterThanOrEqual(clientWidth - sidebarWidth - 2);

    // Никакой контейнер не ограничивает ширину max-width'ом.
    const maxWidth = await main.evaluate((el) => getComputedStyle(el).maxWidth);
    expect(maxWidth).toBe('none');

    // Шапка тоже на всю ширину рабочей области.
    const headerBox = await page.getByTestId('path-header').boundingBox();
    expect(headerBox!.width).toBeGreaterThanOrEqual(clientWidth - sidebarWidth - 2);
  });
});
