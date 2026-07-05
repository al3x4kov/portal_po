import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createProject, projectIdFromUrl, uniqueName } from './helpers/app.js';

/**
 * T-204 · QA — «Данные для выгрузки» (Task 2).
 *
 * Матрица: формат {xlsx, zip, tar.gz} × выбор полей {все / подмножество / минимум}.
 * Проверяем факт скачивания и — для zip/tar.gz — реальный СОСТАВ .md (наличие/отсутствие
 * секций `- source`, тело описания, `#### Info`, `#### Links`; обязательные всегда).
 * Плюс UI-контракт (обязательные залочены, опциональные тогглятся, превью меняется)
 * и скриншот экрана «Формат выгрузки».
 *
 * Контракт полей (backend + frontend):
 *  - обязательные (name/criticality/impl + createdAt/updatedAt) всегда;
 *  - опциональные тумблеры: source, description, info, links (по умолчанию все вкл);
 *  - fields= пусто ⇒ минимум; отсутствует ⇒ все.
 */

const OPTIONAL = ['source', 'description', 'info', 'links'] as const;
type OptionalField = (typeof OPTIONAL)[number];

const SCREENSHOTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'screenshots',
);

// ── API-сиды (быстрая изоляция, без прогона через модалки) ──────────────────

interface RichReqOpts {
  name: string;
  source?: string;
  description?: string;
  infoItems?: { type: string; value: string }[];
}

/** Создать FUNCTION-требование сразу через REST со всеми опциональными полями. */
async function apiCreateRich(page: Page, projectId: string, opts: RichReqOpts): Promise<string> {
  const body: Record<string, unknown> = {
    type: 'FUNCTION',
    name: opts.name,
    criticality: 'HIGH',
    implemented: true,
  };
  if (opts.source) body.source = opts.source;
  if (opts.description) body.description = opts.description;
  if (opts.infoItems) body.infoItems = opts.infoItems;

  const res = await page.request.post(
    `/api/projects/${encodeURIComponent(projectId)}/requirements`,
    { data: body },
  );
  expect(res.ok(), `create requirement failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { slug: string }).slug;
}

/** Связать два требования через REST (CHILD_OF пишется в .md источника). */
async function apiCreateLink(
  page: Page,
  projectId: string,
  sourceSlug: string,
  type: 'CHILD_OF' | 'RELATES_TO',
  targetSlug: string,
): Promise<void> {
  const res = await page.request.post(`/api/projects/${encodeURIComponent(projectId)}/links`, {
    data: { sourceSlug, type, targetSlug },
  });
  expect(res.ok(), `create link failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

// ── UI-помощники экрана «Формат выгрузки» ───────────────────────────────────

/** Открыть ExportModal и дойти до шага format (выбраны все требования по умолчанию). */
async function gotoFormatStep(page: Page): Promise<void> {
  await page.getByTestId('sidebar-open-export').click();
  await expect(page.getByTestId('export-modal')).toBeVisible();
  await page.getByTestId('export-next').click();
  await expect(page.getByTestId('export-fmt-xlsx')).toBeVisible();
}

/** Выставить опциональные тумблеры в нужное состояние. */
async function setOptional(
  page: Page,
  sel: Partial<Record<OptionalField, boolean>>,
): Promise<void> {
  for (const field of OPTIONAL) {
    const want = sel[field];
    if (want === undefined) continue;
    const box = page.getByTestId(`export-field-${field}`);
    if ((await box.isChecked()) !== want) await box.click();
    await expect(box).toBeChecked({ checked: want });
  }
}

/** Кликнуть по формату и сохранить скачанный файл. Возвращает путь и имя. */
async function downloadFormat(
  page: Page,
  fmt: 'xlsx' | 'zip' | 'targz',
  testInfo: TestInfo,
): Promise<{ path: string; filename: string }> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`export-fmt-${fmt}`).click(),
  ]);
  const filename = download.suggestedFilename();
  const target = testInfo.outputPath(filename);
  await download.saveAs(target);
  return { path: target, filename };
}

/** Только файлы требований (под specs/functions|nfr), без корневого project-манифеста. */
const REQ_MD_RE = /specs[\\/](functions|nfr)[\\/][^\\/]+\.md$/;

/** Прочитать .md требований из архива (zip через adm-zip, tar.gz через распаковку tar). */
async function readMdEntries(
  archivePath: string,
  format: 'zip' | 'targz',
  testInfo: TestInfo,
): Promise<{ name: string; content: string }[]> {
  if (format === 'zip') {
    const zip = new AdmZip(archivePath);
    return zip
      .getEntries()
      .filter((e) => !e.isDirectory && REQ_MD_RE.test(e.entryName))
      .map((e) => ({ name: e.entryName, content: e.getData().toString('utf8') }));
  }
  const dir = testInfo.outputPath(`untar-${Date.now().toString(36)}`);
  await fs.mkdir(dir, { recursive: true });
  await tar.x({ file: archivePath, cwd: dir });
  const out: { name: string; content: string }[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (REQ_MD_RE.test(full))
        out.push({ name: full, content: await fs.readFile(full, 'utf8') });
    }
  };
  await walk(dir);
  return out;
}

/** Каждый .md обязан нести обязательные данные (заголовок + мета), независимо от выбора. */
function expectMandatory(content: string): void {
  expect(content).toMatch(/^###\s+Requirement:/m);
  expect(content).toContain('- criticality:');
  expect(content).toContain('- implemented:');
  expect(content).toContain('- createdAt:');
  expect(content).toContain('- updatedAt:');
}

// ── Общий сид: rich-родитель + связанный ребёнок ────────────────────────────

interface Seed {
  projectId: string;
  parentName: string;
  parentSlug: string;
  childSlug: string;
  source: string;
  descBody: string;
  infoType: string;
  infoValue: string;
}

async function seedProject(page: Page, tag: string): Promise<Seed> {
  const source = `SRC-${tag}-${Date.now().toString(36)}`;
  const descBody = `DESCBODY-${tag}-marker-текст описания`;
  const infoType = 'Ссылка';
  const infoValue = `INFO-${tag}-значение`;

  await createProject(page, uniqueName(`exp-${tag}`));
  const projectId = projectIdFromUrl(page);

  const parentName = uniqueName('P-rich');
  const parentSlug = await apiCreateRich(page, projectId, {
    name: parentName,
    source,
    description: descBody,
    infoItems: [{ type: infoType, value: infoValue }],
  });
  const childSlug = await apiCreateRich(page, projectId, { name: uniqueName('C-child') });
  await apiCreateLink(page, projectId, childSlug, 'CHILD_OF', parentSlug);

  // Перечитать страницу, чтобы ExportModal увидел свежие требования из API.
  await page.reload();
  await expect(page.getByTestId('main-page')).toBeVisible();

  return { projectId, parentName, parentSlug, childSlug, source, descBody, infoType, infoValue };
}

// ── zip: все / подмножество / минимум ───────────────────────────────────────

test.describe('T-204 · zip — состав по выбору полей', () => {
  test('все опциональные ⇒ .md содержит source + тело + #### Info, ребёнок #### Links', async ({
    page,
  }, testInfo) => {
    const s = await seedProject(page, 'zip-all');
    await gotoFormatStep(page);
    await setOptional(page, { source: true, description: true, info: true, links: true });
    const { filename, path: archive } = await downloadFormat(page, 'zip', testInfo);

    expect(filename).toMatch(/\.zip$/);
    expect((await fs.stat(archive)).size).toBeGreaterThan(0);

    const entries = await readMdEntries(archive, 'zip', testInfo);
    for (const e of entries) expectMandatory(e.content);

    const parent = entries.find((e) => e.name.includes(s.parentSlug));
    const child = entries.find((e) => e.name.includes(s.childSlug));
    expect(parent, 'parent .md present').toBeTruthy();
    expect(child, 'child .md present').toBeTruthy();

    expect(parent!.content).toContain(`- source: ${s.source}`);
    expect(parent!.content).toContain(s.descBody);
    expect(parent!.content).toContain('#### Info');
    expect(parent!.content).toContain(`- ${s.infoType}: ${s.infoValue}`);
    expect(child!.content).toContain('#### Links');
    expect(child!.content).toContain(`- CHILD_OF: ${s.parentSlug}`);
  });

  test('подмножество (только «Связи») ⇒ #### Links есть, source/описание/#### Info нет', async ({
    page,
  }, testInfo) => {
    const s = await seedProject(page, 'zip-sub');
    await gotoFormatStep(page);
    await setOptional(page, { source: false, description: false, info: false, links: true });
    const { path: archive } = await downloadFormat(page, 'zip', testInfo);

    const entries = await readMdEntries(archive, 'zip', testInfo);
    for (const e of entries) expectMandatory(e.content);

    const parent = entries.find((e) => e.name.includes(s.parentSlug))!;
    const child = entries.find((e) => e.name.includes(s.childSlug))!;

    expect(parent.content).not.toContain('- source:');
    expect(parent.content).not.toContain(s.descBody);
    expect(parent.content).not.toContain('#### Info');
    expect(child.content).toContain('#### Links');
  });

  test('минимум (сняты все опциональные) ⇒ только обязательные секции, архив импортируется', async ({
    page,
  }, testInfo) => {
    const s = await seedProject(page, 'zip-min');
    await gotoFormatStep(page);
    await setOptional(page, { source: false, description: false, info: false, links: false });
    // Превью показывает «минимум».
    await expect(page.getByTestId('export-fields-preview')).toContainText('(минимум)');
    const { path: archive } = await downloadFormat(page, 'zip', testInfo);

    const entries = await readMdEntries(archive, 'zip', testInfo);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expectMandatory(e.content);
      expect(e.content).not.toContain('- source:');
      expect(e.content).not.toContain('#### Info');
      expect(e.content).not.toContain('#### Links');
      expect(e.content).not.toContain(s.descBody);
    }

    // Отфильтрованный архив должен валидно импортироваться (createdAt/updatedAt на месте).
    await page.goto('/');
    await page.getByTestId('start-import').click();
    // T2 (todo_17): файл выбираем ПЕРВЫМ — выбор перезаписывает имя автоименем.
    await page.getByTestId('import-file').setInputFiles(archive);
    await page.getByTestId('import-name').fill(uniqueName('zip-min-reimport'));
    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('main-page')).toBeVisible();
  });
});

// ── tar.gz: все / минимум ───────────────────────────────────────────────────

test.describe('T-204 · tar.gz — состав по выбору полей', () => {
  test('все опциональные ⇒ .md содержит source + тело + #### Info + #### Links', async ({
    page,
  }, testInfo) => {
    const s = await seedProject(page, 'tgz-all');
    await gotoFormatStep(page);
    await setOptional(page, { source: true, description: true, info: true, links: true });
    const { filename, path: archive } = await downloadFormat(page, 'targz', testInfo);

    expect(filename).toMatch(/\.tar\.gz$/);
    expect((await fs.stat(archive)).size).toBeGreaterThan(0);

    const entries = await readMdEntries(archive, 'targz', testInfo);
    for (const e of entries) expectMandatory(e.content);

    const parent = entries.find((e) => e.name.includes(s.parentSlug))!;
    const child = entries.find((e) => e.name.includes(s.childSlug))!;
    expect(parent.content).toContain(`- source: ${s.source}`);
    expect(parent.content).toContain(s.descBody);
    expect(parent.content).toContain('#### Info');
    expect(child.content).toContain('#### Links');
  });

  test('минимум ⇒ только обязательные секции, архив импортируется', async ({ page }, testInfo) => {
    const s = await seedProject(page, 'tgz-min');
    await gotoFormatStep(page);
    await setOptional(page, { source: false, description: false, info: false, links: false });
    const { path: archive } = await downloadFormat(page, 'targz', testInfo);

    const entries = await readMdEntries(archive, 'targz', testInfo);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expectMandatory(e.content);
      expect(e.content).not.toContain('- source:');
      expect(e.content).not.toContain('#### Info');
      expect(e.content).not.toContain('#### Links');
      expect(e.content).not.toContain(s.descBody);
    }

    await page.goto('/');
    await page.getByTestId('start-import').click();
    // T2 (todo_17): файл выбираем ПЕРВЫМ — выбор перезаписывает имя автоименем.
    await page.getByTestId('import-file').setInputFiles(archive);
    await page.getByTestId('import-name').fill(uniqueName('tgz-min-reimport'));
    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('main-page')).toBeVisible();
  });
});

// ── xlsx: факт скачивания при «все» и «минимум» ──────────────────────────────

test.describe('T-204 · xlsx — факт выгрузки при разном выборе полей', () => {
  test('xlsx скачивается валидным (PK) и при всех полях, и при минимуме', async ({
    page,
  }, testInfo) => {
    await seedProject(page, 'xlsx');

    // Все опциональные (дефолт).
    await gotoFormatStep(page);
    const all = await downloadFormat(page, 'xlsx', testInfo);
    expect(all.filename).toMatch(/\.xlsx$/);
    const bufAll = await fs.readFile(all.path);
    expect(bufAll.byteLength).toBeGreaterThan(0);
    expect(bufAll.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    // Минимум — модалка закрылась после скачивания, открываем заново и снимаем все.
    await gotoFormatStep(page);
    await setOptional(page, { source: false, description: false, info: false, links: false });
    const min = await downloadFormat(page, 'xlsx', testInfo);
    expect(min.filename).toMatch(/\.xlsx$/);
    const bufMin = await fs.readFile(min.path);
    expect(bufMin.byteLength).toBeGreaterThan(0);
    expect(bufMin.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });
});

// ── UI-контракт блока «Данные для выгрузки» ──────────────────────────────────

test.describe('T-204 · UI блока полей', () => {
  test('обязательные залочены (checked+disabled), опциональные тогглятся, превью меняется', async ({
    page,
  }) => {
    await createProject(page, uniqueName('exp-ui'));
    const projectId = projectIdFromUrl(page);
    await apiCreateRich(page, projectId, { name: uniqueName('F-ui'), source: 'x' });
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    await gotoFormatStep(page);

    // Обязательные: три чекбокса checked + disabled (снять нельзя).
    for (const id of [
      'export-field-lock-name',
      'export-field-lock-criticality',
      'export-field-lock-impl',
    ]) {
      const lock = page.getByTestId(id);
      await expect(lock).toBeChecked();
      await expect(lock).toBeDisabled();
    }

    // Опциональные по умолчанию все включены; превью содержит все колонки/секции.
    const preview = page.getByTestId('export-fields-preview');
    for (const field of OPTIONAL)
      await expect(page.getByTestId(`export-field-${field}`)).toBeChecked();
    await expect(preview).toContainText('Источник');
    await expect(preview).toContainText('#### Info');
    await expect(preview).toContainText('#### Links');

    // Снять «Источник» → чекбокс off, превью больше не содержит «Источник».
    await page.getByTestId('export-field-source').click();
    await expect(page.getByTestId('export-field-source')).not.toBeChecked();
    await expect(preview).not.toContainText('Источник');

    // Снять всё остальное → превью показывает «минимум».
    await setOptional(page, { description: false, info: false, links: false });
    await expect(preview).toContainText('(минимум)');
    await expect(preview).not.toContainText('#### Info');
    await expect(preview).not.toContainText('#### Links');

    // Вернуть один тумблер обратно.
    await page.getByTestId('export-field-links').click();
    await expect(page.getByTestId('export-field-links')).toBeChecked();
    await expect(preview).toContainText('#### Links');
  });
});

// ── Скриншот экрана «Формат выгрузки» ────────────────────────────────────────

test.describe('T-204 · скриншот экрана «Формат выгрузки»', () => {
  test('снимок блока «Данные для выгрузки» (light + dark)', async ({ page }) => {
    await createProject(page, uniqueName('exp-shot'));
    const projectId = projectIdFromUrl(page);
    await apiCreateRich(page, projectId, {
      name: uniqueName('F-shot'),
      source: 'https://example.com',
      description: 'Демо-описание для снимка',
      infoItems: [{ type: 'Ссылка', value: 'https://ref' }],
    });
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });

    // Light.
    await gotoFormatStep(page);
    await page
      .getByTestId('export-modal')
      .screenshot({ path: path.join(SCREENSHOTS_DIR, 'export-format-light.png') });

    // Dark — закрыть модалку, переключить тему, открыть снова.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('export-modal')).toBeHidden();
    await page.getByTestId('theme-toggle').click();
    await gotoFormatStep(page);
    await page
      .getByTestId('export-modal')
      .screenshot({ path: path.join(SCREENSHOTS_DIR, 'export-format-dark.png') });
  });
});
