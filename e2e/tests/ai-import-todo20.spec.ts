import AdmZip from 'adm-zip';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startAiStub, type AiStub } from './helpers/ai-stub.js';
import { createProject, projectIdFromUrl, rowByName, uniqueName } from './helpers/app.js';
import { expectAiImportSummary } from './helpers/ai-import.js';

/**
 * todo_20 · T-217 · E2E качества AI-импорта (спек .dev/design/todo20-spec.md §3):
 *
 *   1. Смета → подтверждение: порог сметы 0 («подтверждать всегда») через
 *      пресет модели → шаг сметы с описью/исключениями/оценкой, extraction-
 *      вызовы НЕ идут до подтверждения → «Запустить всё равно» → прогон →
 *      итоговый отчёт качества (покрытие, usage, слепые зоны).
 *   2. Смета → «Отмена»: джоба отменена бесплатно (0 вызовов), модалку можно
 *      запустить заново тем же файлом.
 *   3. Ошибка с таксономией: устойчивый 500 от AI Hub → NET-02 (код, действие,
 *      «уже создано», тех.детали, «Повторить с меньшими фрагментами»),
 *      ретраи видны в логе по-русски → «Продолжить» (resume) после
 *      восстановления мока → прогон до конца, дублей нет.
 *   4. История прогонов: ≥2 прогона → список со статусами, «Открыть» отчёт
 *      исторической джобы, ссылка на полный лог (attachment).
 *   5. Пресет: 4 новых run-control поля (parallelism / perCallTimeoutSec /
 *      runBudgetTokens / estimateThresholdTokens) — дефолты, override с
 *      перезагрузкой страницы, сброс к дефолту.
 *   6. Прогресс с содержанием: «фрагмент X из Y», текущий файл, ETA, живые
 *      счётчики (ФТ/НФТ/связи/токены) на медленном моке; события в логе.
 *
 * Kill-рестарт сервера (interrupted) сознательно НЕ дублируется здесь — он
 * закрыт интеграционными server-тестами (ai-import-resume, приёмки №3/№6b);
 * E2E-модалка interrupted требует рестарта общего webServer и сломала бы
 * изоляцию сьюта.
 *
 * Мок AI Hub — общий in-process стаб (helpers/ai-stub.ts) по паттерну
 * ai-import.spec.ts: extraction-ответы детерминированы по имени файла, каждый
 * успешный ответ несёт стабильный usage (120/45 токенов). Глобальный
 * .ai-config.json общий для всех spec-файлов, поэтому каждый тест настраивает
 * его явно и СБРАСЫВАЕТ свои пресет-оверрайды в finally.
 */

const MODEL = 'GigaChat-2-Pro'; // без выделенного пресета → generic-дефолты
const STUB_MODELS = ['Qwen-Coder-Next', MODEL];
const JOB_TIMEOUT = { timeout: 30_000 } as const;
/** NET-02 достигается после 6 попыток с backoff (~25–35 с с SDK-ретраями). */
const FAIL_TIMEOUT = { timeout: 90_000 } as const;

/** Generic-дефолты run-control полей (packages/core/src/validation/ai.ts). */
const RUN_DEFAULTS = {
  parallelism: '2',
  perCallTimeoutSec: '120',
  runBudgetTokens: '', // null → пустое поле («без лимита»)
  estimateThresholdTokens: '2000000',
} as const;

const FT_NOTES = 'Быстрый экспорт реестра в файл';
const NFR_MISC = 'Резервная копия создаётся ежедневно';
const FT_ERR = 'Импорт требований из внешнего файла';
const FT_BIG = 'Массовое редактирование записей реестра';

/** release-notes по контентной эвристике («Что нового», не по имени файла). */
const NOTES_DOC = [
  '# Что нового в 3.2',
  '',
  '- Быстрый экспорт реестра в файл одним действием.',
  '',
].join('\n');
/** Без эвристик и < 400 символов → класс other без LLM-триажа. */
const MISC_DOC = ['# Заметки', '', 'Резервная копия данных создаётся ежедневно.', ''].join('\n');
const ERR_DOC = ['# Импорт', '', 'Система должна уметь импортировать требования.', ''].join('\n');

let stub: AiStub;

test.beforeAll(async () => {
  stub = await startAiStub({ models: STUB_MODELS, reply: 'Стабовый ответ ассистента.' });
});

test.afterAll(async () => {
  await stub.close();
});

/** Глобальный ключ общий для spec-файлов — сбрасываем после каждого теста. */
test.afterEach(async ({ page }) => {
  await resetAiConfig(page);
});

/* ── Общие помощники (паттерн ai-import.spec.ts / ai-presets.spec.ts) ─────── */

async function resetAiConfig(page: Page): Promise<void> {
  const res = await page.request.put('/api/ai/config', { data: { apiKey: null } });
  if (!res.ok()) throw new Error(`PUT /api/ai/config {apiKey:null} failed (${res.status()})`);
}

async function configureAi(page: Page, projectId: string, model: string): Promise<void> {
  const res = await page.request.put('/api/ai/config', {
    data: { baseURL: stub.baseUrl, apiKey: 'sk-e2e-todo20-key', projectId, model },
  });
  if (!res.ok()) throw new Error(`PUT /api/ai/config failed (${res.status()})`);
}

/** Оверрайд пресета модели через официальный API (пустой объект = сброс). */
async function putPresetOverride(
  page: Page,
  model: string,
  override: Record<string, unknown>,
): Promise<void> {
  const res = await page.request.put('/api/ai/config', {
    data: { modelPresets: { [model]: override } },
  });
  if (!res.ok()) throw new Error(`PUT /api/ai/config modelPresets failed (${res.status()})`);
}

function makeZip(testInfo: TestInfo, name: string, files: Record<string, string | Buffer>): string {
  const zip = new AdmZip();
  for (const [entry, content] of Object.entries(files)) {
    zip.addFile(entry, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  }
  const target = testInfo.outputPath(name);
  zip.writeZip(target);
  return target;
}

async function openAiImport(page: Page): Promise<void> {
  await page.getByTestId('footer-ai-import').click();
  await expect(page.getByTestId('ai-import')).toBeVisible();
}

async function chooseFile(page: Page, archivePath: string): Promise<void> {
  await page.getByTestId('ai-import-file').setInputFiles(archivePath);
  await expect(page.getByTestId('ai-import-file-name')).toContainText(path.basename(archivePath));
}

/** «Начать анализ» → jobId из 202-ответа. */
async function startAnalysis(page: Page): Promise<string> {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/ai-import'),
    ),
    page.getByTestId('ai-import-start').click(),
  ]);
  expect(res.status()).toBe(202);
  return ((await res.json()) as { jobId: string }).jobId;
}

/** Свежий проект с настроенным AI; возвращает id проекта. */
async function projectWithAi(page: Page, prefix: string, model = MODEL): Promise<string> {
  await createProject(page, uniqueName(prefix));
  const id = projectIdFromUrl(page);
  await configureAi(page, id, model);
  await page.reload();
  await expect(page.getByTestId('main-page')).toBeVisible();
  return id;
}

async function jobStatus(page: Page, jobId: string): Promise<string> {
  const res = await page.request.get(`/api/ai-import/${encodeURIComponent(jobId)}`);
  if (!res.ok()) throw new Error(`GET job failed (${res.status()})`);
  return ((await res.json()) as { status: string }).status;
}

interface ReqDto {
  slug: string;
  name: string;
  type: string;
  links: Array<{ type: string; targetSlug: string }>;
}

async function listRequirements(page: Page, projectId: string): Promise<ReqDto[]> {
  const res = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/requirements`);
  if (!res.ok()) throw new Error(`GET requirements failed (${res.status()})`);
  return ((await res.json()) as { requirements: ReqDto[] }).requirements;
}

/* ══ 1 · Смета → подтверждение → прогон → отчёт ════════════════════════════ */

test.describe('todo_20 · смета и подтверждение', () => {
  test('порог 0: шаг сметы с описью и исключениями, LLM молчит до «Запустить всё равно», после — отчёт качества', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'T20-Est');
    await putPresetOverride(page, MODEL, { estimateThresholdTokens: 0 });
    stub.setExtractionItems({
      'notes.md': [
        {
          type: 'FUNCTION',
          name: FT_NOTES,
          description: 'Экспорт реестра в файл одним действием.',
          source: 'notes.md § Что нового в 3.2',
        },
      ],
      'misc.md': [
        {
          type: 'NFR',
          name: NFR_MISC,
          description: 'Резервная копия данных создаётся ежедневно.',
          source: 'misc.md § Заметки',
        },
      ],
    });
    try {
      const zip = makeZip(testInfo, 'docs-estimate.zip', {
        'notes.md': NOTES_DOC,
        'misc.md': MISC_DOC,
        'img/pixel.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
      });
      const callsBefore = stub.extractionRequests.length;

      await openAiImport(page);
      await chooseFile(page, zip);
      const jobId = await startAnalysis(page);

      // Шаг сметы: джоба ждёт подтверждения, extraction-вызовов НЕ было.
      await expect(page.getByTestId('ai-import-estimate-step')).toBeVisible(JOB_TIMEOUT);
      expect(await jobStatus(page, jobId)).toBe('awaiting-confirmation');
      expect(stub.extractionRequests.length).toBe(callsBefore);

      // Опись: классы определены по СОДЕРЖИМОМУ (release-notes + other).
      const inventory = page.getByTestId('ai-import-inventory');
      await expect(inventory).toBeVisible();
      await expect(inventory).toContainText('Опись архива');
      await expect(page.getByTestId('ai-import-inventory-release-notes')).toContainText('1');
      await expect(page.getByTestId('ai-import-inventory-other')).toContainText('1');

      // Исключения всегда с причиной (png — не текстовый формат).
      const excluded = page.getByTestId('ai-import-excluded');
      await expect(excluded).toBeVisible();
      await excluded.locator('summary').click();
      await expect(excluded).toContainText('*.png');
      await expect(excluded).toContainText('не текстовый формат документации');

      // Оценка: при пороге 0 — вариант-предупреждение и «Запустить всё равно».
      const warning = page.getByTestId('ai-import-estimate-warning');
      await expect(warning).toBeVisible();
      await expect(warning).toContainText('Оценка превышает порог подтверждения');
      await expect(warning).toContainText('AI-вызовов');
      const confirmBtn = page.getByTestId('ai-import-confirm-start');
      await expect(confirmBtn).toHaveText('Запустить всё равно');
      await testInfo.attach('estimate-step', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      // Подтверждаем — прогон идёт до успеха.
      await confirmBtn.click();
      await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
      const log = page.getByTestId('ai-import-log');
      await expect(log).toContainText('Смета подтверждена пользователем');
      await expectAiImportSummary(page, {
        functions: 1,
        nfrs: 1,
        treeLinks: 0,
        relatesLinks: 0,
        skipped: 0,
      });

      // Итоговый отчёт качества: покрытие по классам + usage + слепые зоны.
      await expect(page.getByTestId('ai-import-report')).toBeVisible();
      const coverage = page.getByTestId('ai-import-report-coverage');
      await expect(coverage).toBeVisible();
      await expect(page.getByTestId('ai-import-coverage-release-notes')).toContainText('1 / 1');
      await expect(page.getByTestId('ai-import-coverage-other')).toContainText('1 / 1');
      await expect(page.getByTestId('ai-import-blindspots')).toContainText('*.png');
      // Стаб отдаёт usage в каждом ответе → потрачено строго больше нуля.
      await expect(page.getByTestId('ai-import-usage')).toContainText(/Потрачено токенов: [1-9]/);
      await testInfo.attach('report', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      // Полный лог — файлом (Н4): attachment text/plain со строками стадий.
      const logHref = await page.getByTestId('ai-import-download-log').getAttribute('href');
      expect(logHref).toBeTruthy();
      const logRes = await page.request.get(logHref!);
      expect(logRes.status()).toBe(200);
      expect(logRes.headers()['content-type']).toContain('text/plain');
      expect(logRes.headers()['content-disposition']).toContain('attachment');
      expect(await logRes.text()).toContain('Смета прогона');

      await page.getByTestId('ai-import-done').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);
      await expect(rowByName(page, FT_NOTES)).toBeVisible();
      await expect(rowByName(page, NFR_MISC)).toBeVisible();

      // Требования созданы ровно по одному разу.
      const reqs = await listRequirements(page, id);
      expect(reqs.filter((r) => r.name === FT_NOTES)).toHaveLength(1);
      expect(reqs.filter((r) => r.name === NFR_MISC)).toHaveLength(1);
    } finally {
      stub.setExtractionItems(null);
      await putPresetOverride(page, MODEL, {});
    }
  });

  test('смета → «Отмена»: джоба отменена без AI-вызовов, модалка запускается заново тем же файлом', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'T20-EstCancel');
    await putPresetOverride(page, MODEL, { estimateThresholdTokens: 0 });
    stub.setExtractionItems({
      'notes.md': [
        {
          type: 'FUNCTION',
          name: FT_NOTES,
          description: 'Экспорт реестра в файл одним действием.',
          source: 'notes.md § Что нового в 3.2',
        },
      ],
    });
    try {
      const zip = makeZip(testInfo, 'docs-cancel.zip', { 'notes.md': NOTES_DOC });
      const callsBefore = stub.extractionRequests.length;

      await openAiImport(page);
      await chooseFile(page, zip);
      const firstJobId = await startAnalysis(page);
      await expect(page.getByTestId('ai-import-estimate-step')).toBeVisible(JOB_TIMEOUT);

      // «Отмена» на шаге сметы: бесплатно (LLM молчал), статус — cancelled.
      await page.getByTestId('ai-import-estimate-cancel').click();
      await expect(page.getByTestId('ai-import-cancelled')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-import-retry')).toBeVisible();
      await expect.poll(async () => jobStatus(page, firstJobId), JOB_TIMEOUT).toBe('cancelled');
      expect(stub.extractionRequests.length).toBe(callsBefore);

      // «Повторить анализ» возвращает setup с тем же файлом — запускаем снова.
      await page.getByTestId('ai-import-retry').click();
      const start = page.getByTestId('ai-import-start');
      await expect(start).toBeEnabled();
      const secondJobId = await startAnalysis(page);
      expect(secondJobId).not.toBe(firstJobId);
      await expect(page.getByTestId('ai-import-estimate-step')).toBeVisible(JOB_TIMEOUT);

      // Теперь подтверждаем — второй запуск доходит до успеха.
      await page.getByTestId('ai-import-confirm-start').click();
      await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
    } finally {
      stub.setExtractionItems(null);
      await putPresetOverride(page, MODEL, {});
    }
  });
});

/* ══ 2 · Ошибка с таксономией → resume без дублей ══════════════════════════ */

test.describe('todo_20 · ошибка NET-02 и «Продолжить»', () => {
  test('устойчивый 500: код NET-02, действие, «уже создано», тех.детали, ретраи в логе; resume доводит прогон, дублей нет', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000); // NET-02 = 6 попыток с backoff (~30 с) + resume
    const id = await projectWithAi(page, 'T20-Err');
    stub.setExtractionItems({
      'err.md': [
        {
          type: 'FUNCTION',
          name: FT_ERR,
          description: 'Импорт требований из внешнего файла.',
          source: 'err.md § Импорт',
        },
      ],
    });
    stub.setChatMode('error');
    try {
      const zip = makeZip(testInfo, 'docs-err.zip', { 'err.md': ERR_DOC });
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      // Таксономия (П6): человеческое сообщение + код + конкретное действие.
      const error = page.getByTestId('ai-import-error');
      await expect(error).toBeVisible(FAIL_TIMEOUT);
      await expect(page.getByTestId('ai-import-error-code')).toContainText('NET-02');
      await expect(error).toContainText(
        'Сервис AI недоступен или отвечает ошибкой сервера: повторы не помогли.',
      );
      await expect(error).toContainText('Что сделать:');
      await expect(error).toContainText('Проверьте доступность AI Hub');

      // «Уже создано» — счётчики видны даже при нуле (ничего не потеряно).
      await expect(page.getByTestId('ai-import-error-created')).toBeVisible();
      await expect(page.getByTestId('ai-import-error-created')).toContainText('ФТ');

      // Технические детали — сворачиваемый блок, не первая строка.
      const details = page.getByTestId('ai-import-error-details');
      await expect(details).toBeVisible();
      await details.locator('summary').click();
      await expect(details).toContainText('category: network');
      await expect(details).toContainText('resumable: true');

      // «Повторить с меньшими фрагментами» раскрывает how-to подсказку.
      await page.getByTestId('ai-import-smaller-chunks').click();
      await expect(page.getByTestId('ai-import-smaller-chunks-hint')).toContainText(
        'Размер фрагмента',
      );

      // Ретраи видны в журнале по-русски («Timeout/500» — не голое слово).
      const log = page.getByTestId('ai-import-log');
      await expect(log).toContainText('Повтор запроса к модели');
      await expect(log).toContainText('попытка');
      await testInfo.attach('error-taxonomy', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      // Мок «починился» → «Продолжить» (resume) — прогон доходит до конца.
      stub.setChatMode('ok');
      const [resumeRes] = await Promise.all([
        page.waitForResponse(
          (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/resume'),
        ),
        page.getByTestId('ai-import-resume').click(),
      ]);
      expect(resumeRes.status()).toBe(202);

      await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
      await expect(log).toContainText('Продолжаю прогон с контрольной точки');
      await expectAiImportSummary(page, {
        functions: 1,
        nfrs: 0,
        treeLinks: 0,
        relatesLinks: 0,
        skipped: 0,
      });

      // Дублей нет: требование создано ровно один раз.
      const reqs = await listRequirements(page, id);
      expect(reqs.filter((r) => r.name === FT_ERR)).toHaveLength(1);
      expect(reqs).toHaveLength(1);
    } finally {
      stub.setChatMode('ok');
      stub.setExtractionItems(null);
    }
  });
});

/* ══ 3 · История прогонов ══════════════════════════════════════════════════ */

test.describe('todo_20 · история прогонов', () => {
  test('после двух прогонов: строки со статусами, «Открыть» отчёт исторической джобы, ссылка на лог', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'T20-Hist');
    stub.setExtractionItems({
      'notes.md': [
        {
          type: 'FUNCTION',
          name: FT_NOTES,
          description: 'Экспорт реестра в файл одним действием.',
          source: 'notes.md § Что нового в 3.2',
        },
      ],
    });
    try {
      const zip = makeZip(testInfo, 'docs-hist.zip', { 'notes.md': NOTES_DOC });

      // Прогон 1 — успех (порог дефолтный 2 млн → без гейта).
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);
      await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
      await page.getByTestId('ai-import-done').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);

      // Прогон 2 — отменён на шаге сметы (порог 0).
      await putPresetOverride(page, MODEL, { estimateThresholdTokens: 0 });
      await openAiImport(page);
      await chooseFile(page, zip);
      const cancelledJobId = await startAnalysis(page);
      await expect(page.getByTestId('ai-import-estimate-step')).toBeVisible(JOB_TIMEOUT);
      await page.getByTestId('ai-import-estimate-cancel').click();
      await expect(page.getByTestId('ai-import-cancelled')).toBeVisible(JOB_TIMEOUT);
      await expect.poll(async () => jobStatus(page, cancelledJobId), JOB_TIMEOUT).toBe('cancelled');
      await page.getByTestId('ai-import-close').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);
      await putPresetOverride(page, MODEL, {});

      // Свежая модалка: история проекта со строками обоих прогонов.
      await openAiImport(page);
      const history = page.getByTestId('ai-import-history');
      await expect(history).toBeVisible(JOB_TIMEOUT);
      await expect(history).toContainText('Прошлые прогоны — 2');
      await history.locator('summary').click();

      const rows = page.getByTestId('ai-import-history-row');
      await expect(rows).toHaveCount(2);
      const succeededRow = page.locator(
        '[data-testid="ai-import-history-row"][data-status="succeeded"]',
      );
      const cancelledRow = page.locator(
        '[data-testid="ai-import-history-row"][data-status="cancelled"]',
      );
      await expect(succeededRow).toHaveCount(1);
      await expect(cancelledRow).toHaveCount(1);
      await expect(succeededRow).toContainText('Завершён');
      await expect(succeededRow).toContainText('1 ФТ · 0 НФТ');
      await expect(cancelledRow).toContainText('Остановлен');
      // Отменённая на смете джоба возобновима, успешная — нет.
      await expect(cancelledRow.getByTestId('ai-import-history-resume')).toBeVisible();
      await expect(succeededRow.getByTestId('ai-import-history-resume')).toHaveCount(0);
      await testInfo.attach('history', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      // Ссылка «Лог» исторической строки отдаёт полный лог файлом.
      const logHref = await succeededRow.getByTestId('ai-import-history-log').getAttribute('href');
      expect(logHref).toBeTruthy();
      const logRes = await page.request.get(logHref!);
      expect(logRes.status()).toBe(200);
      expect(logRes.headers()['content-disposition']).toContain('attachment');
      expect(await logRes.text()).toContain('[INFO]');

      // «Открыть» показывает отчёт/итоги исторической (успешной) джобы.
      await succeededRow.getByTestId('ai-import-history-open').click();
      await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
      await expectAiImportSummary(page, {
        functions: 1,
        nfrs: 0,
        treeLinks: 0,
        relatesLinks: 0,
        skipped: 0,
      });
      await expect(page.getByTestId('ai-import-report')).toBeVisible();
    } finally {
      stub.setExtractionItems(null);
      await putPresetOverride(page, MODEL, {});
    }
  });
});

/* ══ 4 · Run-control поля пресета модели ═══════════════════════════════════ */

test.describe('todo_20 · run-control поля пресета', () => {
  test('4 новых поля: дефолты, справка, override переживает перезагрузку, сброс к дефолту', async ({
    page,
  }) => {
    const id = await projectWithAi(page, 'T20-Preset');
    try {
      await page.goto(`/p/${id}/ai`);
      await expect(page.getByTestId('ai-page')).toBeVisible();
      const section = page.getByTestId('ai-preset-section');
      await expect(section).toBeVisible();
      await page.getByTestId('ai-preset-model-select').selectOption(MODEL);

      // Дефолты generic-пресета: 2 / 120 / «без лимита» / 2 000 000.
      await expect(page.getByTestId('ai-preset-parallelism')).toHaveValue(RUN_DEFAULTS.parallelism);
      await expect(page.getByTestId('ai-preset-perCallTimeoutSec')).toHaveValue(
        RUN_DEFAULTS.perCallTimeoutSec,
      );
      await expect(page.getByTestId('ai-preset-runBudgetTokens')).toHaveValue(
        RUN_DEFAULTS.runBudgetTokens,
      );
      await expect(page.getByTestId('ai-preset-estimateThresholdTokens')).toHaveValue(
        RUN_DEFAULTS.estimateThresholdTokens,
      );

      // Справка в стиле todo_18 у каждого нового поля («Влияет на:»).
      for (const param of [
        'parallelism',
        'perCallTimeoutSec',
        'runBudgetTokens',
        'estimateThresholdTokens',
      ]) {
        const help = page.getByTestId(`ai-preset-help-${param}`);
        await expect(help).toBeVisible();
        await expect(help).toContainText('Влияет на:');
      }

      // Оверрайды сохраняются и переживают перезагрузку страницы.
      await page.getByTestId('ai-preset-parallelism').fill('4');
      await page.getByTestId('ai-preset-perCallTimeoutSec').fill('60');
      await page.getByTestId('ai-preset-runBudgetTokens').fill('250000');
      await page.getByTestId('ai-preset-estimateThresholdTokens').fill('50000');
      await page.getByTestId('ai-preset-save').click();
      await expect(page.getByTestId('ai-preset-status')).toContainText('сохранены');

      await page.reload();
      await expect(page.getByTestId('ai-preset-section')).toBeVisible();
      await expect(page.getByTestId('ai-preset-model-select')).toHaveValue(MODEL);
      await expect(page.getByTestId('ai-preset-parallelism')).toHaveValue('4');
      await expect(page.getByTestId('ai-preset-perCallTimeoutSec')).toHaveValue('60');
      await expect(page.getByTestId('ai-preset-runBudgetTokens')).toHaveValue('250000');
      await expect(page.getByTestId('ai-preset-estimateThresholdTokens')).toHaveValue('50000');

      // «Сбросить к дефолту» возвращает дефолты (и чистит оверрайд на диске).
      await page.getByTestId('ai-preset-reset').click();
      await expect(page.getByTestId('ai-preset-status')).toContainText('сброшены');
      await page.reload();
      await expect(page.getByTestId('ai-preset-section')).toBeVisible();
      await expect(page.getByTestId('ai-preset-parallelism')).toHaveValue(RUN_DEFAULTS.parallelism);
      await expect(page.getByTestId('ai-preset-perCallTimeoutSec')).toHaveValue(
        RUN_DEFAULTS.perCallTimeoutSec,
      );
      await expect(page.getByTestId('ai-preset-runBudgetTokens')).toHaveValue(
        RUN_DEFAULTS.runBudgetTokens,
      );
      await expect(page.getByTestId('ai-preset-estimateThresholdTokens')).toHaveValue(
        RUN_DEFAULTS.estimateThresholdTokens,
      );
    } finally {
      await putPresetOverride(page, MODEL, {});
    }
  });
});

/* ══ 5 · Прогресс с содержанием ════════════════════════════════════════════ */

test.describe('todo_20 · прогресс с содержанием', () => {
  test('«фрагмент X из Y», текущий файл, ETA и живые счётчики на медленном моке; события фрагментов в логе', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'T20-Prog');
    // Большой файл-руководство (~40k символов → несколько фрагментов); класс
    // user-guide по контентной эвристике «Руководство пользователя».
    const bigLines: string[] = ['# Руководство пользователя', ''];
    for (let i = 1; bigLines.join('\n').length < 40_000; i++) {
      bigLines.push(
        `## Раздел ${i}`,
        `Пользователь может выполнять операцию ${i} над записями реестра требований.`,
        '',
      );
    }
    stub.setExtractionItems({
      'big.md': [
        {
          type: 'FUNCTION',
          name: FT_BIG,
          description: 'Массовое редактирование записей реестра.',
          source: 'big.md § Раздел 1',
        },
      ],
    });
    stub.setExtractionDelay(2000);
    try {
      const zip = makeZip(testInfo, 'docs-progress.zip', { 'big.md': bigLines.join('\n') });
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      // Содержательный прогресс (E3): этап + «фрагмент X из Y» + текущий файл.
      const stage = page.getByTestId('ai-import-stage');
      await expect(stage).toContainText('Извлечение требований', JOB_TIMEOUT);
      await expect(page.getByTestId('ai-import-chunk')).toContainText(
        /фрагмент \d+ из \d+/,
        JOB_TIMEOUT,
      );
      const current = page.getByTestId('ai-import-current');
      await expect(current).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-import-current-file')).toHaveText('big.md');
      await expect(current).toContainText('Руководства'); // класс источника
      // ETA (PO №6): до первых фрагментов «оценивается…», затем «осталось …».
      await expect(page.getByTestId('ai-import-eta')).toContainText(/оценивается|осталось/);

      // Живые счётчики прогона появляются после первого фрагмента (usage > 0).
      await expect(page.getByTestId('ai-import-counters')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-import-counter-tokens')).toContainText('токенов');
      await testInfo.attach('progress', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      // Прогон доходит до успеха; события фрагментов — в журнале.
      await expect(page.getByTestId('ai-import-success')).toBeVisible({ timeout: 60_000 });
      const log = page.getByTestId('ai-import-log');
      await expect(log).toContainText(/фрагмент \d+\/\d+\): извлечено/);
      await expect(log).toContainText('запрос к модели');

      await page.getByTestId('ai-import-done').click();
      await expect(rowByName(page, FT_BIG)).toBeVisible();
    } finally {
      stub.setExtractionDelay(0);
      stub.setExtractionItems(null);
    }
  });
});
