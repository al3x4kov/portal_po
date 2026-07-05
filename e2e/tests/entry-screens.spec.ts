import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  apiCreateRequirement,
  createProject,
  projectIdFromUrl,
  uniqueName,
  writeBrokenArchive,
} from './helpers/app.js';

/**
 * T2 (todo_17) · Переработанные входные экраны: Start, NewProject, Import,
 * OpenExisting (макеты new_design/screens/*.html).
 *
 * Покрывает: «Недавние проекты» (localStorage po.recentProjects), автоимя
 * проекта из имени архива, удаление проекта с подтверждением вводом имени
 * (ошибка — внутри диалога), фильтр списка проектов при 8+ проектах.
 */

const RECENTS_KEY = 'po.recentProjects';

/** Project summary as served by the projects API. */
interface ProjectSummary {
  id: string;
  name: string;
  mainPath: string;
}

/** Fast fixture: create a project straight through the REST API. */
async function apiCreateProject(page: Page, name: string): Promise<ProjectSummary> {
  const res = await page.request.post('/api/projects', { data: { name } });
  if (!res.ok()) {
    throw new Error(`POST /api/projects failed (${res.status()}): ${await res.text()}`);
  }
  return (await res.json()) as ProjectSummary;
}

/** Resolve a project's summary by its unique name via the API. */
async function projectByName(page: Page, name: string): Promise<ProjectSummary> {
  const res = await page.request.get('/api/projects');
  if (!res.ok()) throw new Error(`GET /api/projects failed (${res.status()})`);
  const projects = (await res.json()) as ProjectSummary[];
  const found = projects.find((p) => p.name === name);
  if (!found) throw new Error(`project "${name}" not found in GET /api/projects`);
  return found;
}

/** Export the CURRENT project (main screen) as .zip under a custom filename. */
async function exportZipAs(page: Page, testInfo: TestInfo, filename: string): Promise<string> {
  await page.getByTestId('sidebar-open-export').click();
  await page.getByTestId('export-next').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-fmt-zip').click(),
  ]);
  const target = testInfo.outputPath(filename);
  await download.saveAs(target);
  return target;
}

test.describe('T2 · Start: hero-действия и «Недавние проекты»', () => {
  test('пустое состояние: тексты hero-карточек и placeholder recents', async ({ page }) => {
    // Свежий контекст ⇒ localStorage пуст ⇒ recents в пустом состоянии.
    await page.goto('/');
    await expect(page.getByTestId('start-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'С чего начнём?' })).toBeVisible();

    await expect(page.getByTestId('start-new')).toContainText('Создать новый');
    await expect(page.getByTestId('start-import')).toContainText('Импортировать');
    await expect(page.getByTestId('start-open')).toContainText('Открыть существующий');

    const recents = page.getByTestId('recent-projects');
    await expect(recents).toContainText('Недавние проекты');
    await expect(page.getByTestId('recent-empty')).toContainText(
      'Здесь появятся проекты, которые вы недавно открывали.',
    );
    await expect(page.getByTestId('recent-list')).toHaveCount(0);
  });

  test('созданный проект попадает в recents; клик по нему открывает проект', async ({ page }) => {
    const name = uniqueName('recent-create');
    await createProject(page, name);

    await page.goto('/');
    await expect(page.getByTestId('recent-list')).toBeVisible();
    await expect(page.getByTestId('recent-empty')).toHaveCount(0);
    await expect(page.getByTestId('recent-list')).toContainText(name);

    // Формат хранения (spec T2): po.recentProjects = [{id,name,openedAt ISO}].
    const stored = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[],
      RECENTS_KEY,
    );
    expect(Array.isArray(stored)).toBe(true);
    const first = stored[0] as { id: string; name: string; openedAt: string };
    expect(first.name).toBe(name);
    expect(first.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(new Date(first.openedAt).getTime())).toBe(false);

    // Клик по записи recents открывает проект.
    await page.getByTestId(`recent-project-${first.id}`).click();
    await expect(page.getByTestId('main-page')).toBeVisible();
    await expect(page.getByTestId('main-path')).toContainText(name);
  });

  test('recents показывают максимум 5 проектов', async ({ page }) => {
    await page.goto('/');
    await page.evaluate((key) => {
      const now = Date.now();
      const items = Array.from({ length: 6 }, (_, i) => ({
        id: `fake-recent-${i}`,
        name: `Fake recent ${i}`,
        openedAt: new Date(now - i * 60_000).toISOString(),
      }));
      localStorage.setItem(key, JSON.stringify(items));
    }, RECENTS_KEY);
    await page.reload();

    await expect(page.getByTestId('recent-list')).toBeVisible();
    await expect(page.getByTestId('recent-list').locator('li')).toHaveCount(5);
    // Шестая (самая старая) запись не показывается.
    await expect(page.getByTestId('recent-project-fake-recent-5')).toHaveCount(0);
  });
});

test.describe('T2 · NewProject: предпросмотр, подсказка, 409, success', () => {
  test('autofocus, hint про символы и живой предпросмотр «Будет создан проект:»', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('start-new').click();

    // §2.2-1: единственное поле формы в фокусе сразу.
    await expect(page.getByTestId('newproject-name')).toBeFocused();
    // §2.2-2: подсказка о допустимых символах ДО сабмита.
    await expect(
      page.getByText('Допустимы буквы, цифры, пробел, дефис и подчёркивание.'),
    ).toBeVisible();

    const preview = page.getByTestId('newproject-path-preview');
    await expect(preview).toContainText('Будет создан проект:');
    await expect(preview).toContainText('Projects/<имя>');

    const name = uniqueName('preview');
    await page.getByTestId('newproject-name').fill(name);
    await expect(preview).toContainText(`Projects/${name}`);
  });

  test('дубликат имени: точный текст ошибки 409, форма остаётся', async ({ page }) => {
    const name = uniqueName('dup-409');
    await apiCreateProject(page, name);

    await page.goto('/');
    await page.getByTestId('start-new').click();
    await page.getByTestId('newproject-name').fill(name);
    await page.getByTestId('newproject-submit').click();

    await expect(page.getByTestId('newproject-error')).toHaveText(
      'Проект с таким именем уже есть в Projects/. Выберите другое имя.',
    );
    // Ошибка не разрушает форму: имя на месте, можно исправить.
    await expect(page.getByTestId('newproject-name')).toHaveValue(name);
  });

  test('success-состояние: тексты, Main Path и «К списку проектов»', async ({ page }) => {
    const name = uniqueName('success');
    await page.goto('/');
    await page.getByTestId('start-new').click();
    await page.getByTestId('newproject-name').fill(name);
    await page.getByTestId('newproject-submit').click();

    const success = page.getByTestId('newproject-success');
    await expect(success).toBeVisible();
    await expect(success).toContainText(`Проект «${name}» создан`);
    await expect(success).toContainText('Main Path:');
    await expect(page.getByTestId('newproject-mainpath')).toContainText(name);
    await expect(page.getByTestId('newproject-open')).toContainText('Открыть проект');

    // «К списку проектов» возвращает на стартовый экран; проект уже в recents.
    await page.getByTestId('newproject-back').click();
    await expect(page.getByTestId('start-page')).toBeVisible();
    await expect(page.getByTestId('recent-list')).toContainText(name);
  });
});

test.describe('T2 · Import: дропзона, автоимя из архива, причины дизейбла', () => {
  test('автоимя из имени .tar.gz-архива, карточка файла и «Убрать файл»', async ({
    page,
  }, testInfo) => {
    const base = `arch-${uniqueName('T2')}`;
    // Контент архива не важен: автоимя вычисляется на клиенте при выборе файла.
    const archive = await writeBrokenArchive(testInfo, `${base}.tar.gz`);

    await page.goto('/');
    await page.getByTestId('start-import').click();

    // Исходное состояние: дропзона с текстом из макета, причина дизейбла в футере.
    const dropzone = page.getByTestId('import-dropzone');
    await expect(dropzone).toContainText('Перетащите архив сюда или нажмите, чтобы выбрать');
    await expect(page.getByTestId('import-disabled-reason')).toHaveText(
      'Выберите архив и укажите имя',
    );
    await expect(page.getByTestId('import-submit')).toBeDisabled();

    // Выбор файла: карточка вместо дропзоны, имя проекта = имя архива без .tar.gz.
    await page.getByTestId('import-file').setInputFiles(archive);
    await expect(page.getByTestId('import-file-card')).toBeVisible();
    await expect(page.getByTestId('import-file-name')).toHaveText(`${base}.tar.gz`);
    await expect(page.getByTestId('import-name')).toHaveValue(base);
    await expect(page.getByTestId('import-disabled-reason')).toHaveText('Всё готово к импорту');
    await expect(page.getByTestId('import-submit')).toBeEnabled();

    // Автоимя редактируемо; пустое имя даёт причину «Укажите имя проекта».
    await page.getByTestId('import-name').fill('');
    await expect(page.getByTestId('import-disabled-reason')).toHaveText('Укажите имя проекта');
    await expect(page.getByTestId('import-submit')).toBeDisabled();

    // «Убрать файл» возвращает дропзону.
    await page.getByTestId('import-file-remove').click();
    await expect(page.getByTestId('import-file-card')).toHaveCount(0);
    await expect(dropzone).toBeVisible();
    await expect(page.getByTestId('import-disabled-reason')).toHaveText(
      'Выберите архив и укажите имя',
    );
  });

  test('dragover-состояние дропзоны: «Отпустите, чтобы загрузить»', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('start-import').click();
    const dropzone = page.getByTestId('import-dropzone');
    await expect(dropzone).toBeVisible();

    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await dropzone.dispatchEvent('dragover', { dataTransfer });
    await expect(dropzone).toHaveAttribute('data-dragover', 'true');
    await expect(dropzone).toContainText('Отпустите, чтобы загрузить');

    await dropzone.dispatchEvent('dragleave');
    await expect(dropzone).not.toHaveAttribute('data-dragover', 'true');
    await expect(dropzone).toContainText('Перетащите архив сюда или нажмите, чтобы выбрать');
  });

  test('round-trip: экспорт .zip → импорт с автоименем, имя редактируемо (DoD#3)', async ({
    page,
  }, testInfo) => {
    const source = uniqueName('rt-src');
    await createProject(page, source);
    // Экспорт требует хотя бы одно выбранное требование — сеем через API.
    await apiCreateRequirement(page, projectIdFromUrl(page), {
      kind: 'function',
      name: uniqueName('rt-req'),
    });
    // Перезагрузка, чтобы ExportModal увидел свежесозданное требование.
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    const base = `Копия ${uniqueName('rt')}`;
    const archive = await exportZipAs(page, testInfo, `${base}.zip`);

    await page.goto('/');
    await page.getByTestId('start-import').click();
    await page.getByTestId('import-file').setInputFiles(archive);
    // Автоимя = имя архива без расширения .zip.
    await expect(page.getByTestId('import-name')).toHaveValue(base);

    // Имя редактируемо: импортируем под другим именем.
    const finalName = uniqueName('rt-imported');
    await page.getByTestId('import-name').fill(finalName);
    await page.getByTestId('import-submit').click();

    await expect(page.getByTestId('main-page')).toBeVisible();
    await expect(page.getByTestId('main-path')).toContainText(finalName);
  });
});

test.describe('T2 · OpenExisting: удаление с подтверждением вводом имени', () => {
  test('кнопка «Удалить проект» активируется только при точном совпадении имени', async ({
    page,
  }) => {
    const name = uniqueName('del-guard');
    const { id } = await apiCreateProject(page, name);

    await page.goto('/');
    await page.getByTestId('start-open').click();
    await page.getByTestId(`project-delete-${id}`).click();

    const dialog = page.getByTestId('project-delete-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('project-delete-dialog-overlay')).toBeVisible();
    await expect(dialog).toContainText(`Удалить проект «${name}»?`);

    const confirm = page.getByTestId('project-delete-dialog-confirm');
    const input = page.getByTestId('delete-confirm-input');
    // Пока имя не введено — кнопка неактивна.
    await expect(confirm).toBeDisabled();
    // Неточное имя не активирует кнопку.
    await input.fill(`${name}-x`);
    await expect(confirm).toBeDisabled();
    // Точное имя (пробелы по краям обрезаются) активирует.
    await input.fill(`  ${name}  `);
    await expect(confirm).toBeEnabled();
    await expect(confirm).toHaveText('Удалить проект');

    // Escape закрывает диалог, проект цел.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId(`open-project-${id}`)).toBeVisible();
    const still = await projectByName(page, name);
    expect(still.id).toBe(id);
  });

  test('ошибка удаления показывается ВНУТРИ диалога (не toast), кнопка «Повторить удаление»', async ({
    page,
  }) => {
    const name = uniqueName('del-err');
    const { id } = await apiCreateProject(page, name);

    await page.goto('/');
    await page.getByTestId('start-open').click();
    await page.getByTestId(`project-delete-${id}`).click();
    const dialog = page.getByTestId('project-delete-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('delete-confirm-input').fill(name);

    // Симулируем гонку: проект уже удалён с диска за спиной диалога ⇒ DELETE → 404.
    const res = await page.request.delete(`/api/projects/${encodeURIComponent(id)}`);
    expect(res.ok()).toBe(true);

    await page.getByTestId('project-delete-dialog-confirm').click();

    // §2.4-4: ошибка внутри диалога, диалог открыт, кнопка — «Повторить удаление».
    await expect(page.getByTestId('delete-error')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('project-delete-dialog-confirm')).toHaveText(
      'Повторить удаление',
    );
    // Ошибка НЕ уходит в исчезающий toast.
    await expect(page.locator('[data-testid="toast"][data-tone="error"]')).toHaveCount(0);

    await page.getByTestId('project-delete-dialog-cancel').click();
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('T2 · OpenExisting: фильтр списка проектов', () => {
  test('фильтр при 8+ проектах: совпадение, «ничего не найдено», сброс', async ({ page }) => {
    // 8 своих проектов гарантируют порог показа фильтра независимо от соседей.
    const prefix = `flt-${Date.now().toString(36)}`;
    const created: ProjectSummary[] = [];
    for (let i = 0; i < 8; i += 1) {
      created.push(await apiCreateProject(page, `${prefix}-p${i}`));
    }

    await page.goto('/');
    await page.getByTestId('start-open').click();
    await expect(page.getByTestId('open-list')).toBeVisible();

    const filter = page.getByTestId('project-filter');
    await expect(filter).toBeVisible();
    await expect(filter).toHaveAttribute('placeholder', 'Найти проект…');

    // Точное имя ⇒ ровно одна строка.
    const target = created[3];
    await filter.fill(target.name);
    await expect(page.getByTestId(`open-project-${target.id}`)).toBeVisible();
    await expect(page.getByTestId('open-list').locator('li')).toHaveCount(1);

    // Запрос без совпадений ⇒ пустое состояние с текстом запроса.
    const miss = `нет-такого-${prefix}`;
    await filter.fill(miss);
    await expect(page.getByTestId('open-list')).toHaveCount(0);
    await expect(page.getByTestId('open-filter-empty')).toHaveText(
      `Ничего не найдено по запросу «${miss}».`,
    );

    // Сброс фильтра возвращает полный список (как минимум наши 8).
    await filter.fill('');
    await expect(page.getByTestId('open-filter-empty')).toHaveCount(0);
    for (const p of created) {
      await expect(page.getByTestId(`open-project-${p.id}`)).toBeVisible();
    }
  });
});
