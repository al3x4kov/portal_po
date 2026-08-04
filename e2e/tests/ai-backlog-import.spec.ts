import AdmZip from 'adm-zip';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  backlogBatchOf,
  BACKLOG_DEFAULT_NEW_NODE,
  jsonSchemaNameOf,
  startAiStub,
  type AiStub,
} from './helpers/ai-stub.js';
import {
  apiCreateRequirement,
  createProject,
  projectIdFromUrl,
  rowByName,
  setTreeMode,
  uniqueName,
} from './helpers/app.js';

/**
 * todo_22 · T-307 · E2E полного потока «AI подгрузка из бэклога» на мок-модели
 * (спек .dev/design/todo22-backlog-spec.md §3, решения PO §6):
 *
 * 1. Happy-path: xlsx → предпросмотр (чипы колонок, строки, target с дефолтом
 *    «следующий квартал») → «Начать анализ» → прогресс (этап/бар/счётчики) →
 *    выверка (новые узлы, снятие одной строки) → «Записать в проект (N)» →
 *    отчёт (deselected=1) → в дереве новые узлы/требования; источник BACKLOG
 *    «Бэклог: <файл>», исходная формулировка и ключ — в описании (API).
 *    Инвариант PO №1: ДО apply список требований проекта не меняется.
 * 2. Дубль (duplicateOf существующего): чекбокс строки disabled + бейдж;
 *    после apply дубль НЕ создан (API-подсчёт по имени).
 * 3. Сбой модели на середине match (мок: 500 после 1-го вызова) → ошибка с
 *    кодом NET-02 и «батч 2 из 2» → «Продолжить» → выверка достигнута; после
 *    resume отправлен РОВНО один match-вызов и только с остатком строк
 *    (оплаченный батч из чекпоинта повторно не отправляется).
 * 4. Отмена на выверке (подтверждение) → джоба cancelled, проект не изменён.
 * 5. История: после двух джоб — строки с data-kind="backlog" и бейджем
 *    «Бэклог»; «Открыть» завершённой джобы показывает отчёт.
 * 6. 409 при старте с заброшенной выверкой → подсказка про «Прошлые прогоны».
 *
 * Мок-модель — общий ai-stub (расширен match-ответами по батчу из промпта);
 * xlsx собирается программно (adm-zip + inline strings — парсер сервера
 * поддерживает их наравне с sharedStrings, Н6).
 */

const MODEL = 'Qwen3-235B-A22B';
const STUB_MODELS = [MODEL, 'Qwen-Coder-Next'];
const JOB_TIMEOUT = { timeout: 30_000 } as const;
/** NET-02 достигается после исчерпания ретраев с backoff (~30–60 с). */
const FAIL_TIMEOUT = { timeout: 120_000 } as const;

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

/* ── Помощники (паттерн ai-import-todo20.spec.ts) ─────────────────────────── */

async function configureAi(page: Page, projectId: string, model: string): Promise<void> {
  const res = await page.request.put('/api/ai/config', {
    data: { baseURL: stub.baseUrl, apiKey: 'sk-e2e-todo22-key', projectId, model },
  });
  if (!res.ok()) throw new Error(`PUT /api/ai/config failed (${res.status()})`);
}

/** Свежий проект с настроенным AI; возвращает id проекта. */
async function projectWithAi(page: Page, prefix: string): Promise<string> {
  await createProject(page, uniqueName(prefix));
  const id = projectIdFromUrl(page);
  await configureAi(page, id, MODEL);
  await page.reload();
  await expect(page.getByTestId('main-page')).toBeVisible();
  return id;
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

function xmlEscape(value: string): string {
  return value.replace(/[&<>]/g, (ch) => XML_ESCAPES[ch]!);
}

/**
 * Собрать минимальный валидный xlsx: одна `xl/worksheets/sheet1.xml` с inline
 * strings (без sharedStrings/workbook — парсер сервера использует fallback на
 * sheet1). `rows` — построчная таблица; `undefined`/`''` — пустая ячейка.
 */
function makeXlsx(
  testInfo: TestInfo,
  name: string,
  rows: ReadonlyArray<ReadonlyArray<string | undefined>>,
): string {
  const colLetter = (i: number): string => String.fromCharCode(65 + i); // A..Z хватает
  const body = rows
    .map((cells, rowIdx) => {
      const r = rowIdx + 1;
      const cs = cells
        .map((value, colIdx) =>
          value === undefined || value === ''
            ? ''
            : `<c r="${colLetter(colIdx)}${r}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`,
        )
        .join('');
      return `<row r="${r}">${cs}</row>`;
    })
    .join('');
  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData></worksheet>`;
  const zip = new AdmZip();
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8'));
  const target = testInfo.outputPath(name);
  zip.writeZip(target);
  return target;
}

async function openBacklogImport(page: Page): Promise<void> {
  await page.getByTestId('footer-ai-backlog-import').click();
  await expect(page.getByTestId('ai-backlog-import')).toBeVisible();
}

async function chooseXlsx(page: Page, filePath: string): Promise<void> {
  await page.getByTestId('ai-backlog-file').setInputFiles(filePath);
  await expect(page.getByTestId('ai-backlog-file-name')).toBeVisible();
}

/** «Загрузить и разобрать» → jobId из 202-ответа. */
async function startBacklog(page: Page): Promise<string> {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/ai-backlog-import'),
    ),
    page.getByTestId('ai-backlog-start').click(),
  ]);
  expect(res.status()).toBe(202);
  return ((await res.json()) as { jobId: string }).jobId;
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
  description?: string;
  implemented: boolean;
  targetQuarter?: string;
  targetYear?: number;
  links: Array<{ type: string; targetSlug: string }>;
  sources?: Array<{ type: string; name: string; priorityId: string }>;
}

async function listRequirements(page: Page, projectId: string): Promise<ReqDto[]> {
  const res = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/requirements`);
  if (!res.ok()) throw new Error(`GET requirements failed (${res.status()})`);
  return ((await res.json()) as { requirements: ReqDto[] }).requirements;
}

/** Дефолтный target предпросмотра = следующий календарный квартал (UTC, как сервер). */
function expectedDefaultTarget(): { quarter: string; year: number } {
  const now = new Date();
  const nextIdx = (Math.floor(now.getUTCMonth() / 3) + 1) % 4;
  return {
    quarter: ['Q1', 'Q2', 'Q3', 'Q4'][nextIdx]!,
    year: nextIdx === 0 ? now.getUTCFullYear() + 1 : now.getUTCFullYear(),
  };
}

/** Строка таблицы выверки по rowId листа (r2 = первая строка данных под шапкой). */
function reviewRow(page: Page, rowId: string) {
  return page.locator(`[data-testid="ai-backlog-review-row"][data-rowid="${rowId}"]`);
}

/* ══ 1 · Happy-path: предпросмотр → анализ → выверка → запись → отчёт ══════ */

test.describe('todo_22 · счастливый путь импорта бэклога', () => {
  test('xlsx → предпросмотр → прогресс → выверка (минус одна строка) → запись → отчёт, узлы и источники в проекте', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const id = await projectWithAi(page, 'T22-Happy');
    await apiCreateRequirement(page, id, { kind: 'function', name: 'Работа с отчётами' });

    stub.setBacklogAnswers({
      'CRPV-1': {
        businessName: 'Выгрузка отчёта в PDF',
        parentExisting: 'Работа с отчётами',
      },
      'CRPV-2': {
        businessName: 'Фильтрация отчётов по дате',
        parentNew: { name: 'Фильтрация отчётов', parentName: 'Работа с отчётами' },
      },
      'CRPV-3': {
        businessName: 'Ежедневное резервное копирование',
        type: 'NFR',
        parentNew: { name: 'Надёжность хранения данных', parentName: null },
      },
    });
    stub.setBacklogDelay(2000); // окно для 800мс-поллера: экран прогресса виден
    try {
      const xlsxName = 'backlog-happy.xlsx';
      const xlsx = makeXlsx(testInfo, xlsxName, [
        ['Issue key', 'Summary', 'Due date'],
        ['CRPV-1', 'Сделать выгрузку отчёта в PDF', '2027-05-10'],
        ['CRPV-2', 'Починить фильтр по дате в отчётах', '2027-06-15'],
        ['CRPV-3', 'Настроить резервное копирование каждый день', undefined],
      ]);
      const matchCallsBefore = stub.backlogMatchRequests.length;

      await openBacklogImport(page);
      await chooseXlsx(page, xlsx);
      await startBacklog(page);

      // Предпросмотр (П2): чипы колонок, строки, target-поле с дефолтом.
      await expect(page.getByTestId('ai-backlog-preview-step')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-backlog-col-key')).toContainText('Issue key');
      await expect(page.getByTestId('ai-backlog-col-text')).toContainText('Summary');
      await expect(page.getByTestId('ai-backlog-col-target')).toContainText('Due date');
      await expect(page.getByTestId('ai-backlog-rows-summary')).toContainText('3');
      await expect(page.getByTestId('ai-backlog-sample-row')).toHaveCount(3);
      const def = expectedDefaultTarget();
      await expect(page.getByTestId('ai-backlog-target-quarter')).toHaveValue(def.quarter);
      await expect(page.getByTestId('ai-backlog-target-year')).toHaveValue(String(def.year));
      await expect(page.getByTestId('ai-backlog-target-hint')).toContainText(
        'сроки найдены в файле',
      );
      await expect(page.getByTestId('ai-backlog-estimate')).toContainText('≈ 1');
      // До подтверждения предпросмотра AI-вызовов нет (отмена бесплатна).
      expect(stub.backlogMatchRequests.length).toBe(matchCallsBefore);

      // «Начать анализ» → прогресс: этап, бар, счётчики, лента событий.
      await page.getByTestId('ai-backlog-confirm-start').click();
      await expect(page.getByTestId('ai-backlog-stage')).toContainText(
        'Соотнесение с деревом',
        JOB_TIMEOUT,
      );
      await expect(page.getByTestId('ai-backlog-progress')).toBeVisible();
      await expect(page.getByTestId('ai-backlog-counters')).toBeVisible();
      await expect(page.getByTestId('ai-backlog-log')).toBeVisible();

      // Выверка (PO №1): полная разметка, записи в проект ещё НЕТ.
      await expect(page.getByTestId('ai-backlog-review-step')).toBeVisible(JOB_TIMEOUT);
      // Хотфикс-гард: match-вызов ушёл со СВОЕЙ схемой (не analyze-схемой
      // extracted_requirements — та давала ответы без rowId → MODEL-01).
      expect(jsonSchemaNameOf(stub.backlogMatchRequests[matchCallsBefore])).toBe(
        'backlog_match_answers',
      );
      await expect(page.getByTestId('ai-backlog-new-nodes')).toContainText(
        'Будут созданы новые узлы дерева (2)',
      );
      await expect(page.getByTestId('ai-backlog-new-node')).toHaveCount(2);
      await expect(page.getByTestId('ai-backlog-new-nodes')).toContainText('Фильтрация отчётов');
      await expect(page.getByTestId('ai-backlog-new-nodes')).toContainText(
        'Надёжность хранения данных',
      );
      await expect(page.getByTestId('ai-backlog-review-row')).toHaveCount(3);
      await expect(page.getByTestId('ai-backlog-selected-count')).toHaveText('выбрано 3 из 3');
      await expect(reviewRow(page, 'r3').getByTestId('ai-backlog-badge-new-node')).toBeVisible();
      await expect(reviewRow(page, 'r4').getByTestId('ai-backlog-badge-nfr')).toBeVisible();
      // Target: срок из файла (📄) против общего выбора для строки без срока.
      await expect(reviewRow(page, 'r2').getByTestId('ai-backlog-row-target')).toContainText(
        'Q2 2027',
      );
      await expect(reviewRow(page, 'r2').getByTestId('ai-backlog-target-from-file')).toBeVisible();
      await expect(reviewRow(page, 'r4').getByTestId('ai-backlog-row-target')).toContainText(
        `${def.quarter} ${def.year}`,
      );
      await expect(reviewRow(page, 'r4').getByTestId('ai-backlog-target-from-file')).toHaveCount(0);
      // Инвариант «до apply записей нет»: в проекте только сеяное требование.
      expect(await listRequirements(page, id)).toHaveLength(1);

      // Снимаем одну строку (CRPV-2) — кнопка записи пересчитывает N.
      await reviewRow(page, 'r3').getByTestId('ai-backlog-row-checkbox').uncheck();
      await expect(page.getByTestId('ai-backlog-selected-count')).toHaveText('выбрано 2 из 3');
      await expect(page.getByTestId('ai-backlog-apply')).toContainText('Записать в проект (2)');

      // Запись → отчёт: счётчики + таблица соответствий + usage.
      await page.getByTestId('ai-backlog-apply').click();
      await expect(page.getByTestId('ai-backlog-success')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-backlog-report-functions')).toContainText('1');
      await expect(page.getByTestId('ai-backlog-report-nfrs')).toContainText('1');
      await expect(page.getByTestId('ai-backlog-report-new-nodes')).toContainText('1');
      await expect(page.getByTestId('ai-backlog-report-links')).toContainText('2');
      await expect(page.getByTestId('ai-backlog-report-deselected')).toContainText('1');
      await expect(page.getByTestId('ai-backlog-report-table')).toBeVisible();
      await expect(page.getByTestId('ai-backlog-usage')).toContainText(/Потрачено токенов: [1-9]/);
      await testInfo.attach('report', { body: await page.screenshot(), contentType: 'image/png' });
      await page.getByTestId('ai-backlog-done').click();
      await expect(page.getByTestId('ai-backlog-import')).toHaveCount(0);

      // Дерево: новые узел/требования видны; снятая строка не создана.
      await setTreeMode(page, 'expand-all');
      await expect(rowByName(page, 'Выгрузка отчёта в PDF')).toBeVisible();
      await expect(rowByName(page, 'Надёжность хранения данных')).toBeVisible();
      await expect(rowByName(page, 'Ежедневное резервное копирование')).toBeVisible();
      await expect(rowByName(page, 'Фильтрация отчётов по дате')).toHaveCount(0);
      await expect(rowByName(page, 'Фильтрация отчётов')).toHaveCount(0);
      // Бейдж источника «Бэклог» в колонке источников строки дерева.
      await expect(
        rowByName(page, 'Выгрузка отчёта в PDF').getByTestId('req-sources-cell'),
      ).toContainText(`Бэклог: ${xlsxName}`);

      // API: описание = исходная формулировка + ключ; источник BACKLOG; связи.
      const reqs = await listRequirements(page, id);
      expect(reqs).toHaveLength(4); // сеяный корень + узел + 2 требования
      const bySlug = new Map(reqs.map((r) => [r.slug, r]));
      const root = reqs.find((r) => r.name === 'Работа с отчётами')!;
      const pdf = reqs.find((r) => r.name === 'Выгрузка отчёта в PDF')!;
      expect(pdf.type).toBe('FUNCTION');
      expect(pdf.description).toContain('Сделать выгрузку отчёта в PDF');
      expect(pdf.description).toContain('Ключ бэклога: CRPV-1');
      expect(pdf.implemented).toBe(false);
      expect(pdf.targetQuarter).toBe('Q2'); // срок из файла (2027-05-10)
      expect(pdf.targetYear).toBe(2027);
      expect(pdf.sources?.[0]?.type).toBe('BACKLOG');
      expect(pdf.sources?.[0]?.name).toBe(`Бэклог: ${xlsxName}`);
      const pdfParent = pdf.links.find((l) => l.type === 'CHILD_OF');
      expect(pdfParent && bySlug.get(pdfParent.targetSlug)?.name).toBe('Работа с отчётами');
      expect(root.slug).toBe(pdfParent!.targetSlug);
      const backup = reqs.find((r) => r.name === 'Ежедневное резервное копирование')!;
      expect(backup.type).toBe('NFR');
      const node = reqs.find((r) => r.name === 'Надёжность хранения данных')!;
      expect(node.type).toBe('NFR');
      expect(node.sources?.[0]?.type).toBe('BACKLOG');
      const backupParent = backup.links.find((l) => l.type === 'CHILD_OF');
      expect(backupParent?.targetSlug).toBe(node.slug);
    } finally {
      stub.setBacklogAnswers(null);
      stub.setBacklogDelay(0);
    }
  });
});

/* ══ 2 · Дубль существующего требования не создаётся ═══════════════════════ */

test.describe('todo_22 · дубликаты', () => {
  test('строка-дубль: чекбокс disabled + бейдж, после записи требование не задвоено', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'T22-Dup');
    await apiCreateRequirement(page, id, { kind: 'function', name: 'Отчёты' });
    await apiCreateRequirement(page, id, { kind: 'function', name: 'Экспорт отчёта в PDF' });

    stub.setBacklogAnswers({
      'CRPV-10': {
        businessName: 'Экспорт отчёта в PDF',
        parentExisting: 'Отчёты',
        duplicateOf: 'Экспорт отчёта в PDF',
      },
      'CRPV-11': { businessName: 'Просмотр отчёта на экране', parentExisting: 'Отчёты' },
    });
    try {
      const xlsx = makeXlsx(testInfo, 'backlog-dup.xlsx', [
        ['Issue key', 'Summary'],
        ['CRPV-10', 'Выгрузить отчёт в PDF (как уже умеем)'],
        ['CRPV-11', 'Показ отчёта на экране'],
      ]);
      await openBacklogImport(page);
      await chooseXlsx(page, xlsx);
      await startBacklog(page);
      await expect(page.getByTestId('ai-backlog-preview-step')).toBeVisible(JOB_TIMEOUT);
      await page.getByTestId('ai-backlog-confirm-start').click();
      await expect(page.getByTestId('ai-backlog-review-step')).toBeVisible(JOB_TIMEOUT);

      // Дубль исключён из выбора и не может быть включён.
      const dupRow = reviewRow(page, 'r2');
      await expect(dupRow.getByTestId('ai-backlog-badge-duplicate')).toBeVisible();
      await expect(dupRow.getByTestId('ai-backlog-row-checkbox')).toBeDisabled();
      await expect(dupRow.getByTestId('ai-backlog-row-checkbox')).not.toBeChecked();
      await expect(dupRow).toContainText('не будет записана');
      await expect(page.getByTestId('ai-backlog-selected-count')).toHaveText('выбрано 1 из 2');

      await page.getByTestId('ai-backlog-apply').click();
      await expect(page.getByTestId('ai-backlog-success')).toBeVisible(JOB_TIMEOUT);
      // В отчётной таблице дубль помечен бейджем и подписью «пропущено».
      await expect(
        page.getByTestId('ai-backlog-report-table').getByTestId('ai-backlog-badge-duplicate'),
      ).toBeVisible();
      await expect(page.getByTestId('ai-backlog-report-table')).toContainText('пропущено');

      // API: дубль не создан — имя существует ровно один раз; всего 2+1.
      const reqs = await listRequirements(page, id);
      expect(reqs.filter((r) => r.name === 'Экспорт отчёта в PDF')).toHaveLength(1);
      expect(reqs).toHaveLength(3);
      expect(reqs.some((r) => r.name === 'Просмотр отчёта на экране')).toBe(true);
    } finally {
      stub.setBacklogAnswers(null);
    }
  });
});

/* ══ 3 · Сбой модели на середине match → «Продолжить» без повторной оплаты ═ */

test.describe('todo_22 · сбой match и resume', () => {
  test('500 на втором батче: ошибка NET-02 с «батч 2 из 2», resume дозапрашивает только остаток строк', async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    await projectWithAi(page, 'T22-Err');

    // 25 строк = 2 батча (20+5); ответы — дефолт стаба (общий новый узел).
    const rows: Array<Array<string | undefined>> = [['Issue key', 'Summary']];
    for (let i = 1; i <= 25; i++) {
      rows.push([`CRPV-${100 + i}`, `Задача бэклога ${i} — доработка модуля ${i}`]);
    }
    stub.failBacklogAfterCalls(1); // 1-й match-вызов успешен, дальше HTTP 500
    try {
      const xlsx = makeXlsx(testInfo, 'backlog-err.xlsx', rows);
      await openBacklogImport(page);
      await chooseXlsx(page, xlsx);
      await startBacklog(page);
      await expect(page.getByTestId('ai-backlog-preview-step')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-backlog-rows-summary')).toContainText('25');
      await expect(page.getByTestId('ai-backlog-estimate')).toContainText('≈ 2');
      await page.getByTestId('ai-backlog-confirm-start').click();

      // Таксономия: код NET-02, этап и позиция батча видны, resume доступен.
      await expect(page.getByTestId('ai-backlog-error')).toBeVisible(FAIL_TIMEOUT);
      await expect(page.getByTestId('ai-backlog-error-code')).toContainText('NET-02');
      await expect(page.getByTestId('ai-backlog-stage')).toContainText('Соотнесение с деревом');
      await expect(page.getByTestId('ai-backlog-batch')).toContainText('батч 2 из 2');
      await testInfo.attach('error', { body: await page.screenshot(), contentType: 'image/png' });

      stub.failBacklogAfterCalls(null); // «модель починилась»
      const callsBeforeResume = stub.backlogMatchRequests.length;
      await page.getByTestId('ai-backlog-resume').click();
      await expect(page.getByTestId('ai-backlog-review-step')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-backlog-review-row')).toHaveCount(25);
      await expect(page.getByTestId('ai-backlog-selected-count')).toHaveText('выбрано 25 из 25');
      await expect(page.getByTestId('ai-backlog-new-nodes')).toContainText(
        BACKLOG_DEFAULT_NEW_NODE,
      );

      // Оплаченный батч (20 строк) взят из чекпоинта: после resume ушёл РОВНО
      // один match-вызов и только с остатком (5 строк второго батча).
      const afterResume = stub.backlogMatchRequests.slice(callsBeforeResume);
      expect(afterResume).toHaveLength(1);
      const resumedBatch = backlogBatchOf(afterResume[0]);
      expect(resumedBatch).toHaveLength(5);
      expect(resumedBatch.map((r) => r.rowId)).toEqual(['r22', 'r23', 'r24', 'r25', 'r26']);

      // Гигиена: разметку не записываем — отменяем джобу через выверку.
      await page.getByTestId('ai-backlog-review-cancel').click();
      await page.getByTestId('ai-backlog-cancel-review-confirm-confirm').click();
      await expect(page.getByTestId('ai-backlog-cancelled-summary')).toBeVisible(JOB_TIMEOUT);
    } finally {
      stub.failBacklogAfterCalls(null);
    }
  });
});

/* ══ 4 · Отмена на выверке: джоба cancelled, проект не изменён ═════════════ */

test.describe('todo_22 · отмена на выверке', () => {
  test('«Отмена» + подтверждение: статус cancelled, в проекте ни одной записи', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'T22-Cancel');
    const xlsx = makeXlsx(testInfo, 'backlog-cancel.xlsx', [
      ['Issue key', 'Summary'],
      ['CRPV-31', 'Первая задача из бэклога'],
      ['CRPV-32', 'Вторая задача из бэклога'],
    ]);
    await openBacklogImport(page);
    await chooseXlsx(page, xlsx);
    const jobId = await startBacklog(page);
    await expect(page.getByTestId('ai-backlog-preview-step')).toBeVisible(JOB_TIMEOUT);
    await page.getByTestId('ai-backlog-confirm-start').click();
    await expect(page.getByTestId('ai-backlog-review-step')).toBeVisible(JOB_TIMEOUT);

    // До apply записей нет — и после отмены их тоже не появится.
    expect(await listRequirements(page, id)).toHaveLength(0);

    await page.getByTestId('ai-backlog-review-cancel').click();
    await expect(page.getByTestId('ai-backlog-cancel-review-confirm')).toBeVisible();
    await page.getByTestId('ai-backlog-cancel-review-confirm-confirm').click();
    await expect(page.getByTestId('ai-backlog-cancelled-summary')).toBeVisible(JOB_TIMEOUT);
    await expect(page.getByTestId('ai-backlog-cancelled-summary')).toContainText(
      'ничего не записывалось',
    );
    await expect.poll(() => jobStatus(page, jobId)).toBe('cancelled');
    expect(await listRequirements(page, id)).toHaveLength(0);
  });
});

/* ══ 5 · История: kind-бейджи и открытие завершённой джобы ═════════════════ */

test.describe('todo_22 · история прогонов бэклога', () => {
  test('после двух джоб: строки с data-kind="backlog" и бейджем «Бэклог», «Открыть» показывает отчёт', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'T22-Hist');

    const runOnce = async (n: number): Promise<void> => {
      const xlsx = makeXlsx(testInfo, `backlog-hist-${n}.xlsx`, [
        ['Issue key', 'Summary'],
        [`CRPV-${40 + n}`, `Историческая задача ${n} из бэклога`],
      ]);
      await openBacklogImport(page);
      await chooseXlsx(page, xlsx);
      await startBacklog(page);
      await expect(page.getByTestId('ai-backlog-preview-step')).toBeVisible(JOB_TIMEOUT);
      await page.getByTestId('ai-backlog-confirm-start').click();
      await expect(page.getByTestId('ai-backlog-review-step')).toBeVisible(JOB_TIMEOUT);
      await page.getByTestId('ai-backlog-apply').click();
      await expect(page.getByTestId('ai-backlog-success')).toBeVisible(JOB_TIMEOUT);
      await page.getByTestId('ai-backlog-done').click();
      await expect(page.getByTestId('ai-backlog-import')).toHaveCount(0);
    };
    await runOnce(1);
    await runOnce(2);

    await openBacklogImport(page);
    // История — свёрнутый <details>: раскрываем через summary перед кликами.
    const history = page.getByTestId('ai-backlog-history');
    await expect(history).toContainText('Прошлые прогоны — 2');
    await history.locator('summary').click();
    const historyRows = page.getByTestId('ai-backlog-history-row');
    await expect(historyRows).toHaveCount(2);
    for (const row of await historyRows.all()) {
      await expect(row).toHaveAttribute('data-kind', 'backlog');
      await expect(row).toHaveAttribute('data-status', 'succeeded');
      await expect(row.getByTestId('ai-backlog-history-kind')).toHaveText('Бэклог');
    }
    await testInfo.attach('history', { body: await page.screenshot(), contentType: 'image/png' });

    // «Открыть» завершённой джобы показывает её отчёт в этой же модалке.
    await historyRows.first().getByTestId('ai-backlog-history-open').click();
    await expect(page.getByTestId('ai-backlog-success')).toBeVisible(JOB_TIMEOUT);
    await expect(page.getByTestId('ai-backlog-report')).toBeVisible();
    await expect(page.getByTestId('ai-backlog-report-functions')).toContainText('1');
  });
});

/* ══ 6 · 409 при новом старте с заброшенной выверкой ═══════════════════════ */

test.describe('todo_22 · конфликт с незавершённой выверкой', () => {
  test('повторный старт при джобе на выверке: 409 и подсказка про «Прошлые прогоны»', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'T22-Conflict');
    const xlsx1 = makeXlsx(testInfo, 'backlog-conflict-1.xlsx', [
      ['Issue key', 'Summary'],
      ['CRPV-51', 'Задача, которая застрянет на выверке'],
    ]);
    await openBacklogImport(page);
    await chooseXlsx(page, xlsx1);
    const jobId = await startBacklog(page);
    await expect(page.getByTestId('ai-backlog-preview-step')).toBeVisible(JOB_TIMEOUT);
    await page.getByTestId('ai-backlog-confirm-start').click();
    await expect(page.getByTestId('ai-backlog-review-step')).toBeVisible(JOB_TIMEOUT);

    // Закрытие на выверке БЕЗ отмены — оплаченная разметка остаётся ждать.
    await page.getByTestId('ai-backlog-import-close').click();
    await expect(page.getByTestId('ai-backlog-import')).toHaveCount(0);
    expect(await jobStatus(page, jobId)).toBe('awaiting-review');

    // Новый старт блокируется контрактом (409) с понятной подсказкой.
    await openBacklogImport(page);
    const xlsx2 = makeXlsx(testInfo, 'backlog-conflict-2.xlsx', [
      ['Issue key', 'Summary'],
      ['CRPV-52', 'Вторая попытка импорта'],
    ]);
    await chooseXlsx(page, xlsx2);
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname.endsWith('/ai-backlog-import'),
      ),
      page.getByTestId('ai-backlog-start').click(),
    ]);
    expect(res.status()).toBe(409);
    await expect(page.getByTestId('ai-backlog-start-error')).toBeVisible();
    await expect(page.getByTestId('ai-backlog-start-error')).toContainText('Прошлых прогонах');
    // Заброшенная джоба видна в истории на этом же экране со статусом выверки.
    await expect(page.getByTestId('ai-backlog-history-row')).toHaveAttribute(
      'data-status',
      'awaiting-review',
    );

    // Гигиена: снимаем блокировку проекта отменой джобы через API.
    const cancel = await page.request.post(`/api/ai-import/${encodeURIComponent(jobId)}/cancel`);
    expect(cancel.ok()).toBe(true);
  });
});
