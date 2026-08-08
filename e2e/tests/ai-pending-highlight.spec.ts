import path from 'node:path';
import AdmZip from 'adm-zip';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startAiStub, type AiStub } from './helpers/ai-stub.js';
import {
  addRequirement,
  createProject,
  linkRequirements,
  openEdit,
  projectIdFromUrl,
  rowByName,
  setTreeMode,
  uniqueName,
} from './helpers/app.js';
import { approveDocsReviewGates } from './helpers/ai-import.js';
import { BACKLOG_JOB_TIMEOUT, goToReview, makeXlsx } from './helpers/backlog.js';

/**
 * task26 · E2E «подсветка непроверенных ИИ-требований» (критерии приёмки 1–5).
 *
 * Признак «создано ИИ, не проверено» производный: `origin != null &&
 * aiValidated !== true` (ядро — `isAiPendingReview`). Клиент выставить `origin`
 * НЕ может (сервер его срезает), поэтому единственный способ получить
 * подсвеченное требование в E2E — реальный AI-импорт на мок-модели:
 *
 *  - документный импорт (`footer-ai-import`) → `origin: 'AI_DOCS'`;
 *  - импорт бэклога (`footer-ai-backlog-import`) → `origin: 'AI_BACKLOG'`,
 *    включая бизнес-узлы, которые импорт создаёт сам.
 *
 * Внешний AI Hub заменён общим стабом (`helpers/ai-stub.ts`): ответы
 * детерминированы по имени файла (документы) и по ключу строки (бэклог), так
 * что все ожидания — web-first, без пауз.
 *
 * Изоляция: у каждого теста свой проект с уникальным именем; глобальный ключ
 * AI-конфига сбрасывается в `afterEach` (он общий для всех spec-файлов).
 */

const MODEL = 'Qwen-Coder-Next';
const STUB_MODELS = [MODEL, 'GigaChat-2-Pro'];
const JOB_TIMEOUT = { timeout: 30_000 } as const;

/* ── Детерминированные фикстуры документного импорта ──────────────────────── */

const REQ_LOGIN = 'task26 · Вход по логину и паролю';
const REQ_RESET = 'task26 · Восстановление пароля';
const NFR_REPORT = 'task26 · Отчёт формируется за 5 секунд';

/** Три требования из двух файлов: ФТ-корень, ФТ-ребёнок и НФТ. */
const DOCS: Record<string, string> = {
  'auth.md': '# Авторизация\n\n## Вход\nВход по логину и паролю.\n\n## Сброс\nСброс пароля.\n',
  'reports.md': '# Отчёты\n\n## Скорость\nОтчёт формируется не дольше 5 секунд.\n',
};

const EXTRACTION_ITEMS: Record<string, unknown[]> = {
  'auth.md': [
    {
      type: 'FUNCTION',
      name: REQ_LOGIN,
      description: 'Система позволяет вход по логину и паролю.',
      source: 'auth.md § Вход',
    },
    {
      type: 'FUNCTION',
      name: REQ_RESET,
      description: 'Система позволяет восстановить пароль.',
      source: 'auth.md § Сброс',
    },
  ],
  'reports.md': [
    {
      type: 'NFR',
      name: NFR_REPORT,
      description: 'Формирование отчёта занимает не более 5 секунд.',
      source: 'reports.md § Скорость',
    },
  ],
};

let stub: AiStub;

test.beforeAll(async () => {
  stub = await startAiStub({
    models: STUB_MODELS,
    reply: 'Стабовый ответ ассистента.',
    extractionItemsByFile: EXTRACTION_ITEMS,
    // Дерево импорта: «Восстановление пароля» — ребёнок «Входа».
    structureParents: { [REQ_RESET]: REQ_LOGIN },
  });
});

test.afterAll(async () => {
  await stub.close();
});

test.afterEach(async ({ page }) => {
  const res = await page.request.put('/api/ai/config', { data: { apiKey: null } });
  if (!res.ok()) throw new Error(`PUT /api/ai/config {apiKey:null} failed (${res.status()})`);
});

/* ── Помощники ────────────────────────────────────────────────────────────── */

async function configureAi(page: Page, projectId: string): Promise<void> {
  const res = await page.request.put('/api/ai/config', {
    data: { baseURL: stub.baseUrl, apiKey: 'sk-e2e-task26-key', projectId, model: MODEL },
  });
  if (!res.ok()) throw new Error(`PUT /api/ai/config failed (${res.status()})`);
}

/** Свежий проект с настроенным AI Hub; возвращает id проекта. */
async function projectWithAi(page: Page, prefix: string): Promise<string> {
  await createProject(page, uniqueName(prefix));
  const id = projectIdFromUrl(page);
  await configureAi(page, id);
  await page.reload(); // подхватить конфиг AI в UI
  await expect(page.getByTestId('main-page')).toBeVisible();
  return id;
}

function makeZip(testInfo: TestInfo, name: string, files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [entry, content] of Object.entries(files)) {
    zip.addFile(entry, Buffer.from(content, 'utf8'));
  }
  const target = testInfo.outputPath(name);
  zip.writeZip(target);
  return target;
}

/** Требование в ответе API — интересуют только поля происхождения. */
interface ReqDto {
  slug: string;
  name: string;
  type: string;
  origin?: string;
  aiValidated?: boolean;
}

async function listReqs(page: Page, projectId: string): Promise<ReqDto[]> {
  const res = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/requirements`);
  if (!res.ok()) throw new Error(`GET requirements failed (${res.status()})`);
  return ((await res.json()) as { requirements: ReqDto[] }).requirements;
}

/**
 * Полный документный импорт фикстуры DOCS: модалка → архив → анализ → «Готово».
 * На выходе в проекте 2 ФТ + 1 НФТ, созданные ИИ.
 */
async function runDocsImport(page: Page, testInfo: TestInfo): Promise<void> {
  await page.getByTestId('footer-ai-import').click();
  await expect(page.getByTestId('ai-import')).toBeVisible();
  const zip = makeZip(testInfo, 'task26-docs.zip', DOCS);
  await page.getByTestId('ai-import-file').setInputFiles(zip);
  await expect(page.getByTestId('ai-import-file-name')).toContainText(path.basename(zip));
  await page.getByTestId('ai-import-start').click();
  // Двухзонная выверка дублей: одобряем обе зоны (select-all → apply).
  await approveDocsReviewGates(page);
  await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
  await page.getByTestId('ai-import-done').click();
  await expect(page.getByTestId('ai-import')).toHaveCount(0);
  await setTreeMode(page, 'expand-all');
}

/** Строка дерева подсвечена как «ИИ, не проверено» + доступный бейдж. */
async function expectPending(page: Page, name: string): Promise<void> {
  const row = rowByName(page, name);
  await expect(row, `строка «${name}» видна`).toBeVisible();
  await expect(row, `строка «${name}» подсвечена`).toHaveAttribute('data-ai-pending', 'true');
  const badge = row.getByTestId('ai-pending-badge');
  await expect(badge, `бейдж «ИИ» у «${name}»`).toBeVisible();
  await expect(badge).toHaveAttribute('aria-label', 'Создано ИИ, не проверено');
  await expect(badge).toHaveAttribute('title', 'Создано ИИ, не проверено');
  const slug = (await row.getAttribute('data-testid'))!.replace(/^tree-row-/, '');
  await expect(badge).toHaveAttribute('data-slug', slug);
}

/** Строка дерева выглядит как обычная: ни атрибута подсветки, ни бейджа. */
async function expectNotPending(page: Page, name: string): Promise<void> {
  const row = rowByName(page, name);
  await expect(row, `строка «${name}» видна`).toBeVisible();
  await expect(row, `строка «${name}» без подсветки`).not.toHaveAttribute('data-ai-pending');
  await expect(row.getByTestId('ai-pending-badge')).toHaveCount(0);
}

/** Счётчик «Не проверено: N» в панели фильтров. */
async function expectPendingCount(page: Page, n: number): Promise<void> {
  const counter = page.getByTestId('ai-pending-count');
  await expect(counter).toBeVisible();
  await expect(counter).toHaveAttribute('data-count', String(n));
  await expect(counter).toContainText(`Не проверено: ${n}`);
}

/* ══ 1 · Импорт документации ══════════════════════════════════════════════ */

test.describe('task26 · подсветка после AI-импорта', () => {
  test('импорт документации: созданные ФТ/НФТ подсвечены, с бейджем «ИИ» и в счётчике', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'T26-Docs');

    await runDocsImport(page, testInfo);

    // AC1: каждое созданное требование подсвечено и помечено бейджем.
    for (const name of [REQ_LOGIN, REQ_RESET, NFR_REPORT]) {
      await expectPending(page, name);
    }
    // Счётчик равен числу созданных импортом требований.
    await expectPendingCount(page, 3);

    // API-контракт: origin = AI_DOCS, отметки проверки ещё нет.
    const reqs = await listReqs(page, id);
    expect(reqs).toHaveLength(3);
    for (const req of reqs) {
      expect(req.origin, `origin «${req.name}»`).toBe('AI_DOCS');
      expect(req.aiValidated ?? false, `aiValidated «${req.name}»`).toBe(false);
    }
  });

  /* ══ 2 · Импорт бэклога (строки + созданный импортом узел) ═══════════════ */

  test('импорт бэклога: подсвечены и строки, и созданный импортом узел; ручной корень — нет', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'T26-Backlog');
    const manualRoot = uniqueName('T26-Ручной-корень');
    await addRequirement(page, { kind: 'function', name: manualRoot });

    const ROW_FT = 'task26 · Выгрузка отчёта в PDF';
    const NEW_NODE = 'task26 · Надёжность хранения';
    const ROW_NFR = 'task26 · Ежедневное резервное копирование';

    stub.setBacklogAnswers({
      'T26-1': { businessName: ROW_FT, parentExisting: manualRoot },
      'T26-2': {
        businessName: ROW_NFR,
        type: 'NFR',
        parentNew: { name: NEW_NODE, parentName: null },
      },
    });
    try {
      const xlsx = makeXlsx(testInfo, 'task26-backlog.xlsx', [
        ['Issue key', 'Summary', 'Due date'],
        ['T26-1', 'Сделать выгрузку отчёта в PDF', '2027-05-10'],
        ['T26-2', 'Настроить резервное копирование каждый день', undefined],
      ]);

      await goToReview(page, xlsx);
      await page.getByTestId('ai-backlog-apply').click();
      await expect(page.getByTestId('ai-backlog-success')).toBeVisible(BACKLOG_JOB_TIMEOUT);
      await page.getByTestId('ai-backlog-done').click();
      await expect(page.getByTestId('ai-backlog-import')).toHaveCount(0);
      await setTreeMode(page, 'expand-all');

      // AC2: строки бэклога И бизнес-узел, созданный самим импортом.
      await expectPending(page, ROW_FT);
      await expectPending(page, ROW_NFR);
      await expectPending(page, NEW_NODE);
      // Требование, созданное человеком до импорта, не трогаем.
      await expectNotPending(page, manualRoot);
      await expectPendingCount(page, 3);

      // API-контракт: origin = AI_BACKLOG у всех трёх (включая узел).
      const byName = new Map((await listReqs(page, id)).map((r) => [r.name, r]));
      for (const name of [ROW_FT, ROW_NFR, NEW_NODE]) {
        expect(byName.get(name)?.origin, `origin «${name}»`).toBe('AI_BACKLOG');
        expect(byName.get(name)?.aiValidated ?? false).toBe(false);
      }
      expect(byName.get(manualRoot)?.origin, 'у ручного требования origin отсутствует').toBe(
        undefined,
      );
    } finally {
      stub.setBacklogAnswers(null);
    }
  });
});

/* ══ 3–4 · Карточка: снятие отметки и возврат ═════════════════════════════ */

test.describe('task26 · отметка «Проверено» в карточке', () => {
  test('включение отметки снимает подсветку без перезагрузки, выключение — возвращает', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'T26-Toggle');
    await runDocsImport(page, testInfo);
    await expectPendingCount(page, 3);

    /* ── Шаг 1 (AC3): отмечаем «Проверено» ────────────────────────────────── */

    let modal = await openEdit(page, REQ_LOGIN);
    const block = page.getByTestId('req-ai-review-block');
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute('data-origin', 'AI_DOCS');
    await expect(block).toHaveAttribute('data-validated', 'false');
    await expect(page.getByTestId('req-ai-origin')).toHaveText('ИИ-импорт из документации');
    await expect(page.getByTestId('req-ai-validated-hint')).toContainText(
      'создано ИИ и ещё не проверено',
    );

    const toggle = page.getByTestId('req-ai-validated-toggle');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(block).toHaveAttribute('data-validated', 'true');
    await expect(page.getByTestId('req-ai-validated-hint')).toContainText(
      'отмечено как проверенное',
    );

    await page.getByTestId('req-submit').click();
    await expect(modal).toBeHidden();

    // Подсветка и бейдж уходят прямо в открытом дереве (без reload).
    await expectNotPending(page, REQ_LOGIN);
    // Остальные ИИ-требования остались подсвеченными, счётчик минус один.
    await expectPending(page, REQ_RESET);
    await expectPending(page, NFR_REPORT);
    await expectPendingCount(page, 2);

    // API: отметка сохранена, происхождение не потеряно.
    const afterCheck = (await listReqs(page, id)).find((r) => r.name === REQ_LOGIN);
    expect(afterCheck?.aiValidated).toBe(true);
    expect(afterCheck?.origin).toBe('AI_DOCS');

    /* ── Шаг 2 (AC3, обратимость): снимаем отметку ────────────────────────── */

    modal = await openEdit(page, REQ_LOGIN);
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute('data-validated', 'true');
    const toggleBack = page.getByTestId('req-ai-validated-toggle');
    await expect(toggleBack).toBeChecked();
    await toggleBack.uncheck();
    await page.getByTestId('req-submit').click();
    await expect(modal).toBeHidden();

    await expectPending(page, REQ_LOGIN);
    await expectPendingCount(page, 3);

    const afterUncheck = (await listReqs(page, id)).find((r) => r.name === REQ_LOGIN);
    expect(afterUncheck?.aiValidated).toBe(false);
    expect(afterUncheck?.origin).toBe('AI_DOCS');
  });

  /* ══ 5 · Требование, созданное вручную ═════════════════════════════════ */

  test('созданное вручную требование: без подсветки, без блока «Проверка», счётчик скрыт', async ({
    page,
  }) => {
    const id = await projectWithAi(page, 'T26-Manual');
    const manual = uniqueName('T26-Ручное-требование');
    await addRequirement(page, { kind: 'function', name: manual });

    await expectNotPending(page, manual);
    // Непроверенных нет → счётчик и не отрисован.
    await expect(page.getByTestId('ai-pending-count')).toHaveCount(0);

    const modal = await openEdit(page, manual);
    await expect(page.getByTestId('req-ai-review-block')).toHaveCount(0);
    await expect(page.getByTestId('req-ai-validated-toggle')).toHaveCount(0);
    await page.getByTestId('req-cancel').click();
    await expect(modal).toBeHidden();

    const req = (await listReqs(page, id)).find((r) => r.name === manual);
    expect(req?.origin).toBeUndefined();
  });
});

/* ══ 6 · Фильтр «Только непроверенные (ИИ)» ═══════════════════════════════ */

test.describe('task26 · фильтр «Только непроверенные (ИИ)»', () => {
  test('фильтр оставляет непроверенные + предков, комбинируется с поиском, счётчик кликабелен', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'T26-Filter');
    const manualParent = uniqueName('T26-Ручной-родитель');
    await addRequirement(page, { kind: 'function', name: manualParent });
    await runDocsImport(page, testInfo);

    // Подвешиваем ИИ-корень под ручное требование: у фильтра появляется предок,
    // который сам под условие не подходит и обязан остаться как «контекст».
    await linkRequirements(page, REQ_LOGIN, 'CHILD_OF', manualParent);
    await expect(rowByName(page, REQ_LOGIN)).toBeVisible();

    const filter = page.getByTestId('filter-ai-pending');
    await expect(filter).toHaveAttribute('aria-pressed', 'false');
    await expect(filter).toHaveAttribute('data-active', 'false');

    /* ── Включение фильтра ────────────────────────────────────────────────── */

    await filter.click();
    await expect(filter).toHaveAttribute('aria-pressed', 'true');
    await expect(filter).toHaveAttribute('data-active', 'true');

    // Непроверенные ИИ-строки — совпадения; ручной предок остаётся контекстом.
    for (const name of [REQ_LOGIN, REQ_RESET, NFR_REPORT]) {
      await expect(rowByName(page, name)).toHaveAttribute('data-row-kind', 'match');
    }
    await expect(rowByName(page, manualParent)).toHaveAttribute('data-row-kind', 'context');
    await expect(
      rowByName(page, manualParent).locator('[data-testid^="ancestor-label-"]'),
    ).toBeVisible();
    // Счётчик — общий по проекту, фильтр его не уменьшает.
    await expectPendingCount(page, 3);

    /* ── Комбинация с поиском (пересечение, без «сирот») ─────────────────── */

    await page.getByTestId('search-input').fill(REQ_RESET);
    await expect(rowByName(page, REQ_RESET)).toHaveAttribute('data-row-kind', 'match');
    // Оба предка «Восстановления» остаются контекстом, посторонние — скрыты.
    await expect(rowByName(page, REQ_LOGIN)).toHaveAttribute('data-row-kind', 'context');
    await expect(rowByName(page, manualParent)).toHaveAttribute('data-row-kind', 'context');
    await expect(rowByName(page, NFR_REPORT)).toBeHidden();
    await expect(filter).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('search-input').fill('');
    await expect(rowByName(page, NFR_REPORT)).toBeVisible();

    /* ── Сброс фильтров выключает и этот фильтр ──────────────────────────── */

    await page.getByTestId('toolbar-reset-filters').click();
    await expect(filter).toHaveAttribute('aria-pressed', 'false');
    await expect(rowByName(page, manualParent)).toHaveAttribute('data-row-kind', 'match');

    /* ── Клик по счётчику включает фильтр ────────────────────────────────── */

    await page.getByTestId('ai-pending-count').click();
    await expect(filter).toHaveAttribute('aria-pressed', 'true');
    await expect(rowByName(page, manualParent)).toHaveAttribute('data-row-kind', 'context');
    await expect(rowByName(page, REQ_LOGIN)).toHaveAttribute('data-row-kind', 'match');

    /* ── Снятие отметки убирает строку из выборки фильтра ────────────────── */

    const modal = await openEdit(page, NFR_REPORT);
    await page.getByTestId('req-ai-validated-toggle').check();
    await page.getByTestId('req-submit').click();
    await expect(modal).toBeHidden();

    await expect(rowByName(page, NFR_REPORT)).toBeHidden();
    await expectPendingCount(page, 2);
  });
});
