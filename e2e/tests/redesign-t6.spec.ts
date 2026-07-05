import { expect, test, type Page } from '@playwright/test';
import {
  addRequirement,
  apiCreateRequirement,
  createProject,
  projectIdFromUrl,
  rowByName,
  uniqueName,
} from './helpers/app.js';

/**
 * T6 (todo_17) · Редизайн Dashboard / GraphView / DescPanel по макетам
 * new_design/screens/{dashboard,graph-view,desc-panel}.html.
 *
 * Покрывает:
 *  — Dashboard §2.19.1: карточка «Качество описаний» видна всегда; при нуле
 *    проблем — зелёное состояние dash-quality-ok «Все требования описаны»;
 *  — Dashboard §2.19.3: списки проблем ограничены 7 позициями + кнопка
 *    «Показать все (N)» / «Свернуть» (dash-no-desc-ft, dash-no-desc-nfr,
 *    «Функции без НФТ»);
 *  — DescPanel §2.7: markdown-рендер без сырого HTML (react-markdown),
 *    чипы связей («родитель · Имя» и т.д.) с «+N», бейдж типа,
 *    заголовок-кнопка clamp/разворачивание, disabled-удаление с причиной.
 *
 * Изоляция как во всём сьюте: свежий проект + уникальные имена на тест.
 */

/** Перейти из главного экрана проекта на дашборд через сайдбар. */
async function openDashboard(page: Page): Promise<void> {
  await page.getByTestId('sidebar-nav-dashboard').click();
  await expect(page.getByTestId('dashboard-page')).toBeVisible();
}

/** Создать связь между требованиями напрямую через REST (быстрые фикстуры). */
async function apiLink(
  page: Page,
  projectId: string,
  sourceSlug: string,
  type: 'CHILD_OF' | 'RELATES_TO' | 'DEPENDS_ON' | 'BLOCKED_BY',
  targetSlug: string,
): Promise<void> {
  const res = await page.request.post(`/api/projects/${encodeURIComponent(projectId)}/links`, {
    data: { sourceSlug, type, targetSlug },
  });
  if (!res.ok()) {
    throw new Error(`apiLink failed (${res.status()}): ${await res.text()}`);
  }
}

test.describe('Dashboard · карточка «Качество описаний» (§2.19)', () => {
  test('при нуле проблем карточка видна с зелёным состоянием «Все требования описаны»', async ({
    page,
  }) => {
    await createProject(page, uniqueName('dash-ok'));
    const projectId = projectIdFromUrl(page);

    // Единственное требование — с заполненным описанием ⇒ пробелов нет.
    await apiCreateRequirement(page, projectId, {
      kind: 'function',
      name: uniqueName('Full-Desc'),
      criticality: 'MEDIUM',
      description: 'Описание заполнено полностью.',
    });

    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();
    await openDashboard(page);

    // Карточка качества видна всегда; при нуле проблем — позитивное состояние.
    await expect(page.getByTestId('dash-quality')).toBeVisible();
    await expect(page.getByTestId('dash-quality-ok')).toBeVisible();
    await expect(page.getByTestId('dash-quality-ok')).toContainText('Все требования описаны');

    // Бейдж «Без описания: N» отсутствует.
    await expect(page.getByTestId('dash-quality-count')).toHaveCount(0);
  });

  test('списки проблем ограничены 7 позициями; «Показать все (N)» / «Свернуть»', async ({
    page,
  }) => {
    await createProject(page, uniqueName('dash-limit'));
    const projectId = projectIdFromUrl(page);

    // 9 ФТ и 8 НФТ без описания (REST — быстро, параллельно).
    const seeds: Array<Promise<string>> = [];
    for (let i = 0; i < 9; i++) {
      seeds.push(
        apiCreateRequirement(page, projectId, {
          kind: 'function',
          name: `FT-NoDesc-${i}-${Date.now()}`,
          criticality: 'LOW',
        }),
      );
    }
    for (let i = 0; i < 8; i++) {
      seeds.push(
        apiCreateRequirement(page, projectId, {
          kind: 'nfr',
          name: `NFR-NoDesc-${i}-${Date.now()}`,
          criticality: 'LOW',
        }),
      );
    }
    await Promise.all(seeds);

    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();
    await openDashboard(page);

    // Бейдж суммарного числа пробелов: 9 ФТ + 8 НФТ = 17.
    await expect(page.getByTestId('dash-quality-count')).toContainText('Без описания: 17');

    // ── «ФТ без описания»: 7 из 9, потом все, потом снова 7 ──
    const ftItems = page
      .getByTestId('dash-no-desc-ft')
      .locator('[data-testid^="dash-no-desc-open-"]');
    await expect(ftItems).toHaveCount(7);
    const ftShowAll = page.getByTestId('dash-no-desc-ft-show-all');
    await expect(ftShowAll).toContainText('Показать все (9)');
    await ftShowAll.click();
    await expect(ftItems).toHaveCount(9);
    await expect(ftShowAll).toContainText('Свернуть');
    await ftShowAll.click();
    await expect(ftItems).toHaveCount(7);

    // ── «НФТ без описания»: 7 из 8 ──
    const nfrItems = page
      .getByTestId('dash-no-desc-nfr')
      .locator('[data-testid^="dash-no-desc-open-"]');
    await expect(nfrItems).toHaveCount(7);
    const nfrShowAll = page.getByTestId('dash-no-desc-nfr-show-all');
    await expect(nfrShowAll).toContainText('Показать все (8)');
    await nfrShowAll.click();
    await expect(nfrItems).toHaveCount(8);
    await expect(nfrShowAll).toContainText('Свернуть');

    // ── «Функции без НФТ»: те же 9 ФТ, лимит 7 + разворачивание ──
    const missingItems = page.locator('li[data-testid^="dashboard-nfr-missing-"]');
    await expect(missingItems).toHaveCount(7);
    const missingShowAll = page.getByTestId('dashboard-nfr-missing-show-all');
    await expect(missingShowAll).toContainText('Показать все (9)');
    await missingShowAll.click();
    await expect(missingItems).toHaveCount(9);
    await expect(missingShowAll).toContainText('Свернуть');
    await missingShowAll.click();
    await expect(missingItems).toHaveCount(7);
  });
});

test.describe('DescPanel · редизайн (§2.7)', () => {
  test('markdown рендерится (жирный, списки), сырой HTML экранируется и не попадает в DOM', async ({
    page,
  }) => {
    await createProject(page, uniqueName('desc-md'));
    const name = uniqueName('MD-Req');
    const description = [
      'Абзац с **жирным текстом** внутри.',
      '',
      '- первый пункт',
      '- второй пункт',
      '',
      '<script>window.__xssInjected = true;</script>',
      '<b>сырой html</b>',
    ].join('\n');

    await addRequirement(page, { kind: 'function', name, criticality: 'MEDIUM', description });

    // Открываем панель описания из строки дерева.
    await rowByName(page, name).getByTestId('desc-expand').click();
    await expect(page.getByTestId('desc-panel')).toBeVisible();

    const body = page.getByTestId('desc-panel-body');

    // Markdown отрендерен: <strong> и список <ul><li>.
    await expect(body.locator('strong')).toHaveText('жирным текстом');
    await expect(body.locator('ul > li')).toHaveCount(2);
    await expect(body.locator('ul > li').first()).toHaveText('первый пункт');

    // Сырой HTML НЕ вставлен в DOM (безопасный рендер без rehype-raw).
    await expect(body.locator('script')).toHaveCount(0);
    await expect(body.locator('b')).toHaveCount(0);
    const bodyHtml = await body.innerHTML();
    expect(bodyHtml).not.toContain('<script');
    // Инъекция не исполнилась.
    const xss = await page.evaluate(() => (window as { __xssInjected?: boolean }).__xssInjected);
    expect(xss).toBeUndefined();
  });

  test('связи показаны чипами с русским типом; «+N» раскрывает остальные', async ({ page }) => {
    await createProject(page, uniqueName('desc-chips'));
    const projectId = projectIdFromUrl(page);

    const parentName = uniqueName('Chip-Parent');
    const mainName = uniqueName('Chip-Main');
    const relName = uniqueName('Chip-Rel');
    const depName = uniqueName('Chip-Dep');
    const nfrName = uniqueName('Chip-NFR');

    const [parentSlug, mainSlug, relSlug, depSlug, nfrSlug] = await Promise.all([
      apiCreateRequirement(page, projectId, {
        kind: 'function',
        name: parentName,
        criticality: 'HIGH',
      }),
      apiCreateRequirement(page, projectId, {
        kind: 'function',
        name: mainName,
        criticality: 'MEDIUM',
        description: 'Требование с четырьмя связями.',
      }),
      apiCreateRequirement(page, projectId, {
        kind: 'function',
        name: relName,
        criticality: 'LOW',
      }),
      apiCreateRequirement(page, projectId, {
        kind: 'function',
        name: depName,
        criticality: 'LOW',
      }),
      apiCreateRequirement(page, projectId, { kind: 'nfr', name: nfrName, criticality: 'LOW' }),
    ]);

    // 4 связи у mainName: родитель + связано + зависит + блокируется.
    await apiLink(page, projectId, mainSlug, 'CHILD_OF', parentSlug);
    await apiLink(page, projectId, mainSlug, 'RELATES_TO', relSlug);
    await apiLink(page, projectId, mainSlug, 'DEPENDS_ON', depSlug);
    await apiLink(page, projectId, mainSlug, 'BLOCKED_BY', nfrSlug);

    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    await rowByName(page, mainName).getByTestId('desc-expand').click();
    await expect(page.getByTestId('desc-panel')).toBeVisible();

    // Бейдж типа требования (средний род).
    await expect(page.getByTestId('desc-panel-type')).toHaveText('Функциональное');

    // Чипы: максимум 3 видимых + кнопка «+1».
    const chips = page.getByTestId('desc-panel-link-chip');
    await expect(chips).toHaveCount(3);
    const more = page.getByTestId('desc-panel-links-more');
    await expect(more).toHaveText('+1');
    await more.click();
    await expect(chips).toHaveCount(4);
    await expect(more).toHaveCount(0);

    // Русские подписи типов + имена целей.
    const links = page.getByTestId('desc-panel-links');
    await expect(links).toContainText(`родитель · ${parentName}`);
    await expect(links).toContainText(`связано · ${relName}`);
    await expect(links).toContainText(`зависит · ${depName}`);
    await expect(links).toContainText(`блокируется · ${nfrName}`);

    // Заголовок — кнопка clamp-2 с разворачиванием (aria-expanded).
    const title = page.getByTestId('desc-panel-title');
    await expect(title).toHaveText(mainName);
    await expect(title).toHaveAttribute('aria-expanded', 'false');
    await title.click();
    await expect(title).toHaveAttribute('aria-expanded', 'true');
  });

  test('удаление недоступно при вложенных: disabled-кнопка + видимая причина + чип «N вложенное»', async ({
    page,
  }) => {
    await createProject(page, uniqueName('desc-del'));
    const projectId = projectIdFromUrl(page);

    const parentName = uniqueName('Del-Parent');
    const childName = uniqueName('Del-Child');
    const [parentSlug, childSlug] = await Promise.all([
      apiCreateRequirement(page, projectId, {
        kind: 'function',
        name: parentName,
        criticality: 'HIGH',
        description: 'Родительское требование с одним вложенным.',
      }),
      apiCreateRequirement(page, projectId, {
        kind: 'function',
        name: childName,
        criticality: 'LOW',
      }),
    ]);
    await apiLink(page, projectId, childSlug, 'CHILD_OF', parentSlug);

    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    await rowByName(page, parentName).getByTestId('desc-expand').click();
    await expect(page.getByTestId('desc-panel')).toBeVisible();

    // Чип-агрегат вложенных (средний род: «1 вложенное»).
    await expect(page.getByTestId('desc-panel-links')).toContainText('1 вложенное');

    // Кнопка «Удалить» задизейблена, причина видна и связана через aria-describedby.
    const deleteBtn = page.getByTestId('desc-panel-delete');
    await expect(deleteBtn).toBeDisabled();
    await expect(deleteBtn).toHaveAttribute('aria-describedby', 'desc-panel-delete-reason');
    await expect(page.getByTestId('desc-panel-delete-reason')).toHaveText(
      'Удаление недоступно: сначала удалите дочерние (1 вложенное).',
    );

    // «Редактировать» при этом остаётся доступной.
    await expect(page.getByTestId('desc-panel-edit')).toBeEnabled();
  });
});
