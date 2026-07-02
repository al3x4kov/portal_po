import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  addRequirement,
  createProject,
  linkRequirements,
  rowByName,
  slugOf,
  uniqueName,
} from './helpers/app.js';

/**
 * T-1601 · E16 — видимость и отсутствие перекрытий раскладки таблицы.
 *
 * После E16 в обеих секциях (ФТ/НФТ) появилась колонка «Связи» (`req-links-cell`),
 * колонка действий расширена до 210px, а `<main>` растянут на всю ширину экрана.
 * Тесты проверяют, что:
 *   1) действия строки видимы по ховеру;
 *   2) кнопки действий целиком внутри карточки секции (не вылезают за границы);
 *   3) кнопки строки не налезают друг на друга;
 *   4) чипы связей лежат в своей колонке «Связи» и не заходят в соседние;
 *   5) страница не скроллится по горизонтали на 1280 и 1680.
 *
 * Изоляция — как в остальном сьюте: свежий проект + уникальные имена на тест.
 * Серийный режим наследуется из playwright.config (workers:1, fullyParallel:false),
 * дополнительно фиксируем его локально.
 */
test.describe.configure({ mode: 'serial' });

/**
 * QA-7: субпиксельный рендеринг делал прежний допуск ±1px хрупким (маскировалось
 * `retries:2`). Теперь допуск устойчивый, а перекрытие проверяется как реальное
 * пересечение прямоугольников по обеим осям (а не по хрупкому порядку x).
 */
const TOL = 2;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** boundingBox с явной ошибкой, если элемент не имеет геометрии. */
async function box(loc: Locator): Promise<Box> {
  const b = await loc.boundingBox();
  if (!b) throw new Error('element has no bounding box');
  return b;
}

/** Величина пересечения двух прямоугольников по обеим осям (0, если не пересекаются). */
function overlapArea(a: Box, b: Box): { dx: number; dy: number } {
  const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { dx, dy };
}

interface Fixture {
  tag: string;
  /** ФТ со связью (RELATES_TO f2) — в его req-links-cell будут чипы. */
  f1: string;
  f2: string;
  /** НФТ со связью (DEPENDS_ON n2) — в его req-links-cell будут чипы. */
  n1: string;
  n2: string;
}

/** Проект с 2 ФТ и 2 НФТ; по одной неиерархической связи в каждой секции. */
async function buildFixture(page: Page): Promise<Fixture> {
  const tag = uniqueName('lay');
  const fx: Fixture = {
    tag,
    f1: `${tag}-f1`,
    f2: `${tag}-f2`,
    n1: `${tag}-n1`,
    n2: `${tag}-n2`,
  };
  await createProject(page, uniqueName('lay-proj'));
  await addRequirement(page, { kind: 'function', name: fx.f1, criticality: 'HIGH' });
  await addRequirement(page, { kind: 'function', name: fx.f2, criticality: 'MEDIUM' });
  await addRequirement(page, { kind: 'nfr', name: fx.n1, criticality: 'CRITICAL' });
  await addRequirement(page, { kind: 'nfr', name: fx.n2, criticality: 'LOW' });
  // Неиерархические связи → чипы в колонке «Связи» у обоих концов пары.
  await linkRequirements(page, fx.f1, 'RELATES_TO', fx.f2);
  await linkRequirements(page, fx.n1, 'DEPENDS_ON', fx.n2);
  return fx;
}

/**
 * Проверка 1–3 для одной строки: ховер раскрывает кнопки действий; каждая кнопка
 * целиком внутри карточки секции; соседние кнопки строки не перекрываются.
 */
async function checkRowActions(
  page: Page,
  cardBox: Box,
  name: string,
  isFunction: boolean,
): Promise<void> {
  const slug = await slugOf(page, name);
  const row = rowByName(page, name);
  await row.hover();

  const buttons: Locator[] = [];
  if (isFunction) buttons.push(row.getByTestId('row-add-nfr'));
  buttons.push(row.getByTestId(`link-btn-${slug}`));
  buttons.push(row.getByTestId(`delete-btn-${slug}`));

  // 1) видимость (UX-1: действия видны и без ховера; ховер лишь усиливает).
  for (const b of buttons) await expect(b).toBeVisible();

  // 2) каждая кнопка горизонтально в пределах карточки секции (устойчивый допуск)
  const boxes: Box[] = [];
  for (const b of buttons) {
    const bb = await box(b);
    expect(bb.x, `кнопка "${name}" выходит за левую границу карточки`).toBeGreaterThanOrEqual(
      cardBox.x - TOL,
    );
    expect(
      bb.x + bb.width,
      `кнопка "${name}" выходит за правую границу карточки`,
    ).toBeLessThanOrEqual(cardBox.x + cardBox.width + TOL);
    boxes.push(bb);
  }

  // 3) никакая пара кнопок строки не перекрывается (реальное пересечение по обеим
  //    осям больше допуска — устойчиво к порядку и субпикселям).
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const { dx, dy } = overlapArea(boxes[i], boxes[j]);
      const overlapping = dx > TOL && dy > TOL;
      expect(overlapping, `кнопки строки "${name}" перекрываются`).toBe(false);
    }
  }
}

/**
 * Проверка 4 для строки со связями: каждый чип целиком внутри `req-links-cell`
 * (±1px) и не заходит в соседние колонки — «Реализация» слева и «Описание» справа.
 * Граница links-ячейки справа совпадает с границей колонки «Описание», поэтому
 * контроль правого края чипа по ячейке одновременно закрывает и вход в «Описание».
 */
async function checkLinkChips(page: Page, name: string): Promise<void> {
  const row = rowByName(page, name);
  const linksCell = row.getByTestId('req-links-cell');
  const implCell = row.getByTestId('req-implemented-cell');
  const cellBox = await box(linksCell);
  const implBox = await box(implCell);

  const chips = row.locator('[data-testid^="rel-chip-"]');
  const n = await chips.count();
  expect(n, `у строки "${name}" ожидались чипы связей`).toBeGreaterThan(0);

  for (let i = 0; i < n; i += 1) {
    const cb = await box(chips.nth(i));
    // внутри своей колонки «Связи»
    expect(cb.x, `чип связи "${name}" выходит влево за колонку «Связи»`).toBeGreaterThanOrEqual(
      cellBox.x - TOL,
    );
    expect(cb.x + cb.width, `чип связи "${name}" заходит в колонку «Описание»`).toBeLessThanOrEqual(
      cellBox.x + cellBox.width + TOL,
    );
    // не заходит в «Реализация» (левый сосед)
    expect(cb.x, `чип связи "${name}" заходит в колонку «Реализация»`).toBeGreaterThanOrEqual(
      implBox.x + implBox.width - TOL,
    );
  }
}

test.describe('T-1601 · E16 раскладка: видимость и отсутствие перекрытий', () => {
  test('действия строк видимы по ховеру и целиком внутри карточек секций', async ({ page }) => {
    const fx = await buildFixture(page);

    const fnCard = await box(page.getByTestId('section-function'));
    await checkRowActions(page, fnCard, fx.f1, true);
    await checkRowActions(page, fnCard, fx.f2, true);

    const nfrCard = await box(page.getByTestId('section-nfr'));
    await checkRowActions(page, nfrCard, fx.n1, false);
    await checkRowActions(page, nfrCard, fx.n2, false);
  });

  test('чипы связей лежат в колонке «Связи» и не заходят в соседние колонки', async ({ page }) => {
    const fx = await buildFixture(page);

    // ФТ со связью RELATES_TO и НФТ со связью DEPENDS_ON.
    await checkLinkChips(page, fx.f1);
    await checkLinkChips(page, fx.n1);
    // реципрокные концы тоже несут чипы
    await checkLinkChips(page, fx.f2);
    await checkLinkChips(page, fx.n2);
  });

  test('нет горизонтального выхода страницы за экран на 1280 и 1680', async ({ page }) => {
    await buildFixture(page);

    for (const size of [
      { width: 1280, height: 800 },
      { width: 1680, height: 1000 },
    ]) {
      await page.setViewportSize(size);
      // Секции должны быть отрисованы на новой ширине.
      await expect(page.getByTestId('section-function')).toBeVisible();
      await expect(page.getByTestId('section-nfr')).toBeVisible();

      const noHScroll = await page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        return el.scrollWidth <= el.clientWidth + 1;
      });
      expect(noHScroll, `страница скроллится вбок на ширине ${size.width}`).toBe(true);
    }
  });
});
