import AdmZip from 'adm-zip';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/**
 * Общие помощники сценариев «AI-импорт бэклога» (todo_22 / task25): сборка
 * минимального xlsx, прохождение модалки до шага выверки и API-чтение
 * требований проекта. Используются spec-файлами `ai-backlog-*.spec.ts`.
 */

export const BACKLOG_JOB_TIMEOUT = { timeout: 30_000 } as const;

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

function xmlEscape(value: string): string {
  return value.replace(/[&<>]/g, (ch) => XML_ESCAPES[ch]!);
}

/**
 * Собрать минимальный валидный xlsx: одна `xl/worksheets/sheet1.xml` с inline
 * strings (без sharedStrings/workbook — парсер сервера использует fallback на
 * sheet1). `rows` — построчная таблица; `undefined`/`''` — пустая ячейка.
 */
export function makeXlsx(
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

export async function openBacklogImport(page: Page): Promise<void> {
  await page.getByTestId('footer-ai-backlog-import').click();
  await expect(page.getByTestId('ai-backlog-import')).toBeVisible();
}

export async function chooseXlsx(page: Page, filePath: string): Promise<void> {
  await page.getByTestId('ai-backlog-file').setInputFiles(filePath);
  await expect(page.getByTestId('ai-backlog-file-name')).toBeVisible();
}

/** «Загрузить и разобрать» → jobId из 202-ответа. */
export async function startBacklog(page: Page): Promise<string> {
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

/** Полный проход до шага выверки: файл → предпросмотр → «Начать анализ». */
export async function goToReview(page: Page, xlsxPath: string): Promise<void> {
  await openBacklogImport(page);
  await chooseXlsx(page, xlsxPath);
  await startBacklog(page);
  await expect(page.getByTestId('ai-backlog-preview-step')).toBeVisible(BACKLOG_JOB_TIMEOUT);
  await page.getByTestId('ai-backlog-confirm-start').click();
  await expect(page.getByTestId('ai-backlog-review-step')).toBeVisible(BACKLOG_JOB_TIMEOUT);
}

/** Строка таблицы выверки по rowId листа (r2 = первая строка данных под шапкой). */
export function reviewRow(page: Page, rowId: string): Locator {
  return page.locator(`[data-testid="ai-backlog-review-row"][data-rowid="${rowId}"]`);
}

export interface BacklogReqDto {
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

export async function listRequirements(page: Page, projectId: string): Promise<BacklogReqDto[]> {
  const res = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/requirements`);
  if (!res.ok()) throw new Error(`GET requirements failed (${res.status()})`);
  return ((await res.json()) as { requirements: BacklogReqDto[] }).requirements;
}

/** Тело POST /api/ai-import/:jobId/apply, перехваченное при клике «Записать». */
export interface ApplyBodyCapture {
  rowIds: string[];
  overrides?: Record<string, unknown>;
}

/**
 * Кликнуть «Записать в проект (N)» и вернуть отправленное тело запроса —
 * контрактная проверка «overrides только для реально изменённых строк».
 */
export async function clickApplyCapturingBody(page: Page): Promise<ApplyBodyCapture> {
  const [req] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/apply'),
    ),
    page.getByTestId('ai-backlog-apply').click(),
  ]);
  return req.postDataJSON() as ApplyBodyCapture;
}
