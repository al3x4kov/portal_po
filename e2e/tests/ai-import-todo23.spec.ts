import path from 'node:path';
import AdmZip from 'adm-zip';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  startAiStub,
  batchExtractionFilesOf,
  structureBatchOf,
  type AiStub,
} from './helpers/ai-stub.js';
import { createProject, projectIdFromUrl, rowByName, uniqueName } from './helpers/app.js';
import { approveDocsReviewGates, expectAiImportSummary } from './helpers/ai-import.js';

/**
 * todo_23 · E2E «Экономика вызовов AI-импорта» — видимые пользователю эффекты
 * мероприятий M1–M5 (unit-часть покрыта бэкендом, apps/server/test/ai-import-todo23.test.ts):
 *
 *   M1 (батчинг): мелкие файлы ОДНОГО класса источника уходят одним
 *       extraction-вызовом; строка прогресса пакета —
 *       «Файл <имя> (+ещё K) (фрагмент X из Y (N файлов)): запрос к модели…»,
 *       одиночные файлы сохраняют прежний формат «(фрагмент X/Y)».
 *   M3 (честные счётчики): testid `ai-import-extracted` в running
 *       (+`ai-import-extracted-functions`/`-nfrs`), в панели «Остановлено» и в
 *       error-блоке; при extracted>created — строка «…сохранены в контрольной
 *       точке, „Продолжить“ доведёт до создания» и бэкенд-строка лога
 *       «Извлечено N записей…».
 *   M4 (восстановление параллелизма): после 429-деградации и серии успешных
 *       фрагментов в логе INFO «Параллелизм восстановлен до K из N…».
 *       (Таймаут-деградация в E2E не воспроизводится дёшево: ретрай после
 *       per-call таймаута ждёт 15–30 с по дизайну — путь покрыт unit-тестами;
 *       здесь используется 429 — тот же ParallelismGovernor.)
 *   M5 (пульс описи): на архиве ≥50 файлов в логе «Опись: просмотрено файлов…».
 *
 * Упстрим — общий in-process стаб (helpers/ai-stub.ts): батч-вызовы
 * распознаются по «Пакет из N файлов…» и отвечают конкатенацией
 * пофайловых фикстур; классы файлов управляются СОДЕРЖИМЫМ (контентные
 * эвристики inventoryStage: «GET /…» → api-spec, «безопасность» → security,
 * «Руководство администратора» → admin-guide, прочее → other).
 */

const STUB_MODELS = ['Qwen-Coder-Next', 'GigaChat-2-Pro'];
const JOB_TIMEOUT = { timeout: 30_000 } as const;

/* ── Фикстуры: мелкие файлы одного класса (S1) ────────────────────────────── */

/** Мелкий plain-md без ключевых слов эвристик → класс 'other'. */
function smallDoc(title: string, body: string): string {
  return [`# ${title}`, '', body, ''].join('\n');
}

const BATCH_FILES: Record<string, string> = {
  's1.md': smallDoc('Первый раздел', 'Система должна регистрировать заявку.'),
  's2.md': smallDoc('Второй раздел', 'Система должна назначать исполнителя.'),
  's3.md': smallDoc('Третий раздел', 'Система должна закрывать заявку.'),
  's4.md': smallDoc('Четвёртый раздел', 'Ответ выдаётся быстро.'),
  's5.md': smallDoc('Пятый раздел', 'Данные хранятся надёжно.'),
  's6.md': smallDoc('Шестой раздел', 'Журнал ведётся постоянно.'),
};

const B_FT1 = 'Батч: регистрация заявки';
const B_FT2 = 'Батч: назначение исполнителя';
const B_FT3 = 'Батч: закрытие заявки';
const B_NFR1 = 'Батч: скорость ответа';
const B_NFR2 = 'Батч: надёжность хранения';
const B_NFR3 = 'Батч: постоянный журнал';

/** Большой одиночный файл ≥ chunkChars (12 000 у __default__-пресета) —
 *  остаётся отдельной единицей с прежним пофайловым чанкованием. Заголовок
 *  «Руководство администратора» даёт класс admin-guide по эвристике (без
 *  LLM-классификации), т.е. файл гарантированно не попадает в батч 'other'. */
function bigAdminGuide(chars: number): string {
  const line = 'Установка сервера выполняется по шагам без дополнительных требований. ';
  let text = '# Руководство администратора\n\n';
  while (text.length < chars) text += line;
  return text;
}

/* ── Фикстуры: три класса → три единицы работы (S2) ───────────────────────── */

const CANCEL_FILES: Record<string, string> = {
  'api.md': '# API\nGET /tickets\nСервис возвращает список заявок.\n',
  'sec.md': '# Безопасность\nПароли хранятся в зашифрованном виде.\n',
  'plain.md': smallDoc('Заметки', 'Процесс обработки заявок описан ниже.'),
};
const C_FT_API = 'Отмена: список заявок по API';
const C_FT_SEC = 'Отмена: шифрование паролей';
const C_NFR_PLAIN = 'Отмена: регламент обработки';

/* ── Фикстуры: сбой после первого вызова (S3) ─────────────────────────────── */

const FAIL_FILES: Record<string, string> = {
  'api-err.md': '# API\nPOST /orders\nСервис создаёт заказ.\n',
  'plain-err.md': smallDoc('Приложение', 'Заказ хранится один год.'),
};
const F_FT = 'Сбой: создание заказа';
const F_NFR = 'Сбой: срок хранения заказа';

/* ── Фикстуры: пульс описи (S4) и восстановление параллелизма (S5) ────────── */

const PULSE_FT = 'Опись: функция из первого файла';
const RESTORE_FT = 'Восстановление: функция после 429';

let stub: AiStub;

test.beforeAll(async () => {
  stub = await startAiStub({
    models: STUB_MODELS,
    reply: 'Ответ ассистента (не используется в этом спеке).',
    extractionItemsByFile: {
      's1.md': [rec('FUNCTION', B_FT1, 's1.md § Первый раздел')],
      's2.md': [rec('FUNCTION', B_FT2, 's2.md § Второй раздел')],
      's3.md': [rec('FUNCTION', B_FT3, 's3.md § Третий раздел')],
      's4.md': [rec('NFR', B_NFR1, 's4.md § Четвёртый раздел')],
      's5.md': [rec('NFR', B_NFR2, 's5.md § Пятый раздел')],
      's6.md': [rec('NFR', B_NFR3, 's6.md § Шестой раздел')],
      'api.md': [rec('FUNCTION', C_FT_API, 'api.md § API')],
      'sec.md': [rec('FUNCTION', C_FT_SEC, 'sec.md § Безопасность')],
      'plain.md': [rec('NFR', C_NFR_PLAIN, 'plain.md § Заметки')],
      'api-err.md': [rec('FUNCTION', F_FT, 'api-err.md § API')],
      'plain-err.md': [rec('NFR', F_NFR, 'plain-err.md § Приложение')],
      'note-01.md': [rec('FUNCTION', PULSE_FT, 'note-01.md § Файл 1')],
      'aa-restore.md': [rec('FUNCTION', RESTORE_FT, 'aa-restore.md § Раздел')],
    },
  });
});

test.afterAll(async () => {
  await stub.close();
});

/* ── Helpers (дисциплина ai-import.spec.ts) ───────────────────────────────── */

/** Extraction-запись стаба. */
function rec(type: 'FUNCTION' | 'NFR', name: string, source: string): Record<string, unknown> {
  return { type, name, description: `${name} — описание для E2E.`, source };
}

async function configureAi(page: Page, projectId: string, model: string): Promise<void> {
  const res = await page.request.put('/api/ai/config', {
    data: { baseURL: stub.baseUrl, apiKey: 'sk-e2e-todo23-key', projectId, model },
  });
  if (!res.ok()) throw new Error(`PUT /api/ai/config failed (${res.status()})`);
}

/** Новый проект + AI-конфиг + reload, чтобы футер увидел конфиг. */
async function projectWithAi(page: Page, prefix: string): Promise<string> {
  await createProject(page, uniqueName(prefix));
  const id = projectIdFromUrl(page);
  await configureAi(page, id, 'Qwen-Coder-Next');
  await page.reload();
  await expect(page.getByTestId('main-page')).toBeVisible();
  return id;
}

function makeZip(testInfo: TestInfo, name: string, files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [entry, content] of Object.entries(files)) {
    zip.addFile(entry, Buffer.from(content, 'utf8'));
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

async function startAnalysis(page: Page): Promise<string> {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/ai-import'),
    ),
    page.getByTestId('ai-import-start').click(),
  ]);
  expect(res.status()).toBe(202);
  const body = (await res.json()) as { jobId: string };
  return body.jobId;
}

interface ReqDto {
  slug: string;
  name: string;
  type: string;
  source?: string;
}

async function listRequirements(page: Page, projectId: string): Promise<ReqDto[]> {
  const res = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/requirements`);
  if (!res.ok()) throw new Error(`GET requirements failed (${res.status()})`);
  const body = (await res.json()) as { requirements: ReqDto[] };
  return body.requirements;
}

async function attachShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

/* ══ S1 · M1: батчинг мелких файлов одного класса ═════════════════════════ */

test.describe('todo_23 · AI-импорт: батчинг, счётчики, пульс, параллелизм', () => {
  test('батчинг: 6 мелких файлов одного класса — один вызов с пакетной строкой прогресса, большой файл — прежний формат; provenance по файлам сохранён', async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const id = await projectWithAi(page, 'T23-Batch');

    // 6 мелких 'other' + большой admin-guide (~12,5k → 2 фрагмента).
    const zip = makeZip(testInfo, 'docs-batch.zip', {
      ...BATCH_FILES,
      'zz-guide.md': bigAdminGuide(12_500),
    });
    const callsBefore = stub.extractionRequests.length;
    const structureBefore = stub.structureRequests.length;

    await openAiImport(page);
    await chooseFile(page, zip);
    await startAnalysis(page);
    await approveDocsReviewGates(page);

    const success = page.getByTestId('ai-import-success');
    await expect(success).toBeVisible(JOB_TIMEOUT);
    await expectAiImportSummary(page, {
      functions: 3,
      nfrs: 3,
      treeLinks: 0,
      relatesLinks: 0,
      skipped: 0,
    });
    await attachShot(page, testInfo, 'batch-success');

    // Лог: пакетная строка прогресса нового формата (запрос + результат)…
    const log = page.getByTestId('ai-import-log');
    await expect(log).toContainText(
      'Файл s1.md (+ещё 5) (фрагмент 1 из 1 (6 файлов)): запрос к модели…',
    );
    await expect(log).toContainText(
      'Файл s1.md (+ещё 5) (фрагмент 1 из 1 (6 файлов)): извлечено 3 ФТ, 3 НФТ.',
    );
    // …а одиночный большой файл сохраняет прежний формат «(фрагмент X/Y)»
    // (точное число фрагментов решает адаптивный чанкер — не фиксируем его).
    await expect(log).toContainText(/Файл zz-guide\.md \(фрагмент 1\/\d+\): запрос к модели…/);

    // Батчинг реально сократил вызовы: 1 батч на 6 мелких файлов + фрагменты
    // большого — extraction-строк «Файл …: запрос к модели…» МЕНЬШЕ числа
    // файлов (7). Строку structure-стадии («Структура: батч …») не считаем.
    const logText = (await log.innerText()).toString();
    const requestLines = logText.match(/Файл [^\n]*: запрос к модели…/g) ?? [];
    const bigChunkLines =
      logText.match(/Файл zz-guide\.md \(фрагмент \d+\/\d+\): запрос к модели…/g) ?? [];
    expect(requestLines).toHaveLength(1 + bigChunkLines.length);
    expect(requestLines.length).toBeLessThan(7);

    // Стаб видел столько же extraction-вызовов; батч несёт все 6 путей
    // по порядку описи.
    const calls = stub.extractionRequests.slice(callsBefore);
    expect(calls).toHaveLength(requestLines.length);
    const batchCall = calls.find((c) => batchExtractionFilesOf(c).length > 0);
    expect(batchCall, 'ровно один батч-вызов с разделителями «=== Файл: … ===»').toBeDefined();
    expect(batchExtractionFilesOf(batchCall)).toEqual([
      's1.md',
      's2.md',
      's3.md',
      's4.md',
      's5.md',
      's6.md',
    ]);

    // Provenance по файлам пережил батчинг: source каждой записи в structure-
    // батче указывает на СВОЙ файл пакета.
    const structureCalls = stub.structureRequests.slice(structureBefore);
    expect(structureCalls.length).toBeGreaterThan(0);
    const structureItems = structureCalls.flatMap((c) => structureBatchOf(c));
    const sourceOf = new Map(structureItems.map((i) => [i.name, i.source]));
    expect(sourceOf.get(B_FT1)).toBe('s1.md § Первый раздел');
    expect(sourceOf.get(B_FT2)).toBe('s2.md § Второй раздел');
    expect(sourceOf.get(B_NFR3)).toBe('s6.md § Шестой раздел');

    // API-истина: все 6 требований созданы; «Источник» — бизнес-поле, пуст.
    await page.getByTestId('ai-import-done').click();
    const reqs = await listRequirements(page, id);
    for (const name of [B_FT1, B_FT2, B_FT3, B_NFR1, B_NFR2, B_NFR3]) {
      const matches = reqs.filter((r) => r.name === name);
      expect(matches, `«${name}» создано ровно один раз`).toHaveLength(1);
      expect(matches[0]!.source ?? '').toBe('');
    }
    await expect(rowByName(page, B_FT1)).toBeVisible();
  });

  /* ══ S2 · M3: живые extracted-счётчики и «Остановлено» с контрольной точкой ══ */

  test('остановка до записи: extracted-счётчики в running, «Остановлено» со строкой контрольной точки, resume доводит до создания без дублей', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const id = await projectWithAi(page, 'T23-Stop');

    // Три файла ТРЁХ разных классов → три единицы работы по 4 с каждая:
    // счётчики успевают вырасти, а отмена ложится до populate.
    const zip = makeZip(testInfo, 'docs-stop.zip', CANCEL_FILES);
    stub.setExtractionDelay(4000);
    try {
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      // M3: живой блок «извлечено (ждёт записи)» появляется во время running…
      const extracted = page.getByTestId('ai-import-extracted');
      await expect(extracted).toBeVisible(JOB_TIMEOUT);
      await expect(extracted).toContainText('извлечено (ждёт записи):');
      const counterTotal = async (): Promise<number> =>
        Number(await page.getByTestId('ai-import-extracted-functions').innerText()) +
        Number(await page.getByTestId('ai-import-extracted-nfrs').innerText());
      expect(await counterTotal()).toBeGreaterThan(0);
      await attachShot(page, testInfo, 'extracted-live');

      // …и растёт по мере обработки следующих единиц работы.
      await expect.poll(counterTotal, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

      // «Остановить» до populate: created=0, extracted>0.
      await page.getByTestId('ai-import-stop').click();
      await expect(page.getByTestId('ai-import-stop-confirm')).toBeVisible();
      await page.getByTestId('ai-import-stop-confirm-confirm').click();
      await expect(page.getByTestId('ai-import-cancelled')).toBeVisible(JOB_TIMEOUT);

      // Панель «Остановлено»: created=0 честно, извлечённое не потеряно.
      const cancelled = page.getByTestId('ai-import-cancelled-summary');
      await expect(cancelled).toBeVisible();
      await expect(cancelled).toContainText('Успели создать: 0 ФТ, 0 НФТ');
      await expect(cancelled).toContainText(
        'сохранены в контрольной точке, «Продолжить» доведёт до создания',
      );
      // Бэкенд-строка лога (M3) — с точными счётчиками записей.
      await expect(page.getByTestId('ai-import-log')).toContainText(
        /Извлечено \d+ записей \(ФТ \d+, НФТ \d+\) — они сохранены в контрольной точке; „Продолжить“ доведёт до создания\./,
      );
      // Кнопки состояния cancelled при extracted>created: обещанный текстом
      // «Продолжить» (primary, тот же testid, что в failed) + «Повторить
      // анализ» + «Готово».
      await expect(page.getByTestId('ai-import-retry')).toBeVisible();
      await expect(page.getByTestId('ai-import-done')).toBeVisible();
      const resume = page.getByTestId('ai-import-resume');
      await expect(resume).toBeVisible();
      await attachShot(page, testInfo, 'cancelled-checkpoint');

      // «Продолжить» из панели «Остановлено» доводит извлечённое до создания
      // (через гейт выверки — одобряем обе зоны)…
      stub.setExtractionDelay(0);
      await resume.click();
      await approveDocsReviewGates(page);
      await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);

      // …ровно по одному экземпляру каждого требования — без дублей.
      const reqs = await listRequirements(page, id);
      for (const name of [C_FT_API, C_FT_SEC, C_NFR_PLAIN]) {
        expect(
          reqs.filter((r) => r.name === name),
          `«${name}» создано ровно один раз`,
        ).toHaveLength(1);
      }

      // Пользовательская проверка: после закрытия модалки — требования в дереве.
      await page.getByTestId('ai-import-done').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);
      await expect(rowByName(page, C_FT_API)).toBeVisible();
      await expect(rowByName(page, C_NFR_PLAIN)).toBeVisible();
    } finally {
      stub.setExtractionDelay(0);
    }
  });

  /* ══ S3 · M3: сбой после первого вызова — extracted в error-блоке, resume ══ */

  test('сбой апстрима после первого вызова: NET-02, строка контрольной точки в error-блоке и логе, «Продолжить» доводит до конца', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000); // NET-02 = серия попыток с экспоненциальным backoff
    const id = await projectWithAi(page, 'T23-Fail');

    // Два файла разных классов → две единицы; первый вызов успешен, дальше 500.
    const zip = makeZip(testInfo, 'docs-fail.zip', FAIL_FILES);
    stub.failExtractionAfterCalls(1);
    try {
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      // Таксономическая ошибка сети/апстрима.
      const error = page.getByTestId('ai-import-error');
      await expect(error).toBeVisible({ timeout: 120_000 });
      await expect(page.getByTestId('ai-import-error-code')).toContainText('NET-02');

      // M3: в failed-блоке — строка «извлечено … сохранены в контрольной точке».
      const extracted = page.getByTestId('ai-import-extracted');
      await expect(extracted).toBeVisible();
      await expect(extracted).toContainText(
        'сохранены в контрольной точке, «Продолжить» доведёт до создания',
      );
      // Бэкенд-строка лога: ровно 1 запись первой единицы уже извлечена.
      await expect(page.getByTestId('ai-import-log')).toContainText(
        /Извлечено 1 записей \(ФТ \d+, НФТ \d+\) — они сохранены в контрольной точке; „Продолжить“ доведёт до создания\./,
      );
      await attachShot(page, testInfo, 'failed-checkpoint');

      // Починка апстрима → «Продолжить» доводит до создания обеих записей
      // (гейт выверки на возобновлённом прогоне одобряем).
      stub.failExtractionAfterCalls(null);
      await page.getByTestId('ai-import-resume').click();
      await approveDocsReviewGates(page);
      await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
      await expectAiImportSummary(page, {
        functions: 1,
        nfrs: 1,
        treeLinks: 0,
        relatesLinks: 0,
        skipped: 0,
      });

      await page.getByTestId('ai-import-done').click();
      const reqs = await listRequirements(page, id);
      for (const name of [F_FT, F_NFR]) {
        expect(
          reqs.filter((r) => r.name === name),
          `«${name}» создано ровно один раз`,
        ).toHaveLength(1);
      }
    } finally {
      stub.failExtractionAfterCalls(null);
    }
  });

  /* ══ S4 · M5: пульс описи на архиве ≥50 файлов + батчинг всей пачки ═══════ */

  test('архив из 60 мелких файлов: в логе пульс «Опись: просмотрено файлов…», вся пачка уходит одним вызовом', async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    await projectWithAi(page, 'T23-Pulse');

    // 60 мелких plain-файлов одного класса ('other'); запись даёт только первый.
    const files: Record<string, string> = {};
    for (let i = 1; i <= 60; i += 1) {
      const nn = String(i).padStart(2, '0');
      files[`note-${nn}.md`] = smallDoc(`Файл ${i}`, `Содержимое заметки номер ${i}.`);
    }
    const zip = makeZip(testInfo, 'docs-pulse.zip', files);
    const callsBefore = stub.extractionRequests.length;

    await openAiImport(page);
    await chooseFile(page, zip);
    await startAnalysis(page);
    await approveDocsReviewGates(page);

    const success = page.getByTestId('ai-import-success');
    await expect(success).toBeVisible(JOB_TIMEOUT);

    // M5: пульс стадии описи (каждые 50 просмотренных файлов).
    const log = page.getByTestId('ai-import-log');
    await expect(log).toContainText('Опись: просмотрено файлов 50 из 60…');
    // M1: вся пачка из 60 мелких файлов — один батч-вызов (критерий №1).
    await expect(log).toContainText('Файл note-01.md (+ещё 59) (фрагмент 1 из 1 (60 файлов))');
    expect(stub.extractionRequests.slice(callsBefore)).toHaveLength(1);

    await expectAiImportSummary(page, {
      functions: 1,
      nfrs: 0,
      treeLinks: 0,
      relatesLinks: 0,
      skipped: 0,
    });
    await attachShot(page, testInfo, 'inventory-pulse');
  });

  /* ══ S5 · M4: деградация параллелизма (429) и восстановление в логе ═══════ */

  test('429 → параллелизм снижен до 1; после серии успешных фрагментов в логе «Параллелизм восстановлен до 2 из 2»', async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    await projectWithAi(page, 'T23-Restore');

    // Первая единица работы — МЕЛКИЙ admin-guide (один фрагмент, в полёте
    // ровно один вызов): обе 429 достаются его вызову детерминированно —
    // openai-клиент сервера сам ретраит один раз (AI_HUB_MAX_RETRIES=1),
    // поэтому одиночный 429 он «проглотил» бы без деградации. Затем большой
    // admin-guide (~55k → несколько фрагментов, пул K=2) даёт серию успешных
    // фрагментов для восстановления K. Путь по классу общий (admin-guide),
    // порядок внутри класса — по пути: aa-… раньше zz-….
    const zip = makeZip(testInfo, 'docs-restore.zip', {
      'aa-restore.md': '# Руководство администратора\nСистема должна работать после сбоя.\n',
      'zz-wide.md': bigAdminGuide(55_000),
    });
    stub.failNextExtraction429(2);
    try {
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);
      await approveDocsReviewGates(page);

      const success = page.getByTestId('ai-import-success');
      await expect(success).toBeVisible(JOB_TIMEOUT);

      const log = page.getByTestId('ai-import-log');
      // Деградация видима и объяснена…
      await expect(log).toContainText('параллелизм снижен до 1');
      // …и восстановление тоже (M4: каждое изменение эффективного K — в логе).
      await expect(log).toContainText(
        'Параллелизм восстановлен до 2 из 2 после серии успешных фрагментов.',
      );
      await attachShot(page, testInfo, 'parallelism-restored');

      await expectAiImportSummary(page, {
        functions: 1,
        nfrs: 0,
        treeLinks: 0,
        relatesLinks: 0,
        skipped: 0,
      });
    } finally {
      stub.failNextExtraction429(0);
    }
  });
});
