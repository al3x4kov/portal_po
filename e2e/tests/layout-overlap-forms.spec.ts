import { expect, test, type Locator, type Page } from '@playwright/test';
import { addRequirement, createProject, rowByName, uniqueName } from './helpers/app.js';

/**
 * QA · перекрытия текстов формами и кнопками ЗА ПРЕДЕЛАМИ таблицы дерева
 * (таблицу закрывает layout-overlap.spec.ts). Проверяемые поверхности:
 *
 *   1) карточка требования: вкладки, сегменты критичности, поля срока и футер
 *      «Отменить/Сохранить» — попарно без пересечений и внутри модалки,
 *      в т.ч. на невысоком экране (контент скроллится, футер не наезжает);
 *   2) вкладка «Приоритизация»: карточка источника — селекты RICE и поля
 *      попарно без пересечений, всё в границах модалки;
 *   3) модалка AI-импорта: длинные подсказки чекбоксов не наезжают друг на
 *      друга и на футер;
 *   4) тулбар главного экрана: поиск, фильтры и переключатели видов — попарно
 *      без пересечений на 1280 и 1680;
 *   5) закреплённая нижняя панель не перекрывает последнюю строку таблицы;
 *   6) дашборд и справочники: карточки не пересекаются, без h-скролла;
 *   7) стартовый экран: hero-карточки не пересекаются на 1280 и 1024.
 *
 * Методика — как в layout-overlap.spec.ts: реальное пересечение прямоугольников
 * по обеим осям с устойчивым допуском (субпиксельный рендеринг).
 */
test.describe.configure({ mode: 'serial' });

const TOL = 2;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(loc: Locator): Promise<Box> {
  const b = await loc.boundingBox();
  if (!b) throw new Error('element has no bounding box');
  return b;
}

/** true, если прямоугольники реально пересекаются по обеим осям (> допуска). */
function overlaps(a: Box, b: Box): boolean {
  const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return dx > TOL && dy > TOL;
}

/** Ни одна пара из набора видимых элементов не пересекается. */
async function expectNoPairOverlaps(items: Array<{ label: string; loc: Locator }>): Promise<void> {
  const boxes: Array<{ label: string; b: Box }> = [];
  for (const { label, loc } of items) {
    await expect(loc, `элемент «${label}» должен быть видим`).toBeVisible();
    boxes.push({ label, b: await box(loc) });
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      expect(
        overlaps(boxes[i].b, boxes[j].b),
        `«${boxes[i].label}» перекрывается с «${boxes[j].label}»`,
      ).toBe(false);
    }
  }
}

/** Элемент целиком внутри контейнера (по обеим осям, с допуском). */
async function expectInside(inner: Locator, outer: Locator, label: string): Promise<void> {
  const i = await box(inner);
  const o = await box(outer);
  expect(i.x, `«${label}» выходит за левую границу`).toBeGreaterThanOrEqual(o.x - TOL);
  expect(i.x + i.width, `«${label}» выходит за правую границу`).toBeLessThanOrEqual(
    o.x + o.width + TOL,
  );
  expect(i.y, `«${label}» выходит за верхнюю границу`).toBeGreaterThanOrEqual(o.y - TOL);
  expect(i.y + i.height, `«${label}» выходит за нижнюю границу`).toBeLessThanOrEqual(
    o.y + o.height + TOL,
  );
}

async function expectNoHScroll(page: Page, where: string): Promise<void> {
  const ok = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth <= el.clientWidth + 1;
  });
  expect(ok, `горизонтальный скролл страницы: ${where}`).toBe(true);
}

test.describe('QA · перекрытия: формы, модалки, тулбар, панели', () => {
  test('карточка требования: вкладки, критичность, срок и футер без пересечений; низкий экран скроллится', async ({
    page,
  }) => {
    await createProject(page, uniqueName('ovl-proj'));
    await page.getByTestId('footer-add-function').click();
    const modal = page.getByTestId('requirement-modal');
    await expect(modal).toBeVisible();

    // Вкладки не пересекаются и лежат в модалке (набор зависит от режима:
    // в создании «Связи» недоступны — берём фактически отрисованные).
    const tabLocators = modal.getByRole('tab');
    const tabCount = await tabLocators.count();
    expect(tabCount, 'ожидались вкладки карточки').toBeGreaterThanOrEqual(3);
    const tabItems = [];
    for (let i = 0; i < tabCount; i += 1) {
      tabItems.push({ label: `вкладка №${i + 1}`, loc: tabLocators.nth(i) });
    }
    await expectNoPairOverlaps(tabItems);
    for (const { label, loc } of tabItems) await expectInside(loc, modal, label);

    // Сегменты критичности: 5 кнопок, попарно без пересечений, внутри модалки.
    const seg = page.getByTestId('req-criticality').locator('label');
    await expect(seg).toHaveCount(5);
    const segItems = [];
    for (let i = 0; i < 5; i += 1) {
      segItems.push({ label: `критичность №${i + 1}`, loc: seg.nth(i) });
    }
    await expectNoPairOverlaps(segItems);
    await expectInside(page.getByTestId('req-criticality'), modal, 'блок критичности');

    // «Не реализовано» открывает квартал/год — поля не пересекаются с футером.
    await page.getByTestId('req-implemented-no').click();
    await expectNoPairOverlaps([
      { label: 'поле «Квартал»', loc: page.getByTestId('req-quarter') },
      { label: 'поле «Год»', loc: page.getByTestId('req-year') },
      { label: 'кнопка «Отменить»', loc: page.getByTestId('req-cancel') },
      { label: 'кнопка «Сохранить»', loc: page.getByTestId('req-submit') },
    ]);

    // Невысокий экран: футер остаётся видимым и не наезжает на поле имени.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.getByTestId('req-submit')).toBeVisible();
    const nameBox = await box(page.getByTestId('req-name'));
    const submitBox = await box(page.getByTestId('req-submit'));
    expect(
      overlaps(nameBox, submitBox),
      'футер модалки наезжает на поле имени на низком экране',
    ).toBe(false);
    await page.getByTestId('req-cancel').click();
  });

  test('вкладка «Приоритизация»: поля карточки источника без пересечений и внутри модалки', async ({
    page,
  }) => {
    const name = uniqueName('ovl-pri');
    await createProject(page, uniqueName('ovl-pri-proj'));
    await addRequirement(page, { kind: 'function', name, criticality: 'HIGH' });
    await rowByName(page, name)
      .getByTestId(/^req-name-/)
      .click();
    const modal = page.getByTestId('requirement-modal');
    await expect(modal).toBeVisible();

    await page.getByTestId('req-tab-priority').click();
    await page.getByTestId('src-add').click();
    const card = page.locator('[data-testid^="src-card-"]').first();
    await expect(card).toBeVisible();

    // Все поля карточки источника (select/input) попарно без пересечений.
    const fields = card.locator('select, input');
    const n = await fields.count();
    expect(n, 'в карточке источника ожидались поля').toBeGreaterThanOrEqual(6);
    const items = [];
    for (let i = 0; i < n; i += 1) {
      if (!(await fields.nth(i).isVisible())) continue;
      items.push({ label: `поле источника №${i + 1}`, loc: fields.nth(i) });
    }
    await expectNoPairOverlaps(items);
    await expectInside(card, modal, 'карточка источника');
    await page.getByTestId('req-cancel').click();
  });

  test('модалка AI-импорта: подсказки чекбоксов не наезжают друг на друга и на футер', async ({
    page,
  }) => {
    await createProject(page, uniqueName('ovl-ai-proj'));
    await page.getByTestId('footer-ai-import').click();
    const modal = page.getByTestId('ai-import');
    await expect(modal).toBeVisible();

    // Label-блоки чекбоксов целиком (чекбокс + многострочная подсказка).
    const buildTreeBlock = modal.locator('label', {
      has: page.getByTestId('ai-import-build-tree'),
    });
    const inferLinksBlock = modal.locator('label', {
      has: page.getByTestId('ai-import-infer-links'),
    });
    await expectNoPairOverlaps([
      { label: 'блок «логическое дерево»', loc: buildTreeBlock },
      { label: 'блок «смысловые связи»', loc: inferLinksBlock },
      { label: 'кнопка «Отмена»', loc: page.getByTestId('ai-import-cancel') },
      { label: 'кнопка «Начать анализ»', loc: page.getByTestId('ai-import-start') },
    ]);
    await expectInside(buildTreeBlock, modal, 'блок чекбокса логического дерева');
    await expectInside(inferLinksBlock, modal, 'блок чекбокса смысловых связей');
    await page.getByTestId('ai-import-cancel').click();
  });

  test('тулбар: поиск, фильтры и переключатели видов без пересечений на 1280 и 1680', async ({
    page,
  }) => {
    await createProject(page, uniqueName('ovl-tb-proj'));
    for (const size of [
      { width: 1280, height: 800 },
      { width: 1680, height: 1000 },
    ]) {
      await page.setViewportSize(size);
      await expectNoPairOverlaps([
        { label: 'поиск', loc: page.getByTestId('search-input') },
        { label: 'фильтр критичности', loc: page.getByTestId('criticality-filter') },
        { label: 'фильтр реализации', loc: page.getByTestId('impl-filter') },
        { label: 'фильтр источника', loc: page.getByTestId('source-filter') },
        { label: 'фильтр «Непроверенные»', loc: page.getByTestId('filter-ai-pending') },
        { label: 'переключатель «Дерево»', loc: page.getByTestId('toggle-tree') },
        { label: 'переключатель «Граф»', loc: page.getByTestId('toggle-graph') },
        { label: 'раскрыть все', loc: page.getByTestId('toggle-expand-all') },
      ]);
      await expectNoHScroll(page, `тулбар на ${size.width}`);
    }
  });

  test('закреплённая нижняя панель не перекрывает последнюю строку таблицы', async ({ page }) => {
    await createProject(page, uniqueName('ovl-ft-proj'));
    // Достаточно строк, чтобы таблица ушла под нижнюю панель без запаса.
    for (let i = 1; i <= 8; i += 1) {
      await addRequirement(page, {
        kind: 'nfr',
        name: uniqueName(`ovl-ft-n${i}`),
        criticality: 'LOW',
      });
    }
    const rows = page.locator('[data-testid^="tree-row-"]');
    const last = rows.last();
    await last.scrollIntoViewIfNeeded();
    const lastBox = await box(last);
    const footerBox = await box(page.getByTestId('main-footer'));
    expect(
      overlaps(lastBox, footerBox),
      'нижняя панель перекрывает последнюю строку таблицы после прокрутки',
    ).toBe(false);
  });

  test('дашборд: карточки не пересекаются, без горизонтального скролла', async ({ page }) => {
    await createProject(page, uniqueName('ovl-db-proj'));
    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('ovl-db-f'),
      criticality: 'HIGH',
    });
    await page.getByTestId('sidebar-nav-dashboard').click();
    await expect(page.getByTestId('dashboard-page')).toBeVisible();
    await expectNoPairOverlaps([
      { label: 'карточка «Топ-5 по RICE»', loc: page.getByTestId('dash-top-rice') },
      { label: 'карточка «Качество описаний»', loc: page.getByTestId('dash-quality') },
    ]);
    await expectNoHScroll(page, 'дашборд');
  });

  test('справочники: карточки приоритетов и источников без пересечений и h-скролла', async ({
    page,
  }) => {
    await createProject(page, uniqueName('ovl-dic-proj'));
    await page.getByTestId('sidebar-nav-dictionaries').click();
    await expect(page.getByTestId('dictionaries-page')).toBeVisible();
    await expectNoPairOverlaps([
      { label: 'карточка приоритетов', loc: page.getByTestId('dict-priorities') },
      { label: 'карточка источников', loc: page.getByTestId('dict-sources') },
    ]);
    await expectNoHScroll(page, 'справочники');
  });

  test('стартовый экран: hero-карточки без пересечений на 1280 и 1024', async ({ page }) => {
    for (const size of [
      { width: 1280, height: 800 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(size);
      await page.goto('/');
      await expectNoPairOverlaps([
        { label: '«Создать новый»', loc: page.getByTestId('start-new') },
        { label: '«Импортировать»', loc: page.getByTestId('start-import') },
        { label: '«Открыть существующий»', loc: page.getByTestId('start-open') },
      ]);
      await expectNoHScroll(page, `стартовый экран на ${size.width}`);
    }
  });
});
