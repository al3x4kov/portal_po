import { expect, test, type Page } from '@playwright/test';
import { startAiStub, type AiStub } from './helpers/ai-stub.js';
import {
  apiCreateRequirement,
  createProject,
  projectIdFromUrl,
  uniqueName,
} from './helpers/app.js';
import {
  BACKLOG_JOB_TIMEOUT as JOB_TIMEOUT,
  clickApplyCapturingBody,
  goToReview,
  listRequirements,
  makeXlsx,
  reviewRow,
} from './helpers/backlog.js';

/**
 * task25 · E2E редактирования разметки на шаге «Выверка» AI-импорта бэклога
 * (критерии приёмки 1–7, .dev/todo/task25_backlog_review_edit.md):
 *
 * 1. Правка бизнес-имени: инлайн-input (Enter), бейдж «изменено», apply шлёт
 *    overrides ТОЛЬКО для изменённой строки; требование создано с новым
 *    именем, исходная формулировка в описании нетронута; отчёт — новое имя.
 * 2. Перенос под существующий узел: поповер, регистронезависимый поиск по
 *    подстроке, выбор узла → CHILD_OF к нему; предложенный моделью новый
 *    узел для этой строки НЕ создан.
 * 3. Новый узел со своим именем: «Создать новый узел: „…“» → узел создан
 *    корневым (без CHILD_OF), строка встроена под него.
 * 4. Правка срока: select квартала + input года, 📄 «из файла» исчезает,
 *    бейдж «изменено»; API: target = новые значения; колонка «Срок
 *    реализации» и новое значение — в отчёте.
 * 5. Esc/сброс: Esc отменяет правку имени без бейджа; «Вернуть предложенное»
 *    снимает parent-override; дубль-строка не редактируется; apply после
 *    сбросов уходит БЕЗ overrides (обратная совместимость).
 * 6. Невалидный override (год 2150): HTTP 400 → русский текст в
 *    ai-backlog-apply-error, шаг выверки жив; после исправления apply
 *    успешен.
 *
 * Мок-модель — общий ai-stub; xlsx собирается программно (helpers/backlog).
 */

const MODEL = 'Qwen3-235B-A22B';
const STUB_MODELS = [MODEL, 'Qwen-Coder-Next'];

let stub: AiStub;

test.beforeAll(async () => {
  stub = await startAiStub({ models: STUB_MODELS, reply: 'Стабовый ответ ассистента.' });
});

test.afterAll(async () => {
  await stub.close();
});

/** Глобальный ключ общий для spec-файлов — сбрасываем после каждого теста. */
test.afterEach(async ({ page }) => {
  const res = await page.request.put('/api/ai/config', { data: { apiKey: null } });
  if (!res.ok()) throw new Error(`PUT /api/ai/config {apiKey:null} failed (${res.status()})`);
});

/** Свежий проект с настроенным AI; возвращает id проекта. */
async function projectWithAi(page: Page, prefix: string): Promise<string> {
  await createProject(page, uniqueName(prefix));
  const id = projectIdFromUrl(page);
  const res = await page.request.put('/api/ai/config', {
    data: { baseURL: stub.baseUrl, apiKey: 'sk-e2e-task25-key', projectId: id, model: MODEL },
  });
  if (!res.ok()) throw new Error(`PUT /api/ai/config failed (${res.status()})`);
  await page.reload();
  await expect(page.getByTestId('main-page')).toBeVisible();
  return id;
}

/* ══ 1 · Правка бизнес-имени доезжает до требования и отчёта ═══════════════ */

test.describe('task25 · правка бизнес-имени', () => {
  test('инлайн-правка имени: бейдж «изменено», overrides только для изменённой строки, новое имя в API и отчёте', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'T25-Name');
    await apiCreateRequirement(page, id, { kind: 'function', name: 'Платежи' });

    stub.setBacklogAnswers({
      'CRPV-201': { businessName: 'Оплата картой', parentExisting: 'Платежи' },
      'CRPV-202': { businessName: 'Оплата по QR-коду', parentExisting: 'Платежи' },
    });
    try {
      const xlsx = makeXlsx(testInfo, 'backlog-edit-name.xlsx', [
        ['Issue key', 'Summary'],
        ['CRPV-201', 'Сделать оплату банковской картой'],
        ['CRPV-202', 'Сделать оплату по QR'],
      ]);
      await goToReview(page, xlsx);

      // Инлайн-редактор: клик по имени → input, Enter сохраняет.
      const newName = 'Оплата банковской картой в один клик';
      await reviewRow(page, 'r2').getByTestId('ai-backlog-edit-name').click();
      const input = reviewRow(page, 'r2').getByTestId('ai-backlog-name-input');
      await expect(input).toBeVisible();
      await input.fill(newName);
      await input.press('Enter');
      await expect(reviewRow(page, 'r2').getByTestId('ai-backlog-name-input')).toHaveCount(0);
      await expect(reviewRow(page, 'r2')).toContainText(newName);
      await expect(reviewRow(page, 'r2').getByTestId('ai-backlog-row-edited')).toBeVisible();
      await expect(reviewRow(page, 'r3').getByTestId('ai-backlog-row-edited')).toHaveCount(0);

      // Apply шлёт overrides ТОЛЬКО для изменённой строки (контракт task25).
      const body = await clickApplyCapturingBody(page);
      expect(new Set(body.rowIds)).toEqual(new Set(['r2', 'r3']));
      expect(Object.keys(body.overrides ?? {})).toEqual(['r2']);
      expect(body.overrides!['r2']).toEqual({ businessName: newName });

      // Отчёт строится из смердженных mappings — показывает новое имя.
      await expect(page.getByTestId('ai-backlog-success')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-backlog-report-table')).toContainText(newName);
      await expect(page.getByTestId('ai-backlog-report-table')).not.toContainText('Оплата картой');

      // API: требование с НОВЫМ именем, исходная формулировка в описании цела.
      const reqs = await listRequirements(page, id);
      expect(reqs.some((r) => r.name === 'Оплата картой')).toBe(false);
      const renamed = reqs.find((r) => r.name === newName)!;
      expect(renamed).toBeDefined();
      expect(renamed.type).toBe('FUNCTION');
      expect(renamed.description).toContain('Сделать оплату банковской картой');
      expect(renamed.description).toContain('Ключ бэклога: CRPV-201');
      const root = reqs.find((r) => r.name === 'Платежи')!;
      expect(renamed.links.find((l) => l.type === 'CHILD_OF')?.targetSlug).toBe(root.slug);
      // Нетронутая строка создана под предложенным именем.
      expect(reqs.some((r) => r.name === 'Оплата по QR-коду')).toBe(true);
    } finally {
      stub.setBacklogAnswers(null);
    }
  });
});

/* ══ 2 · Перенос строки под существующий узел ══════════════════════════════ */

test.describe('task25 · перенос под существующий узел', () => {
  test('поповер: поиск подстрокой (регистронезависимо) → выбор узла → CHILD_OF к нему, предложенный новый узел не создан', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'T25-Parent');
    await apiCreateRequirement(page, id, { kind: 'function', name: 'Работа с клиентами' });
    await apiCreateRequirement(page, id, { kind: 'function', name: 'Обслуживание договоров' });

    stub.setBacklogAnswers({
      'CRPV-211': {
        businessName: 'Продление договора онлайн',
        parentNew: { name: 'Новый предложенный узел', parentName: null },
      },
      'CRPV-212': { businessName: 'Ответы на обращения', parentExisting: 'Работа с клиентами' },
    });
    try {
      // ≥2 строки данных: контентная эвристика ключевой колонки сервера
      // (keyLike/nonEmpty ≥ 0.6, заголовок считается) требует минимум двух.
      const xlsx = makeXlsx(testInfo, 'backlog-edit-parent.xlsx', [
        ['Issue key', 'Summary'],
        ['CRPV-211', 'Продлевать договор в личном кабинете'],
        ['CRPV-212', 'Отвечать на обращения клиентов'],
      ]);
      await goToReview(page, xlsx);

      // Модель предложила новый узел — виден бейдж «новый узел».
      const row = reviewRow(page, 'r2');
      await expect(row.getByTestId('ai-backlog-edit-parent')).toContainText(
        'Новый предложенный узел',
      );
      await expect(row.getByTestId('ai-backlog-badge-new-node')).toBeVisible();

      // Поповер: поиск «обслуж» (нижний регистр) находит «Обслуживание договоров».
      await row.getByTestId('ai-backlog-edit-parent').click();
      await expect(page.getByTestId('ai-backlog-parent-popover')).toBeVisible();
      await page.getByTestId('ai-backlog-parent-search').fill('обслуж');
      const options = page.getByTestId('ai-backlog-parent-option');
      await expect(options).toHaveCount(1);
      await expect(options.first()).toContainText('Обслуживание договоров');
      await options.first().click();
      await expect(page.getByTestId('ai-backlog-parent-popover')).toHaveCount(0);
      await expect(row.getByTestId('ai-backlog-edit-parent')).toContainText(
        'Обслуживание договоров',
      );
      await expect(row.getByTestId('ai-backlog-row-edited')).toBeVisible();

      const body = await clickApplyCapturingBody(page);
      expect(new Set(body.rowIds)).toEqual(new Set(['r2', 'r3']));
      expect(Object.keys(body.overrides ?? {})).toEqual(['r2']);
      expect(body.overrides!['r2']).toEqual({
        parent: { kind: 'existing', name: 'Обслуживание договоров' },
      });
      await expect(page.getByTestId('ai-backlog-success')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-backlog-report-new-nodes')).toContainText('0');
      await expect(page.getByTestId('ai-backlog-report-table')).toContainText(
        'Обслуживание договоров',
      );

      // API: CHILD_OF к выбранному узлу; предложенный новый узел НЕ создан.
      const reqs = await listRequirements(page, id);
      expect(reqs.some((r) => r.name === 'Новый предложенный узел')).toBe(false);
      const created = reqs.find((r) => r.name === 'Продление договора онлайн')!;
      const parent = reqs.find((r) => r.name === 'Обслуживание договоров')!;
      expect(created.links.find((l) => l.type === 'CHILD_OF')?.targetSlug).toBe(parent.slug);
      expect(reqs).toHaveLength(4); // 2 сеяных узла + 2 требования
    } finally {
      stub.setBacklogAnswers(null);
    }
  });
});

/* ══ 3 · Новый узел со своим именем (корневой, v1) ═════════════════════════ */

test.describe('task25 · новый узел со своим именем', () => {
  test('«Создать новый узел: „…“»: узел создан корневым, строка встроена под него', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'T25-NewNode');
    await apiCreateRequirement(page, id, { kind: 'function', name: 'Каталог' });

    stub.setBacklogAnswers({
      'CRPV-221': { businessName: 'Скидка по промокоду', parentExisting: 'Каталог' },
      'CRPV-222': { businessName: 'Карточка товара', parentExisting: 'Каталог' },
    });
    try {
      const xlsx = makeXlsx(testInfo, 'backlog-new-node.xlsx', [
        ['Issue key', 'Summary'],
        ['CRPV-221', 'Дать скидку по промокоду на кассе'],
        ['CRPV-222', 'Показать карточку товара в каталоге'],
      ]);
      await goToReview(page, xlsx);

      const row = reviewRow(page, 'r2');
      await row.getByTestId('ai-backlog-edit-parent').click();
      await page.getByTestId('ai-backlog-parent-search').fill('Управление скидками');
      const create = page.getByTestId('ai-backlog-parent-create');
      await expect(create).toContainText('Создать новый узел: «Управление скидками»');
      await create.click();
      await expect(row.getByTestId('ai-backlog-edit-parent')).toContainText('Управление скидками');
      await expect(row.getByTestId('ai-backlog-badge-new-node')).toBeVisible();
      await expect(row.getByTestId('ai-backlog-row-edited')).toBeVisible();

      const body = await clickApplyCapturingBody(page);
      expect(Object.keys(body.overrides ?? {})).toEqual(['r2']);
      expect(body.overrides!['r2']).toEqual({
        parent: { kind: 'new', name: 'Управление скидками' },
      });
      await expect(page.getByTestId('ai-backlog-success')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-backlog-report-new-nodes')).toContainText('1');

      // API: узел создан КОРНЕВЫМ (без CHILD_OF), типом строки; строка под ним.
      const reqs = await listRequirements(page, id);
      const node = reqs.find((r) => r.name === 'Управление скидками')!;
      expect(node).toBeDefined();
      expect(node.type).toBe('FUNCTION');
      expect(node.links.some((l) => l.type === 'CHILD_OF')).toBe(false);
      const created = reqs.find((r) => r.name === 'Скидка по промокоду')!;
      expect(created.links.find((l) => l.type === 'CHILD_OF')?.targetSlug).toBe(node.slug);
      // Предложенный моделью родитель «Каталог» остался без этой строки.
      const catalog = reqs.find((r) => r.name === 'Каталог')!;
      expect(created.links.find((l) => l.type === 'CHILD_OF')?.targetSlug).not.toBe(catalog.slug);
    } finally {
      stub.setBacklogAnswers(null);
    }
  });
});

/* ══ 4 · Правка «Срока реализации»: 📄 исчезает, значения доезжают ═════════ */

test.describe('task25 · правка срока реализации', () => {
  test('смена квартала и года: 📄 исчез, бейдж «изменено», target в API и колонка «Срок реализации» в отчёте', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'T25-Target');
    await apiCreateRequirement(page, id, { kind: 'function', name: 'Отчётность' });

    stub.setBacklogAnswers({
      'CRPV-231': { businessName: 'Ежемесячный отчёт по продажам', parentExisting: 'Отчётность' },
      'CRPV-232': { businessName: 'Годовой отчёт по продажам', parentExisting: 'Отчётность' },
    });
    try {
      // Обе строки с датой: эвристика target-колонки тоже контентная (≥0.6).
      const xlsx = makeXlsx(testInfo, 'backlog-edit-target.xlsx', [
        ['Issue key', 'Summary', 'Due date'],
        ['CRPV-231', 'Считать отчёт по продажам раз в месяц', '2027-05-10'],
        ['CRPV-232', 'Считать отчёт по продажам раз в год', '2028-11-02'],
      ]);
      await goToReview(page, xlsx);

      // Колонка называется «Срок реализации» (критерий 7, выверка).
      await expect(
        page
          .getByTestId('ai-backlog-review-step')
          .getByRole('columnheader', { name: 'Срок реализации' }),
      ).toBeVisible();

      // Префилл из файла: Q2 2027 + маркёр 📄.
      const row = reviewRow(page, 'r2');
      const quarter = row.getByTestId('ai-backlog-target-quarter-cell');
      const year = row.getByTestId('ai-backlog-target-year-cell');
      await expect(quarter).toHaveValue('Q2');
      await expect(year).toHaveValue('2027');
      await expect(row.getByTestId('ai-backlog-target-from-file')).toBeVisible();

      // Правка: квартал Q1, год 2031 → 📄 исчез, бейдж «изменено» появился.
      await quarter.selectOption('Q1');
      await year.fill('2031');
      await expect(quarter).toHaveValue('Q1');
      await expect(year).toHaveValue('2031');
      await expect(row.getByTestId('ai-backlog-target-from-file')).toHaveCount(0);
      await expect(row.getByTestId('ai-backlog-row-edited')).toBeVisible();

      const body = await clickApplyCapturingBody(page);
      expect(Object.keys(body.overrides ?? {})).toEqual(['r2']);
      expect(body.overrides!['r2']).toEqual({ targetQuarter: 'Q1', targetYear: 2031 });

      // Отчёт: колонка «Срок реализации» + отредактированное значение.
      await expect(page.getByTestId('ai-backlog-success')).toBeVisible(JOB_TIMEOUT);
      await expect(
        page.getByTestId('ai-backlog-report-table').getByRole('columnheader', {
          name: 'Срок реализации',
        }),
      ).toBeVisible();
      await expect(page.getByTestId('ai-backlog-report-table')).toContainText('Q1 2031');

      // API: target = новые значения.
      const reqs = await listRequirements(page, id);
      const created = reqs.find((r) => r.name === 'Ежемесячный отчёт по продажам')!;
      expect(created.implemented).toBe(false);
      expect(created.targetQuarter).toBe('Q1');
      expect(created.targetYear).toBe(2031);
    } finally {
      stub.setBacklogAnswers(null);
    }
  });
});

/* ══ 5 · Esc и «Вернуть предложенное»; дубль не редактируется ══════════════ */

test.describe('task25 · отмена правок и дубли', () => {
  test('Esc отменяет имя без бейджа; «Вернуть предложенное» снимает узел; дубль без редакторов; apply уходит без overrides', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'T25-Reset');
    await apiCreateRequirement(page, id, { kind: 'function', name: 'Отчёты' });
    await apiCreateRequirement(page, id, { kind: 'function', name: 'Другая ветка' });
    await apiCreateRequirement(page, id, { kind: 'function', name: 'Существующее требование' });

    stub.setBacklogAnswers({
      'CRPV-241': { businessName: 'Новая строка бэклога', parentExisting: 'Отчёты' },
      'CRPV-242': {
        businessName: 'Существующее требование',
        parentExisting: 'Отчёты',
        duplicateOf: 'Существующее требование',
      },
    });
    try {
      const xlsx = makeXlsx(testInfo, 'backlog-reset.xlsx', [
        ['Issue key', 'Summary'],
        ['CRPV-241', 'Совсем новая задача из бэклога'],
        ['CRPV-242', 'Задача, которая уже есть в дереве'],
      ]);
      await goToReview(page, xlsx);
      const row = reviewRow(page, 'r2');

      // Esc: правка имени отменена, значение прежнее, бейджа нет.
      await row.getByTestId('ai-backlog-edit-name').click();
      const input = row.getByTestId('ai-backlog-name-input');
      await input.fill('Черновик, который передумали');
      await input.press('Escape');
      await expect(row.getByTestId('ai-backlog-name-input')).toHaveCount(0);
      await expect(row.getByTestId('ai-backlog-edit-name')).toContainText('Новая строка бэклога');
      await expect(row.getByTestId('ai-backlog-row-edited')).toHaveCount(0);

      // Override узла → бейдж; «Вернуть предложенное» → бейдж исчез.
      await row.getByTestId('ai-backlog-edit-parent').click();
      await page.getByTestId('ai-backlog-parent-search').fill('другая');
      await page.getByTestId('ai-backlog-parent-option').first().click();
      await expect(row.getByTestId('ai-backlog-edit-parent')).toContainText('Другая ветка');
      await expect(row.getByTestId('ai-backlog-row-edited')).toBeVisible();
      await row.getByTestId('ai-backlog-edit-parent').click();
      await page.getByTestId('ai-backlog-parent-reset').click();
      await expect(row.getByTestId('ai-backlog-edit-parent')).toContainText('Отчёты');
      await expect(row.getByTestId('ai-backlog-row-edited')).toHaveCount(0);

      // Дубль-строка не редактируется: ни одного редактора, чекбокс disabled.
      const dupRow = reviewRow(page, 'r3');
      await expect(dupRow.getByTestId('ai-backlog-badge-duplicate')).toBeVisible();
      await expect(dupRow.getByTestId('ai-backlog-edit-name')).toHaveCount(0);
      await expect(dupRow.getByTestId('ai-backlog-edit-parent')).toHaveCount(0);
      await expect(dupRow.getByTestId('ai-backlog-target-quarter-cell')).toHaveCount(0);
      await expect(dupRow.getByTestId('ai-backlog-row-checkbox')).toBeDisabled();

      // Все правки сброшены → apply уходит БЕЗ overrides (обратная совместимость).
      const body = await clickApplyCapturingBody(page);
      expect(body.rowIds).toEqual(['r2']);
      expect(body.overrides).toBeUndefined();
      await expect(page.getByTestId('ai-backlog-success')).toBeVisible(JOB_TIMEOUT);

      // API: имя и родитель — предложенные моделью (сбросы сработали).
      const reqs = await listRequirements(page, id);
      const created = reqs.find((r) => r.name === 'Новая строка бэклога')!;
      expect(created).toBeDefined();
      const root = reqs.find((r) => r.name === 'Отчёты')!;
      expect(created.links.find((l) => l.type === 'CHILD_OF')?.targetSlug).toBe(root.slug);
      expect(reqs.filter((r) => r.name === 'Существующее требование')).toHaveLength(1);
      expect(reqs.some((r) => r.name === 'Черновик, который передумали')).toBe(false);
    } finally {
      stub.setBacklogAnswers(null);
    }
  });
});

/* ══ 6 · 400 на невалидный override: инлайн-ошибка, шаг живой ══════════════ */

test.describe('task25 · невалидный override', () => {
  test('год 2150 → 400 с текстом «год вне диапазона 2020–2100», шаг выверки жив, после исправления apply успешен', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'T25-Invalid');
    await apiCreateRequirement(page, id, { kind: 'function', name: 'Интеграции' });

    stub.setBacklogAnswers({
      'CRPV-251': { businessName: 'Интеграция с 1С', parentExisting: 'Интеграции' },
      'CRPV-252': { businessName: 'Интеграция с CRM', parentExisting: 'Интеграции' },
    });
    try {
      const xlsx = makeXlsx(testInfo, 'backlog-invalid.xlsx', [
        ['Issue key', 'Summary'],
        ['CRPV-251', 'Сделать интеграцию с 1С'],
        ['CRPV-252', 'Сделать интеграцию с CRM'],
      ]);
      await goToReview(page, xlsx);
      const row = reviewRow(page, 'r2');
      const year = row.getByTestId('ai-backlog-target-year-cell');

      // Год вне контракта 2020–2100 (UI не блокирует ввод — валидирует сервер).
      await year.fill('2150');
      await expect(row.getByTestId('ai-backlog-row-edited')).toBeVisible();
      const [res] = await Promise.all([
        page.waitForResponse(
          (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/apply'),
        ),
        page.getByTestId('ai-backlog-apply').click(),
      ]);
      expect(res.status()).toBe(400);

      // Инлайн-ошибка на русском, шаг выверки не сломан, правка на месте.
      await expect(page.getByTestId('ai-backlog-apply-error')).toBeVisible();
      await expect(page.getByTestId('ai-backlog-apply-error')).toContainText(
        'год вне диапазона 2020–2100',
      );
      await expect(page.getByTestId('ai-backlog-review-step')).toBeVisible();
      await expect(year).toHaveValue('2150');
      // Инвариант: после 400 в проект ничего не записано.
      expect(await listRequirements(page, id)).toHaveLength(1);

      // Исправляем год → повторный apply успешен, ошибка снята.
      await year.fill('2030');
      await page.getByTestId('ai-backlog-apply').click();
      await expect(page.getByTestId('ai-backlog-success')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-backlog-apply-error')).toHaveCount(0);

      const reqs = await listRequirements(page, id);
      const created = reqs.find((r) => r.name === 'Интеграция с 1С')!;
      expect(created.targetYear).toBe(2030);
    } finally {
      stub.setBacklogAnswers(null);
    }
  });
});
