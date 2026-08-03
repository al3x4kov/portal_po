import path from 'node:path';
import AdmZip from 'adm-zip';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { startAiStub, type AiStub } from './helpers/ai-stub.js';
import { createProject, projectIdFromUrl, uniqueName } from './helpers/app.js';

/**
 * task24 · Модалка «AI-импорт документации» занимает ~70% экрана.
 *
 * Реализация: общий `Modal` получил проп `size='large'` (используется ТОЛЬКО
 * AiImportModal) — на десктопе (≥768px) карточка получает `md:w-[70vw]` и
 * `md:h-[max(70vh,min(640px,80vh))]` (на низких экранах высота упирается в
 * 640px/80vh, чтобы журналу оставалась свободная высота), тело
 * (`ai-import-body`) становится flex-колонкой, а журнал анализа
 * (`ai-import-log` внутри панели `ai-import-log-panel`) —
 * `grow shrink-0 basis-[170px] md:basis-[300px] min-h-[170px]`: на md+ он
 * всегда ≥300px и растягивается на свободный остаток. Ниже 768px поведение
 * прежнее (почти полная ширина, авто-высота, журнал у своего минимума ~170px).
 *
 * Сценарии (критерии приёмки task24):
 *   1. Десктоп 1280×800 — boundingBox карточки `ai-import` в коридоре 65–80%
 *      ширины И высоты вьюпорта на шагах setup, running и в отчёте (success).
 *   2. Десктоп — журнал в running/report заметно выше прежних 170px;
 *      role="log"/tabIndex сохранены (a11y).
 *   3. Мобильный 375×667 — модалка открывается, горизонтальный скролл не
 *      появляется, журнал остаётся у минимума (~170px).
 *   4. Регрессия — другие модалки НЕ увеличились: RequirementModal остаётся
 *      max-w-3xl (768px), т.е. заметно уже 70vw.
 *
 * AI hub — общий детерминированный стаб (helpers/ai-stub.ts), паттерн
 * ai-import.spec.ts: конфиг пишется через PUT /api/ai/config, running-окно
 * задаёт `setExtractionDelay`.
 */

const STUB_MODEL = 'Qwen-Coder-Next';
const JOB_TIMEOUT = { timeout: 30_000 } as const;

const DOCS: Record<string, string> = {
  'auth.md': [
    '# Авторизация',
    '',
    '## Вход',
    'Система должна позволять вход по логину и паролю.',
    '',
  ].join('\n'),
  'reports.md': [
    '# Отчёты',
    '',
    '## Производительность',
    'Формирование отчёта должно занимать не более 5 секунд.',
    '',
  ].join('\n'),
  'ops.md': ['# Эксплуатация', '', '## Логи', 'Логи должны ротироваться ежедневно.', ''].join('\n'),
};

const EXTRACTION_ITEMS: Record<string, unknown[]> = {
  'auth.md': [
    {
      type: 'FUNCTION',
      name: 'Вход по логину и паролю (size)',
      description: 'Система позволяет вход по логину и паролю.',
      source: 'auth.md § Вход',
    },
  ],
  'reports.md': [
    {
      type: 'NFR',
      name: 'Отчёт формируется не дольше 5 секунд (size)',
      description: 'Формирование отчёта занимает не более 5 секунд.',
      source: 'reports.md § Производительность',
    },
  ],
  'ops.md': [
    {
      type: 'NFR',
      name: 'Ротация логов ежедневно (size)',
      description: 'Логи ротируются ежедневно.',
      source: 'ops.md § Логи',
    },
  ],
};

let stub: AiStub;

test.beforeAll(async () => {
  stub = await startAiStub({
    models: [STUB_MODEL],
    reply: 'Стабовый ответ ассистента.',
    extractionItemsByFile: EXTRACTION_ITEMS,
  });
});

test.afterAll(async () => {
  await stub.close();
});

/* ── Local helpers (same discipline as ai-import.spec.ts) ─────────────────── */

/** Store key+baseURL (global) and the stub model for `projectId` via the API. */
async function configureAi(page: Page, projectId: string): Promise<void> {
  const res = await page.request.put('/api/ai/config', {
    data: { baseURL: stub.baseUrl, apiKey: 'sk-e2e-size-key', projectId, model: STUB_MODEL },
  });
  if (!res.ok()) throw new Error(`PUT /api/ai/config failed (${res.status()})`);
}

/** Build a zip archive from in-memory files; returns its on-disk path. */
function makeZip(testInfo: TestInfo, name: string, files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [entry, content] of Object.entries(files)) {
    zip.addFile(entry, Buffer.from(content, 'utf8'));
  }
  const target = testInfo.outputPath(name);
  zip.writeZip(target);
  return target;
}

/** Open the AI-import modal from the project footer. */
async function openAiImport(page: Page): Promise<void> {
  await page.getByTestId('footer-ai-import').click();
  await expect(page.getByTestId('ai-import')).toBeVisible();
}

/** Pick an archive through the hidden file input; the file card must appear. */
async function chooseFile(page: Page, archivePath: string): Promise<void> {
  await page.getByTestId('ai-import-file').setInputFiles(archivePath);
  await expect(page.getByTestId('ai-import-file-name')).toContainText(path.basename(archivePath));
}

/** Click «Начать анализ» and wait for the 202 job-start response. */
async function startAnalysis(page: Page): Promise<void> {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/ai-import'),
    ),
    page.getByTestId('ai-import-start').click(),
  ]);
  expect(res.status()).toBe(202);
}

/** Fresh project with AI configured (UI path); returns the project id. */
async function projectWithAi(page: Page, prefix: string): Promise<string> {
  await createProject(page, uniqueName(prefix));
  const id = projectIdFromUrl(page);
  await configureAi(page, id);
  await page.reload();
  await expect(page.getByTestId('main-page')).toBeVisible();
  return id;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Non-null bounding box of a locator (fails the test when detached/hidden). */
async function boxOf(locator: Locator, label: string): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `${label}: bounding box must exist`).not.toBeNull();
  return box!;
}

/** Assert `value/total` is within [min, max] (task24: 65–80% corridor). */
function expectRatio(value: number, total: number, min: number, max: number, label: string): void {
  const ratio = value / total;
  expect(
    ratio,
    `${label}: ${value}px of ${total}px = ${(ratio * 100).toFixed(1)}%`,
  ).toBeGreaterThanOrEqual(min);
  expect(
    ratio,
    `${label}: ${value}px of ${total}px = ${(ratio * 100).toFixed(1)}%`,
  ).toBeLessThanOrEqual(max);
}

/** Assert the `ai-import` card takes 65–80% of the viewport in BOTH dimensions. */
async function expectSeventyPercentCard(page: Page, step: string): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport, 'viewport must be set').not.toBeNull();
  const card = await boxOf(page.getByTestId('ai-import'), `ai-import card (${step})`);
  expectRatio(card.width, viewport!.width, 0.65, 0.8, `card width @ ${step}`);
  expectRatio(card.height, viewport!.height, 0.65, 0.8, `card height @ ${step}`);
}

/* ══ Сценарии 1–2 · десктоп 1280×800 (критерий приёмки task24) ════════════ */

test.describe('task24 · AI-импорт: модалка ~70% экрана (десктоп 1280×800)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('карточка модалки держит 65–80% ширины и высоты на setup, running и в отчёте', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'AiSize-Card');

    // Setup step: the card is already ~70% — the size comes from the Modal
    // variant, not from the phase-specific content.
    await openAiImport(page);
    await expect(page.getByTestId('ai-import-drop')).toBeVisible();
    await expectSeventyPercentCard(page, 'setup');

    // Running step: 3 files × 1.5 s per extraction call → a deterministic
    // running window for the poller (no sleeps).
    const zip = makeZip(testInfo, 'docs-size.zip', {
      'auth.md': DOCS['auth.md']!,
      'reports.md': DOCS['reports.md']!,
      'ops.md': DOCS['ops.md']!,
    });
    stub.setExtractionDelay(1500);
    try {
      await chooseFile(page, zip);
      await startAnalysis(page);
      await expect(page.getByTestId('ai-import-stop')).toBeVisible(JOB_TIMEOUT);
      await expectSeventyPercentCard(page, 'running');
    } finally {
      stub.setExtractionDelay(0);
    }

    // Report step (success view with the summary table): still 65–80%.
    await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
    await expect(page.getByTestId('ai-import-summary')).toBeVisible();
    await expectSeventyPercentCard(page, 'report');

    await page.getByTestId('ai-import-done').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);
  });

  test('журнал: пол 170px и a11y-контракт (role="log", tabindex) сохранены', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'AiSize-Log');

    const zip = makeZip(testInfo, 'docs-size-log.zip', {
      'auth.md': DOCS['auth.md']!,
      'reports.md': DOCS['reports.md']!,
      'ops.md': DOCS['ops.md']!,
    });
    stub.setExtractionDelay(1500);
    try {
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      const log = page.getByTestId('ai-import-log');
      await expect(page.getByTestId('ai-import-stop')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-import-log-panel')).toBeVisible();

      // The 170px floor is still declared (short content never collapses it),
      // and the running log never renders below it.
      const minHeight = await log.evaluate((el) => getComputedStyle(el).minHeight);
      expect(minHeight).toBe('170px');
      const runningBox = await boxOf(log, 'ai-import-log (running)');
      expect(runningBox.height, 'running log keeps its 170px floor').toBeGreaterThanOrEqual(169);

      // a11y contract survived the layout change (task24 acceptance).
      await expect(log).toHaveAttribute('role', 'log');
      await expect(log).toHaveAttribute('tabindex', '0');
    } finally {
      stub.setExtractionDelay(0);
    }

    // Report: the success view adds the summary above the log — the log may
    // shrink but never below its 170px floor, and it stays visible.
    await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
    const reportBox = await boxOf(page.getByTestId('ai-import-log'), 'ai-import-log (report)');
    expect(reportBox.height, 'report log keeps its 170px floor').toBeGreaterThanOrEqual(169);

    await page.getByTestId('ai-import-done').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);
  });

  test('на 800px-экране журнал в running заметно больше 170px (≥300px)', async ({
    page,
  }, testInfo) => {
    /*
     * Критерий приёмки task24 №2: «Журнал анализа занимает свободную высоту
     * (заметно больше 170px на 800px-экране)». Изначально карточка была
     * фиксирована на h-[70vh] = 560px при 1280×800, и контент running-вида
     * съедал весь бюджет — журналу оставалось 170–183px (дефект, был
     * задокументирован здесь через test.fail()).
     *
     * Фикс фронтенда: карточка large-модалки теперь
     * `md:h-[max(70vh,min(640px,80vh))]` (на 1280×800 → 640px = 80% высоты,
     * верхняя граница коридора 65–80 включительно), а журнал получил
     * `grow shrink-0 basis-[170px] md:basis-[300px]` — на md+ он всегда
     * ≥300px независимо от наполнения соседних блоков.
     */
    await projectWithAi(page, 'AiSize-LogBudget');
    const zip = makeZip(testInfo, 'docs-size-budget.zip', {
      'auth.md': DOCS['auth.md']!,
      'reports.md': DOCS['reports.md']!,
      'ops.md': DOCS['ops.md']!,
    });
    stub.setExtractionDelay(1500);
    try {
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);
      await expect(page.getByTestId('ai-import-stop')).toBeVisible(JOB_TIMEOUT);
      const box = await boxOf(page.getByTestId('ai-import-log'), 'ai-import-log (running @800px)');
      expect(
        box.height,
        `running log @1280×800 is ${box.height}px — acceptance wants «заметно больше 170px»`,
      ).toBeGreaterThanOrEqual(300);
    } finally {
      stub.setExtractionDelay(0);
    }
  });
});

/* ══ Сценарий 2b · механизм растяжения журнала (1280×1024) ════════════════ */

test.describe('task24 · журнал растягивается на свободную высоту (десктоп 1280×1024)', () => {
  // Suite-default desktop viewport: 70vh = 716px card → the running view has
  // real free height, so flex-1 must stretch the log WELL above the 170px floor.
  test.use({ viewport: { width: 1280, height: 1024 } });

  test('в running журнал заметно выше 170px (flex-1 забирает свободный остаток)', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'AiSize-LogStretch');

    const zip = makeZip(testInfo, 'docs-size-stretch.zip', {
      'auth.md': DOCS['auth.md']!,
      'reports.md': DOCS['reports.md']!,
      'ops.md': DOCS['ops.md']!,
    });
    stub.setExtractionDelay(1500);
    try {
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);
      await expect(page.getByTestId('ai-import-stop')).toBeVisible(JOB_TIMEOUT);

      const box = await boxOf(page.getByTestId('ai-import-log'), 'ai-import-log (running @1024)');
      expect(
        box.height,
        `running log @1280×1024 is ${box.height}px — must be noticeably above the 170px floor`,
      ).toBeGreaterThanOrEqual(300);
    } finally {
      stub.setExtractionDelay(0);
    }

    await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
    await page.getByTestId('ai-import-done').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);
  });
});

/* ══ Сценарий 3 · мобильный вьюпорт 375×667 — без регресса ════════════════ */

test.describe('task24 · AI-импорт: мобильный вьюпорт 375×667 без регресса', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('модалка открывается, горизонтального скролла нет, журнал остаётся ~170px', async ({
    page,
  }, testInfo) => {
    // The project is seeded through the API (the mobile layout is not the
    // subject here); the page then opens the main screen directly.
    const created = await page.request.post('/api/projects', {
      data: { name: uniqueName('AiSize-Mobile') },
    });
    expect(created.status()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    await configureAi(page, id);
    await page.goto(`/p/${encodeURIComponent(id)}`);
    await expect(page.getByTestId('main-page')).toBeVisible();

    // Baseline horizontal overflow of the page BEFORE the modal (the tree
    // table behind may overflow on 375px on its own — not task24's subject).
    const overflowBefore = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    await openAiImport(page);

    // The card fits the viewport width (near-full width, p-4 overlay padding)
    // and opening the modal adds NO horizontal scroll.
    const card = await boxOf(page.getByTestId('ai-import'), 'ai-import card (mobile)');
    expect(card.x, 'card left edge inside the viewport').toBeGreaterThanOrEqual(0);
    expect(card.x + card.width, 'card right edge inside the viewport').toBeLessThanOrEqual(375);
    expect(card.width, 'near-full width on mobile').toBeGreaterThanOrEqual(0.85 * 375);
    const overflowWithModal = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowWithModal, 'modal must not add horizontal scroll').toBeLessThanOrEqual(
      Math.max(overflowBefore, 0),
    );

    // Neither the card nor its body overflows horizontally on the inside.
    for (const testid of ['ai-import', 'ai-import-body']) {
      const inner = await page
        .getByTestId(testid)
        .evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(inner, `${testid} has no internal horizontal overflow`).toBeLessThanOrEqual(1);
    }

    // Run the job to reach the running view — on mobile the log must stay at
    // its old ~170px minimum (the 70vh/flex stretch is md-only).
    const zip = makeZip(testInfo, 'docs-size-mobile.zip', {
      'auth.md': DOCS['auth.md']!,
      'reports.md': DOCS['reports.md']!,
      'ops.md': DOCS['ops.md']!,
    });
    stub.setExtractionDelay(1500);
    try {
      await chooseFile(page, zip);
      await startAnalysis(page);
      await expect(page.getByTestId('ai-import-stop')).toBeVisible(JOB_TIMEOUT);

      const log = await boxOf(page.getByTestId('ai-import-log'), 'ai-import-log (mobile running)');
      expect(log.height, 'mobile log stays at its ~170px minimum').toBeGreaterThanOrEqual(165);
      expect(log.height, 'mobile log must NOT stretch like on desktop').toBeLessThanOrEqual(300);

      // Still no horizontal scroll while the busiest view is on screen.
      const overflowRunning = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflowRunning, 'running view adds no horizontal scroll').toBeLessThanOrEqual(
        Math.max(overflowBefore, 0),
      );
    } finally {
      stub.setExtractionDelay(0);
    }

    await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
    await page.getByTestId('ai-import-done').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);
  });
});

/* ══ Сценарий 4 · регрессия: другие модалки НЕ увеличились ════════════════ */

test.describe('task24 · регрессия размеров других модалок', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('RequirementModal остаётся прежней ширины (max-w-3xl, а не 70vw)', async ({ page }) => {
    await createProject(page, uniqueName('AiSize-Regress'));

    await page.getByTestId('add-function').click();
    const modal = page.getByTestId('requirement-modal');
    await expect(modal).toBeVisible();

    // max-w-3xl = 768px; the large variant would be 70vw = 896px @1280.
    const box = await boxOf(modal, 'requirement-modal');
    expect(box.width, 'width capped by max-w-3xl (768px)').toBeLessThanOrEqual(770);
    expect(box.width, 'still the full 768px cap, not shrunk').toBeGreaterThanOrEqual(700);
    expect(
      box.width / 1280,
      'must stay clearly below the 65% floor of the large variant',
    ).toBeLessThan(0.65);

    // The default variant never carries the task24 desktop size classes.
    const className = await modal.evaluate((el) => el.className);
    expect(className).not.toContain('70vw');
    expect(className).not.toContain('70vh');

    await page.getByTestId('req-cancel').click();
    await expect(modal).toBeHidden();
  });
});
