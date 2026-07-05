import { promises as fs } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  addRequirement,
  createProject,
  linkRequirements,
  openEdit,
  rowByName,
  slugOf,
  uniqueName,
} from './helpers/app.js';

/**
 * T-1502 · E15 UX-доработки PO (E2E). Покрывает пять фич из docs/po/UX-review.md:
 *   T1 — фильтр «Реализация» (DONE/PLANNED) + пересечение с критичностью;
 *   T2 — блок «Связи» в карточке требования (список + пустое состояние);
 *   T3 — удаление связи с инлайн-подтверждением (реципрокная пара у обоих концов);
 *   T4 — создание НФТ из строки ФТ с преднастроенной связью ФТ BLOCKED_BY НФТ;
 *   T5 — человекочитаемый Excel-экспорт (валидный xlsx, лист «Требования»).
 *
 * Изоляция — как в остальном сьюте: свежий проект + уникальные имена на тест.
 */

/** Открыть дропдаун «Реализация», отметить статусы (draft) и применить. */
async function applyImplFilter(
  page: Page,
  statuses: ReadonlyArray<'done' | 'planned'>,
): Promise<void> {
  await page.getByTestId('impl-filter').click();
  await expect(page.getByTestId('impl-dropdown')).toBeVisible();
  for (const s of statuses) await page.getByTestId(`impl-opt-${s}`).click();
  await page.getByTestId('impl-apply').click();
  await expect(page.getByTestId('impl-dropdown')).toBeHidden();
}

/** Сбросить фильтр «Реализация» через кнопку «Сбросить» в дропдауне. */
async function resetImplFilter(page: Page): Promise<void> {
  await page.getByTestId('impl-filter').click();
  await expect(page.getByTestId('impl-dropdown')).toBeVisible();
  await page.getByTestId('impl-reset').click();
  await expect(page.getByTestId('impl-dropdown')).toBeHidden();
}

/** Применить фильтр критичности (draft → «Применить»). */
async function applyCriticality(
  page: Page,
  opt: 'low' | 'medium' | 'high' | 'critical' | 'blocker',
): Promise<void> {
  await page.getByTestId('criticality-filter').click();
  await expect(page.getByTestId('criticality-dropdown')).toBeVisible();
  await page.getByTestId(`crit-opt-${opt}`).click();
  await page.getByTestId('crit-apply').click();
  await expect(page.getByTestId('criticality-dropdown')).toBeHidden();
}

test.describe('T-1502 · E15 PO UX', () => {
  // ── T1 · фильтр «Реализация» ────────────────────────────────────────────────
  test('T1 фильтр «Реализация»: PLANNED показывает только плановые; reset и ∩ критичность', async ({
    page,
  }) => {
    await createProject(page, uniqueName('impl-proj'));
    const fPlanHigh = uniqueName('F-plan-high'); // не реализовано, HIGH
    const fPlanLow = uniqueName('F-plan-low'); // не реализовано, LOW
    const fDoneHigh = uniqueName('F-done-high'); // реализовано, HIGH

    await addRequirement(page, {
      kind: 'function',
      name: fPlanHigh,
      criticality: 'HIGH',
      implemented: false,
      quarter: 'Q3',
      year: 2027,
    });
    await addRequirement(page, {
      kind: 'function',
      name: fPlanLow,
      criticality: 'LOW',
      implemented: false,
      quarter: 'Q4',
      year: 2027,
    });
    await addRequirement(page, {
      kind: 'function',
      name: fDoneHigh,
      criticality: 'HIGH',
      implemented: true,
    });

    // Применяем «Не реализовано» → видны только плановые, реализованное скрыто.
    await applyImplFilter(page, ['planned']);
    await expect(rowByName(page, fPlanHigh)).toBeVisible();
    await expect(rowByName(page, fPlanLow)).toBeVisible();
    await expect(rowByName(page, fDoneHigh)).toBeHidden();
    // Бейдж-счётчик = число выбранных статусов (1: только PLANNED).
    await expect(page.getByTestId('impl-count')).toHaveText('1');
    await expect(page.getByTestId('shown-count')).toContainText('Показано 2 из 3');

    // Пересечение с фильтром критичности: PLANNED ∩ HIGH ⇒ только F-plan-high.
    await applyCriticality(page, 'high');
    await expect(rowByName(page, fPlanHigh)).toBeVisible();
    await expect(rowByName(page, fPlanLow)).toBeHidden(); // отсеян по критичности
    await expect(rowByName(page, fDoneHigh)).toBeHidden(); // отсеян по реализации
    await expect(page.getByTestId('impl-count')).toHaveText('1');
    await expect(page.getByTestId('criticality-count')).toHaveText('1');

    // Сброс «Реализация»: критичность HIGH ещё активна ⇒ видны оба HIGH-требования.
    await resetImplFilter(page);
    await expect(page.getByTestId('impl-count')).toBeHidden();
    await expect(rowByName(page, fPlanHigh)).toBeVisible();
    await expect(rowByName(page, fDoneHigh)).toBeVisible();
    await expect(rowByName(page, fPlanLow)).toBeHidden(); // всё ещё LOW отсеян

    // Полный сброс критичности → снова видны все три требования.
    await page.getByTestId('criticality-filter').click();
    await page.getByTestId('crit-reset').click();
    for (const n of [fPlanHigh, fPlanLow, fDoneHigh]) {
      await expect(rowByName(page, n)).toBeVisible();
    }
    await expect(page.getByTestId('shown-count')).toContainText('Показано 3 из 3');
  });

  // ── T2 + T3 · связи в карточке и их удаление ────────────────────────────────
  test('T2+T3 карточка показывает связи; удаление убирает реципрокную пару у обоих концов', async ({
    page,
  }) => {
    await createProject(page, uniqueName('links-proj'));
    const a = uniqueName('F-A');
    const b = uniqueName('F-B');
    const c = uniqueName('F-C'); // без связей — для пустого состояния
    await addRequirement(page, { kind: 'function', name: a });
    await addRequirement(page, { kind: 'function', name: b });
    await addRequirement(page, { kind: 'function', name: c });

    await linkRequirements(page, a, 'RELATES_TO', b);
    const aSlug = await slugOf(page, a);
    const bSlug = await slugOf(page, b);

    // T2: в карточке источника A виден блок «Связи с ФТ» (RELATES_TO к другому ФТ → FT-секция).
    // Wave 1-2: секции разделены на req-links-ft и req-links-nfr.
    // T4 (todo_17): связи теперь за табом «Связи» (req-tab-links).
    let modal = await openEdit(page, a);
    await page.getByTestId('req-tab-links').click();
    await expect(page.getByTestId('req-links-ft')).toBeVisible();
    const linkToB = page.getByTestId(`req-link-${bSlug}`);
    await expect(linkToB).toBeVisible();
    await expect(linkToB).toHaveAttribute('data-link-type', 'RELATES_TO');
    await expect(linkToB).toContainText(b);

    // T3: удаление с инлайн-подтверждением.
    await page.getByTestId(`req-link-del-${bSlug}`).click();
    await expect(page.getByTestId('req-link-del-confirm')).toBeVisible();
    await page.getByTestId('req-link-del-cancel').click(); // отмена ничего не меняет
    await expect(linkToB).toBeVisible();

    await page.getByTestId(`req-link-del-${bSlug}`).click();
    await page.getByTestId('req-link-del-confirm').click();
    // После удаления у A связей с ФТ не осталось → пустое состояние FT-секции.
    await expect(page.getByTestId(`req-link-${bSlug}`)).toBeHidden();
    await expect(page.getByTestId('req-links-ft-empty')).toBeVisible();

    // Закрыть и переоткрыть A — связь по-прежнему отсутствует (сохранилось на сервере).
    await page.getByTestId('requirement-modal-close').click();
    await expect(modal).toBeHidden();
    modal = await openEdit(page, a);
    await page.getByTestId('req-tab-links').click();
    await expect(page.getByTestId('req-links-ft-empty')).toBeVisible();
    await page.getByTestId('requirement-modal-close').click();
    await expect(modal).toBeHidden();

    // Реципрокная связь у цели B тоже исчезла (RELATES_TO реципрокна, target A = ФТ → FT-секция).
    modal = await openEdit(page, b);
    await page.getByTestId('req-tab-links').click();
    await expect(page.getByTestId(`req-link-${aSlug}`)).toBeHidden();
    await expect(page.getByTestId('req-links-ft-empty')).toBeVisible();
    await page.getByTestId('requirement-modal-close').click();
    await expect(modal).toBeHidden();

    // Требование без связей C — явные пустые состояния обеих секций.
    await openEdit(page, c);
    await page.getByTestId('req-tab-links').click();
    await expect(page.getByTestId('req-links-ft-empty')).toBeVisible();
    await expect(page.getByTestId('req-links-nfr-empty')).toBeVisible();
  });

  // ── T4 · НФТ из строки ФТ (preset BLOCKED_BY) ───────────────────────────────
  test('T4 создание НФТ из строки ФТ: чип BLOCKED_BY у ФТ и реципрокный DEPENDS_ON у НФТ', async ({
    page,
  }) => {
    await createProject(page, uniqueName('nfr-from-ft-proj'));
    const ft = uniqueName('F-pay');
    const nfr = uniqueName('N-pci');
    await addRequirement(page, { kind: 'function', name: ft, criticality: 'HIGH' });

    // Действие «+ НФТ» в строке ФТ → модалка с подсказкой, содержащей имя ФТ.
    await rowByName(page, ft).getByTestId('row-add-nfr').click();
    const modal = page.getByTestId('requirement-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('nfr-from-ft-hint')).toContainText(ft);

    await page.getByTestId('req-name').fill(nfr);
    await expect(page.getByTestId('req-name-status')).toHaveAttribute('data-state', 'ok');
    await page.getByTestId('req-criticality-critical').click();
    await page.getByTestId('req-implemented-yes').click();
    await page.getByTestId('req-submit').click();
    await expect(modal).toBeHidden();

    // НФТ появилось в секции НФТ.
    await expect(rowByName(page, nfr)).toBeVisible();
    await expect(page.getByTestId('section-nfr')).toContainText('(1)');

    const ftSlug = await slugOf(page, ft);
    const nfrSlug = await slugOf(page, nfr);

    // На строке ФТ — чип связи BLOCKED_BY на новое НФТ.
    const ftChip = page.getByTestId(`rel-chip-${ftSlug}-${nfrSlug}`);
    await expect(ftChip).toBeVisible();
    await expect(ftChip).toHaveAttribute('data-rel-type', 'BLOCKED_BY');
    await expect(ftChip).toContainText(nfr);

    // На строке НФТ — реципрокный чип DEPENDS_ON на ФТ.
    const nfrChip = page.getByTestId(`rel-chip-${nfrSlug}-${ftSlug}`);
    await expect(nfrChip).toBeVisible();
    await expect(nfrChip).toHaveAttribute('data-rel-type', 'DEPENDS_ON');
    await expect(nfrChip).toContainText(ft);

    // Та же реципрокная DEPENDS_ON видна и в карточке НФТ (блок «Связи», T2).
    await openEdit(page, nfr);
    await page.getByTestId('req-tab-links').click();
    const linkBack = page.getByTestId(`req-link-${ftSlug}`);
    await expect(linkBack).toBeVisible();
    await expect(linkBack).toHaveAttribute('data-link-type', 'DEPENDS_ON');
    await page.getByTestId('requirement-modal-close').click();
    await expect(modal).toBeHidden();

    // И BLOCKED_BY — в карточке ФТ.
    await openEdit(page, ft);
    await page.getByTestId('req-tab-links').click();
    const linkFwd = page.getByTestId(`req-link-${nfrSlug}`);
    await expect(linkFwd).toBeVisible();
    await expect(linkFwd).toHaveAttribute('data-link-type', 'BLOCKED_BY');
  });

  // ── T5 · человекочитаемый Excel-экспорт ─────────────────────────────────────
  test('T5 экспорт .xlsx: валидный непустой ZIP с листом «Требования»', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('xlsx-ux-proj'));
    await addRequirement(page, {
      kind: 'function',
      name: uniqueName('F-x'),
      criticality: 'HIGH',
      implemented: false,
      quarter: 'Q3',
      year: 2026,
    });
    await addRequirement(page, { kind: 'nfr', name: uniqueName('N-x'), criticality: 'MEDIUM' });

    await page.getByTestId('sidebar-open-export').click();
    await page.getByTestId('export-next').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-fmt-xlsx').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
    const savedPath = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(savedPath);

    const buf = await fs.readFile(savedPath);
    // Непустой и с ZIP local-file-header сигнатурой PK\x03\x04 (xlsx — это ZIP).
    expect(buf.byteLength).toBeGreaterThan(0);
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    // Человекочитаемый вид: лист называется «Требования». Имена листов лежат в
    // xl/workbook.xml внутри ZIP-контейнера. Распакуем через системный unzip.
    const dir = testInfo.outputPath('xlsx-unzip');
    await fs.mkdir(dir, { recursive: true });
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('unzip', ['-o', savedPath, '-d', dir]);
    const workbookXml = await fs.readFile(`${dir}/xl/workbook.xml`, 'utf8');
    expect(workbookXml).toContain('Требования');
  });
});

/**
 * Wave 1-2 UX-фичи: Sidebar-навигация, Inline add child, ExportTasksModal.
 */
test.describe('Wave 1-2 UX', () => {
  // ── UX-4 · Sidebar-навигация между вкладками ────────────────────────────────
  test('UX-4 Sidebar: переключение Requirements ↔ Dashboard', async ({ page }) => {
    await createProject(page, uniqueName('sidebar-nav-proj'));
    // Убеждаемся что мы на странице требований.
    await expect(page.getByTestId('main-page')).toBeVisible();

    // Нажимаем таб Dashboard.
    await page.getByTestId('sidebar-nav-dashboard').click();
    await expect(page).toHaveURL(/\/dashboard/);

    // Нажимаем таб Requirements — возвращаемся к /p/:id.
    await page.getByTestId('sidebar-nav-requirements').click();
    await expect(page).toHaveURL(/\/p\/[^/]+$/);
    await expect(page.getByTestId('main-page')).toBeVisible();
  });

  // ── T-512 · Add child via modal (FR-7.5) ─────────────────────────────────────
  test('T-512 UX-1 — добавить дочерний ФТ через модалку', async ({ page }) => {
    await createProject(page, uniqueName('modal-child-proj'));
    const parent = uniqueName('F-parent');
    await addRequirement(page, { kind: 'function', name: parent, criticality: 'HIGH' });

    // Навести на строку ФТ и нажать кнопку «добавить дочернее требование».
    const parentRow = page.locator(`tr[data-req-name="${parent}"]`);
    await parentRow.hover();
    await parentRow.getByTestId('row-add-child').click();

    // Открывается модалка создания с подсказкой про дочернюю связь.
    await expect(page.getByTestId('requirement-modal')).toBeVisible();
    await expect(page.getByTestId('nfr-from-ft-hint')).toContainText('дочерней для');

    // Заполняем обязательные поля (критичность и реализация не предзаполнены — FR-21).
    const childName = uniqueName('F-child-modal');
    await page.getByTestId('req-name').fill(childName);
    await page.getByTestId('req-criticality-medium').click();
    await page.getByTestId('req-implemented-yes').click();
    await page.getByTestId('req-submit').click();

    // Модалка закрывается, новая строка появляется в дереве под родителем.
    await expect(page.getByTestId('requirement-modal')).toBeHidden();
    await expect(page.locator(`tr[data-req-name="${childName}"]`)).toBeVisible();
  });

  // ── T-512b · Cancel add-child modal ──────────────────────────────────────────
  test('T-512b UX-1 — отмена модалки не создаёт требование', async ({ page }) => {
    await createProject(page, uniqueName('modal-cancel-proj'));
    const parent = uniqueName('F-cancel-parent');
    await addRequirement(page, { kind: 'function', name: parent });

    const parentRow = page.locator(`tr[data-req-name="${parent}"]`);
    await parentRow.hover();
    await parentRow.getByTestId('row-add-child').click();
    await expect(page.getByTestId('requirement-modal')).toBeVisible();

    // Ввести имя и отменить (закрыть без сохранения).
    const cancelledName = uniqueName('F-cancelled');
    await page.getByTestId('req-name').fill(cancelledName);
    await page.getByTestId('req-cancel').click();

    // Модалка скрыта, новая строка не появилась.
    await expect(page.getByTestId('requirement-modal')).toBeHidden();
    await expect(page.locator(`tr[data-req-name="${cancelledName}"]`)).toBeHidden();
  });

  // ── ExportTasksModal · smoke ─────────────────────────────────────────────────
  test('ExportTasksModal: открывается, smoke-экспорт генерирует MD', async ({ page }) => {
    await createProject(page, uniqueName('tasks-modal-proj'));
    await addRequirement(page, { kind: 'function', name: uniqueName('F-t'), criticality: 'HIGH' });
    await addRequirement(page, { kind: 'nfr', name: uniqueName('N-t'), criticality: 'MEDIUM' });

    // Открыть ExportTasksModal через кнопку в Sidebar.
    await page.getByTestId('sidebar-open-tasks').click();
    const modal = page.getByTestId('export-tasks-modal');
    await expect(modal).toBeVisible();

    // Выбрать направление «smoke» — перейти к предпросмотру (нет вопроса об unimpl).
    await page.getByTestId('export-tasks-dir-smoke').click();

    // Предпросмотр MD должен появиться.
    await expect(page.getByTestId('export-tasks-preview')).toBeVisible();

    // Кнопка «Скачать MD» активна.
    await expect(page.getByTestId('export-tasks-download')).toBeEnabled();
  });
});
