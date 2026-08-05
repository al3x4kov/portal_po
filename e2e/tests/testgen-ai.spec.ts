import { expect, test, type Page } from '@playwright/test';
import { addRequirement, createProject, slugOf, uniqueName } from './helpers/app.js';
import { startAiStub, type AiStub } from './helpers/ai-stub.js';

/**
 * Развилка «Генерации артефактов» для тестовых моделей (смок / крит-регресс /
 * полный регресс): детерминированный шаблон ИЛИ AI-генерация md-файла с
 * анти-галлюцинационной проверкой.
 *
 * Сценарии:
 *   1. шаблонный путь через новый шаг «Способ» — прежний результат, ноль
 *      вызовов AI;
 *   2. AI happy-path: модель проекта в селекте, живой журнал, кейсы модели в
 *      предпросмотре (`source: ai`), скачивание;
 *   3. галлюцинации: чужой slug отброшен, пропущенное требование достроено
 *      шаблоном (`source: template-fallback`), счётчики в шапке файла и warn
 *      в журнале.
 *
 * AI hub — общий детерминированный стаб (helpers/ai-stub.ts): на QA-промпт
 * отвечает кейсом на каждую строку батча; пропуски/лишние кейсы настраиваются.
 */
test.describe.configure({ mode: 'serial' });

const STUB_MODELS = ['GigaChat-2-Pro', 'GigaChat-2'];

let stub: AiStub;

test.beforeAll(async () => {
  stub = await startAiStub({ models: STUB_MODELS, reply: 'ok' });
});

test.afterAll(async () => {
  await stub.close();
});

/** id from a `/p/:id/...` URL. */
function projectId(page: Page): string {
  const m = /\/p\/([^/?#]+)/.exec(page.url());
  if (!m) throw new Error(`Not on a project page: ${page.url()}`);
  return decodeURIComponent(m[1]);
}

/** Настроить AI текущего проекта на стаб (экран «Настройка AI»). */
async function configureAi(page: Page): Promise<void> {
  const id = projectId(page);
  await page.goto(`/p/${id}/ai`);
  await page.getByTestId('ai-baseurl-input').fill(stub.baseUrl);
  await page.getByTestId('ai-key-input').fill('sk-e2e-testgen');
  await page.getByTestId('ai-models-refresh').click();
  await expect(page.getByTestId('ai-model-select')).toBeVisible();
  await page.getByTestId('ai-model-select').selectOption('GigaChat-2-Pro');
  await page.getByTestId('ai-save').click();
  await expect(page.getByTestId('ai-key-saved')).toBeVisible();
  await page.goto(`/p/${id}`);
  await expect(page.getByTestId('main-page')).toBeVisible();
}

/** Проект с двумя ФТ под смок-модель (BLOCKER + HIGH, оба корни). */
async function projectWithTwoFts(page: Page): Promise<{ f1: string; f2: string }> {
  const tag = uniqueName('tg');
  await createProject(page, uniqueName('tg-proj'));
  const f1 = `${tag}-вход`;
  const f2 = `${tag}-выход`;
  await addRequirement(page, { kind: 'function', name: f1, criticality: 'BLOCKER' });
  await addRequirement(page, { kind: 'function', name: f2, criticality: 'HIGH' });
  return { f1, f2 };
}

test('шаблонный путь через шаг «Способ»: прежний smoke-файл, ноль AI-вызовов', async ({ page }) => {
  await projectWithTwoFts(page);
  const callsBefore = stub.testgenRequests.length;

  await page.getByTestId('sidebar-open-tasks').click();
  await page.getByTestId('export-tasks-dir-smoke').click();
  await page.getByTestId('gen-direction-next').click();
  // Развилка: оба способа на экране.
  await expect(page.getByTestId('export-mode-template')).toBeVisible();
  await expect(page.getByTestId('export-mode-ai')).toBeVisible();
  await page.getByTestId('export-mode-template').click();
  await page.getByTestId('gen-template-start').click();

  await page.getByTestId('gen-view-markdown').click();
  const preview = page.getByTestId('export-tasks-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('# Smoke-модель тестирования');
  await expect(preview).toContainText('SMK-001');
  expect(stub.testgenRequests.length).toBe(callsBefore);
});

test('AI-путь: модель проекта, журнал прогона, кейсы модели в предпросмотре', async ({ page }) => {
  const { f1 } = await projectWithTwoFts(page);
  await configureAi(page);

  await page.getByTestId('sidebar-open-tasks').click();
  await page.getByTestId('export-tasks-dir-smoke').click();
  await page.getByTestId('gen-direction-next').click();
  await page.getByTestId('export-mode-ai').click();

  // Шаг «Способ и параметры»: модель проекта подставлена, чекбокс негативов есть.
  await expect(page.getByTestId('gen-ai-model-select')).toHaveValue('GigaChat-2-Pro');
  await expect(page.getByTestId('gen-ai-negatives')).toBeVisible();
  await page.getByTestId('gen-ai-start').click();

  // Результат: кейсы модели с бейджем AI, сырой md — с пометкой source: ai.
  await expect(page.getByTestId('gen-cases')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('gen-badge-ai')).toContainText('AI-кейсов: 2');
  await page.getByTestId('gen-view-markdown').click();
  const preview = page.getByTestId('export-tasks-preview');
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await expect(preview).toContainText('Сгенерировано AI (модель: GigaChat-2-Pro)');
  await expect(preview).toContainText(`AI-кейс: ${f1}`);
  await expect(preview).toContainText('source: ai');
  await expect(preview).toContainText('Кейсов от модели: 2, достроено шаблоном: 0');

  // Журнал прогона виден рядом с результатом — не нужно уходить «Назад».
  const log = page.getByTestId('gen-ai-log');
  await expect(log).toBeVisible();
  await expect(log).toContainText('Батч 1/1');
  await expect(log).toContainText('Готово: AI-кейсов 2');
});

test('анти-галлюцинации: чужой slug отброшен, пропуск достроен шаблоном, счётчики честные', async ({
  page,
}) => {
  const { f1, f2 } = await projectWithTwoFts(page);
  await configureAi(page);
  // Стаб «пропускает» второе требование (реальный slug из API) и добавляет
  // кейс с выдуманным slug — сервер обязан отбросить его как галлюцинацию.
  const slugF2 = await slugOf(page, f2);
  try {
    stub.setTestgenExtraCases([
      {
        slug: 'vydumannoe-trebovanie',
        title: 'Галлюцинация',
        goal: 'x',
        precondition: 'x',
        steps: ['x'],
        expected: 'x',
      },
    ]);
    stub.setTestgenSkipSlugs([slugF2]);

    await page.getByTestId('sidebar-open-tasks').click();
    await page.getByTestId('export-tasks-dir-smoke').click();
    await page.getByTestId('gen-direction-next').click();
    await page.getByTestId('export-mode-ai').click();
    await page.getByTestId('gen-ai-start').click();

    await expect(page.getByTestId('gen-cases')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('gen-view-markdown').click();
    const preview = page.getByTestId('export-tasks-preview');
    await expect(preview).toBeVisible({ timeout: 15_000 });
    // Кейс f1 — от модели; f2 — шаблонный fallback; галлюцинация не попала в файл.
    await expect(preview).toContainText(`AI-кейс: ${f1}`);
    await expect(preview).toContainText('source: template-fallback');
    await expect(preview).not.toContainText('Галлюцинация');
    await expect(preview).toContainText('отброшено ответов с несуществующей привязкой: 1');
    await expect(preview).toContainText('достроено шаблоном: 1');

    // Журнал: warn о галлюцинации и пропуске с именем требования.
    const log = page.getByTestId('gen-ai-log');
    await expect(log).toContainText('отброшено галлюцинаций: 1');
    await expect(log).toContainText('без кейса (достроим шаблоном)');
  } finally {
    stub.setTestgenExtraCases(null);
    stub.setTestgenSkipSlugs(null);
  }
});
