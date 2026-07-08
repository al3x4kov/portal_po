import { expect, type Locator, type Page } from '@playwright/test';
import { rowByName } from './app.js';

/**
 * Shared helpers for the todo_19 Wave-3 QA suites (multiple sources, RICE,
 * project dictionaries, PO dates). Mirrors the discipline of helpers/app.ts:
 * every interaction waits on a testid/state (no arbitrary sleeps), and reads go
 * through the REST API so tests stay deterministic.
 */

export type SourceTypeCode = 'CLIENT' | 'STAKEHOLDER' | 'STANDARD' | 'TEXT';

export interface DictPriority {
  id: string;
  name: string;
  color: string;
  order: number;
}
export interface DictSource {
  id: string;
  name: string;
  type: SourceTypeCode;
}
export interface Dictionaries {
  priorities: DictPriority[];
  sources: DictSource[];
}

/** Read a project's dictionaries straight from the server (source of truth). */
export async function fetchDictionaries(page: Page, projectId: string): Promise<Dictionaries> {
  const res = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/dictionaries`);
  if (!res.ok()) {
    throw new Error(`fetchDictionaries failed (${res.status()}): ${await res.text()}`);
  }
  return (await res.json()) as Dictionaries;
}

interface ReqRecord {
  slug: string;
  sources?: Array<{ name: string; type: SourceTypeCode; priorityId: string }>;
}

/**
 * Read a single requirement (with its sources[]) from the server. There is no
 * GET-by-slug endpoint — the list route returns JSON `{ requirements }` by
 * default, so we filter it by slug.
 */
export async function fetchRequirement(
  page: Page,
  projectId: string,
  slug: string,
): Promise<ReqRecord> {
  const res = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/requirements`);
  if (!res.ok()) {
    throw new Error(`fetchRequirement failed (${res.status()}): ${await res.text()}`);
  }
  const data = (await res.json()) as { requirements: ReqRecord[] };
  const found = data.requirements.find((r) => r.slug === slug);
  if (!found) throw new Error(`requirement ${slug} not found in project ${projectId}`);
  return found;
}

/** Navigate to the project dictionaries page via the sidebar. */
export async function gotoDictionaries(page: Page): Promise<void> {
  await page.getByTestId('sidebar-nav-dictionaries').click();
  await expect(page.getByTestId('dictionaries-page')).toBeVisible();
  await expect(page.getByTestId('dict-priorities')).toBeVisible();
}

/** Open a requirement's edit modal and switch to the «Приоритизация» tab. */
export async function openPriorityTab(page: Page, name: string): Promise<Locator> {
  await rowByName(page, name).locator('[data-testid^="req-name-"]').click();
  const modal = page.getByTestId('requirement-modal');
  await expect(modal).toBeVisible();
  await page.getByTestId('req-tab-priority').click();
  await expect(page.getByTestId('req-priority-tab')).toBeVisible();
  return modal;
}

export interface Rice {
  reach: string;
  impact: string;
  confidence: string;
  effort: string;
}

export interface SourceCardInput {
  type?: SourceTypeCode;
  name: string;
  /** Priority id to select in the per-source combobox (default = project default). */
  priorityId?: string;
  rice?: Rice;
  quarter?: string;
  year?: string;
  /** yyyy-mm-dd */
  date?: string;
  /** Use the combobox «Создать новый источник» (auto-collect) instead of free text. */
  createInDict?: boolean;
}

/**
 * Add and fill one source card on the «Приоритизация» tab. `index` is the
 * zero-based card position (the next `src-card-<index>` created by «Добавить
 * источник»). Name is set last and the combobox menu is closed deterministically
 * so a following interaction is never intercepted by the overlay.
 */
export async function addSourceCard(
  page: Page,
  index: number,
  input: SourceCardInput,
): Promise<void> {
  await page.getByTestId('src-add').click();
  const card = page.getByTestId(`src-card-${index}`);
  await expect(card).toBeVisible();

  if (input.type) await page.getByTestId(`src-type-${index}`).selectOption(input.type);
  if (input.priorityId) {
    await page.getByTestId(`src-priority-${index}`).selectOption(input.priorityId);
  }
  if (input.rice) {
    await page.getByTestId(`src-rice-reach-${index}`).selectOption(input.rice.reach);
    await page.getByTestId(`src-rice-impact-${index}`).selectOption(input.rice.impact);
    await page.getByTestId(`src-rice-confidence-${index}`).selectOption(input.rice.confidence);
    await page.getByTestId(`src-rice-effort-${index}`).selectOption(input.rice.effort);
  }
  if (input.quarter) await page.getByTestId(`src-quarter-${index}`).selectOption(input.quarter);
  if (input.year) await page.getByTestId(`src-year-${index}`).fill(input.year);
  if (input.date) await page.getByTestId(`src-date-${index}`).fill(input.date);

  const nameInput = page.getByTestId(`src-name-${index}-input`);
  await nameInput.click();
  await nameInput.fill(input.name);
  if (input.createInDict) {
    await page.getByTestId(`src-name-${index}-create`).click();
  }
  // Close the combobox overlay deterministically before the caller moves on.
  await nameInput.blur();
  await expect(page.getByTestId(`src-name-${index}-menu`)).toBeHidden();
}

/** Save the currently open requirement modal and wait for it to close. */
export async function saveRequirementModal(page: Page): Promise<void> {
  const modal = page.getByTestId('requirement-modal');
  await page.getByTestId('req-submit').click();
  await expect(modal).toBeHidden();
}
