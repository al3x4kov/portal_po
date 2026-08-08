import { expect, type Page } from '@playwright/test';

/**
 * T5 (todo_17) · AiImportModal: the success view renders the results as a
 * TABLE (`ai-import-summary`, §2.18.3) — 5 fixed rows with big numbers instead
 * of the old one-line «Создано: X ФТ и Y НФТ …» text. `ai-import-relates-links`
 * is the NUMBER cell of the «Смысловые связи НФТ↔ФТ» row.
 *
 * todo_18: that row is renamed «Смысловые связи НФТ↔ФТ» and its number is the
 * TOTAL of meaningful RELATES_TO links = extraction-time `result.relatesLinks`
 * (из текста НФТ) + the optional AI relate step `relate.created` (шаг «связи
 * ФТ↔НФТ»). So callers pass the SUM in `relatesLinks` when the relate step ran.
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
  /**
   * «Смысловые связи НФТ↔ФТ» — total RELATES_TO shown: extraction-time
   * `result.relatesLinks` + optional relate-step `relate.created` (todo_18).
   */
  relatesLinks: number;
  /** «Пропущено» (уже существовали в проекте) */
  skipped: number;
}

const SUMMARY_ROW_LABELS = [
  'Создано функциональных требований',
  'Создано нефункциональных требований',
  'Создано связей в дереве',
  'Смысловые связи НФТ↔ФТ',
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

/** Review-gate transitions ride the ~800 ms status poller — same budget as jobs. */
const REVIEW_TIMEOUT = { timeout: 30_000 } as const;

/**
 * Двухзонная выверка дублей: ensure the select-all checkbox of the CURRENT
 * review zone is checked. Clicking an unchecked/partially-checked box selects
 * all rows, so up to two clicks always converge on «checked».
 */
async function selectAllReviewRows(page: Page): Promise<void> {
  const selectAll = page.getByTestId('ai-docs-review-select-all');
  await expect(selectAll).toBeVisible(REVIEW_TIMEOUT);
  // The default selection of a zone is seeded by an effect right after the
  // zone renders — a click landing before the seed could be overwritten, so
  // the whole «click if unchecked, then must be checked» block retries.
  await expect(async () => {
    if (!(await selectAll.isChecked())) await selectAll.click();
    await expect(selectAll).toBeChecked({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/**
 * Approve BOTH zones of the docs-import review gate («двухзонная выверка
 * дублей») with «select all», reproducing the pre-gate pipeline outcome:
 * everything extracted goes to populate, which still skips requirements that
 * already exist in the project.
 *
 * Zone 1 (дубли между собой) keeps only ONE record per semantic-duplicate
 * group by default; zone 2 (дубли с проектом) DESELECTS records flagged as
 * duplicates of existing requirements — so each zone is select-ALL'ed before
 * its apply. Waits for the review step to disappear at the end (populate has
 * been launched). Playwright auto-waiting only, no sleeps.
 */
export async function approveDocsReviewGates(page: Page): Promise<void> {
  const step = page.getByTestId('ai-docs-review-step');
  const banner = page.getByTestId('ai-docs-review-banner');
  const apply = page.getByTestId('ai-docs-review-apply');

  // Zone 1 · дубли среди сгенерированных: keep everything, continue.
  await expect(step).toBeVisible(REVIEW_TIMEOUT);
  await expect(banner).toContainText('Зона 1', REVIEW_TIMEOUT);
  await selectAllReviewRows(page);
  await apply.click();

  // Zone 2 · дубли с уже созданными в проекте: keep everything, write.
  await expect(banner).toContainText('Зона 2', REVIEW_TIMEOUT);
  await selectAllReviewRows(page);
  await apply.click();

  // Populate launched — the review step leaves the modal.
  await expect(step).toBeHidden(REVIEW_TIMEOUT);
}
