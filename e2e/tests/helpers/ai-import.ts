import { expect, type Page } from '@playwright/test';

/**
 * T5 (todo_17) · AiImportModal: the success view renders the results as a
 * TABLE (`ai-import-summary`, §2.18.3) — 5 fixed rows with big numbers instead
 * of the old one-line «Создано: X ФТ и Y НФТ …» text. `ai-import-relates-links`
 * is now the NUMBER cell of the «Найдено связей НФТ с ФТ» row.
 *
 * Shared between ai-import.spec.ts and ai-mockserver.spec.ts.
 */

export interface AiImportSummaryCounts {
  /** «Создано функциональных требований» */
  functions: number;
  /** «Создано нефункциональных требований» */
  nfrs: number;
  /** «Создано связей в дереве» (CHILD_OF from the structure stage) */
  treeLinks: number;
  /** «Найдено связей НФТ с ФТ» (RELATES_TO from extraction relatedFunctions) */
  relatesLinks: number;
  /** «Пропущено» (уже существовали в проекте) */
  skipped: number;
}

const SUMMARY_ROW_LABELS = [
  'Создано функциональных требований',
  'Создано нефункциональных требований',
  'Создано связей в дереве',
  'Найдено связей НФТ с ФТ',
  'Пропущено',
] as const;

/** Assert the full 5-row summary table of a finished AI import. */
export async function expectAiImportSummary(
  page: Page,
  counts: AiImportSummaryCounts,
): Promise<void> {
  const summary = page.getByTestId('ai-import-summary');
  await expect(summary).toBeVisible();

  const rows = summary.locator('tbody tr');
  await expect(rows).toHaveCount(SUMMARY_ROW_LABELS.length);

  const values = [
    counts.functions,
    counts.nfrs,
    counts.treeLinks,
    counts.relatesLinks,
    counts.skipped,
  ];
  for (let i = 0; i < SUMMARY_ROW_LABELS.length; i += 1) {
    await expect(rows.nth(i)).toContainText(SUMMARY_ROW_LABELS[i]!);
    await expect(rows.nth(i).locator('td')).toHaveText(String(values[i]));
  }

  // The relates counter keeps its dedicated testid (now a bare number cell).
  await expect(page.getByTestId('ai-import-relates-links')).toHaveText(String(counts.relatesLinks));
}
