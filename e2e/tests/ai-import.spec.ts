import { promises as fs } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startAiStub, type AiStub } from './helpers/ai-stub.js';
import { createProject, projectIdFromUrl, rowByName, uniqueName } from './helpers/app.js';

/**
 * Task 11 · E2E for «AI подгрузка ФТ и НФТ из документации» (spec §5 matrix).
 *
 * The modal (`AiImportModal`) uploads a zip/tar.gz archive to
 * `POST /api/projects/:id/ai-import` (202 + jobId), polls
 * `GET /api/ai-import/:jobId` (~800 ms) and can `POST …/cancel`. The upstream
 * AI Hub is the shared stub (helpers/ai-stub.ts): extraction calls are
 * recognised by their distinct system prompt and answered with a DETERMINISTIC
 * JSON array per doc file name — so the same archive always yields the same
 * requirements (idempotency) and the stub's `extractionRequests` lets tests
 * assert the model and the number of chunk calls end-to-end.
 *
 * The global AI config (`.ai-config.json` in PROJECTS_ROOT) is shared across
 * spec files, so every test configures (or resets) it explicitly via
 * `PUT /api/ai/config` — the same discipline as chat-widget.spec.ts.
 *
 * Job-status transitions arrive via 800 ms polling → all status-transition
 * expectations use web-first assertions with a 30 s timeout, never sleeps.
 * The running/cancel/confirm scenarios get their deterministic time window
 * from `stub.setExtractionDelay(ms)` (per-chunk upstream latency); happy-path
 * runs keep the delay at 0.
 */

const STUB_MODELS = ['Qwen-Coder-Next', 'GigaChat-2-Pro'];
const JOB_TIMEOUT = { timeout: 30_000 } as const;

/* ── Deterministic extraction fixtures (stub answers per doc file) ────────── */

const DOCS: Record<string, string> = {
  'auth.md': [
    '# Авторизация',
    '',
    '## Вход',
    'Система должна позволять вход по логину и паролю.',
    '',
    '## Восстановление',
    'Система должна позволять восстановление пароля по email.',
    '',
  ].join('\n'),
  'reports.md': [
    '# Отчёты',
    '',
    '## Производительность',
    'Формирование отчёта должно занимать не более 5 секунд.',
    '',
  ].join('\n'),
  'ops.md': ['# Эксплуатация', '', '## Логи', 'Логи должны ротироваться ежедневно.', ''].join('\n'),
  // Nested-directory archive (task 13): keys are archive-RELATIVE paths.
  'overview.md': ['# Обзор', 'Система должна вести реестр требований.', ''].join('\n'),
  'docs/api/auth.md': [
    '# API авторизации',
    '',
    '## Вход',
    'Вход в API должен выполняться по токену.',
    '',
  ].join('\n'),
  'docs/nfr/perf.md': [
    '# Производительность API',
    '',
    '## Отклик',
    'Отклик API не должен превышать 200 мс.',
    '',
  ].join('\n'),
};

const REQ_LOGIN = 'Вход по логину и паролю';
const REQ_RESET = 'Восстановление пароля по email';
const REQ_REPORT = 'Отчёт формируется не дольше 5 секунд';
const REQ_LOGS = 'Ротация логов ежедневно';
const REQ_TREE_OVERVIEW = 'Ведение реестра требований';
const REQ_TREE_TOKEN = 'Вход в API по токену';
const REQ_TREE_LATENCY = 'Отклик API не дольше 200 мс';

const EXTRACTION_ITEMS: Record<string, unknown[]> = {
  'auth.md': [
    {
      type: 'FUNCTION',
      name: REQ_LOGIN,
      description: 'Система позволяет вход по логину и паролю.',
      source: 'auth.md § Вход',
    },
    {
      type: 'FUNCTION',
      name: REQ_RESET,
      description: 'Система позволяет восстановить пароль по email.',
      source: 'auth.md § Восстановление',
      parentName: REQ_LOGIN,
    },
  ],
  'reports.md': [
    {
      type: 'NFR',
      name: REQ_REPORT,
      description: 'Формирование отчёта занимает не более 5 секунд.',
      source: 'reports.md § Производительность',
    },
  ],
  'ops.md': [
    {
      type: 'NFR',
      name: REQ_LOGS,
      description: 'Логи ротируются ежедневно.',
      source: 'ops.md § Логи',
    },
  ],
  // Nested-directory archive (task 13): the stub matches by the FULL relative
  // path from «Файл: <path> (фрагмент …)», so keys carry directories.
  'overview.md': [
    {
      type: 'FUNCTION',
      name: REQ_TREE_OVERVIEW,
      description: 'Система ведёт реестр требований.',
      source: 'overview.md § Обзор',
    },
  ],
  'docs/api/auth.md': [
    {
      type: 'FUNCTION',
      name: REQ_TREE_TOKEN,
      description: 'Вход в API выполняется по токену.',
      source: 'docs/api/auth.md § Вход',
    },
  ],
  'docs/nfr/perf.md': [
    {
      type: 'NFR',
      name: REQ_TREE_LATENCY,
      description: 'Отклик API не превышает 200 мс.',
      source: 'docs/nfr/perf.md § Отклик',
    },
  ],
};

let stub: AiStub;

test.beforeAll(async () => {
  stub = await startAiStub({
    models: STUB_MODELS,
    reply: 'Стабовый ответ ассистента.',
    extractionItemsByFile: EXTRACTION_ITEMS,
  });
});

test.afterAll(async () => {
  await stub.close();
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Global AI config → «no key» state through the official API (task 10). */
async function resetAiConfig(page: Page): Promise<void> {
  const res = await page.request.put('/api/ai/config', { data: { apiKey: null } });
  if (!res.ok()) throw new Error(`PUT /api/ai/config {apiKey:null} failed (${res.status()})`);
}

/** Store key+baseURL (global) and the model for `projectId` via the API. */
async function configureAi(page: Page, projectId: string, model: string): Promise<void> {
  const res = await page.request.put('/api/ai/config', {
    data: { baseURL: stub.baseUrl, apiKey: 'sk-e2e-import-key', projectId, model },
  });
  if (!res.ok()) throw new Error(`PUT /api/ai/config failed (${res.status()})`);
}

/** Build a zip archive from in-memory files; returns its on-disk path. */
function makeZip(testInfo: TestInfo, name: string, files: Record<string, string | Buffer>): string {
  const zip = new AdmZip();
  for (const [entry, content] of Object.entries(files)) {
    zip.addFile(entry, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  }
  const target = testInfo.outputPath(name);
  zip.writeZip(target);
  return target;
}

/** Build a tar.gz archive from in-memory files; returns its on-disk path. */
async function makeTarGz(
  testInfo: TestInfo,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const srcDir = testInfo.outputPath(`targz-src-${name.replace(/\W+/g, '-')}`);
  await fs.mkdir(srcDir, { recursive: true });
  for (const [entry, content] of Object.entries(files)) {
    await fs.writeFile(path.join(srcDir, entry), content, 'utf8');
  }
  const target = testInfo.outputPath(name);
  await tar.create({ gzip: true, file: target, cwd: srcDir }, Object.keys(files));
  return target;
}

/** Open the AI-import modal from the project footer. */
async function openAiImport(page: Page): Promise<void> {
  await page.getByTestId('footer-ai-import').click();
  await expect(page.getByTestId('ai-import')).toBeVisible();
}

/** Pick an archive through the hidden file input; the file card must appear. */
async function chooseFile(page: Page, archivePath: string): Promise<void> {
  await page.getByTestId('ai-import-file').setInputFiles(archivePath);
  await expect(page.getByTestId('ai-import-file-name')).toContainText(path.basename(archivePath));
}

/** Click «Запустить анализ» and return the started job's id (202 body). */
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

/** GET /api/projects/:id/requirements through the page's request context. */
async function listRequirements(
  page: Page,
  projectId: string,
): Promise<Array<{ name: string; type: string; source?: string }>> {
  const res = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/requirements`);
  if (!res.ok()) throw new Error(`GET requirements failed (${res.status()})`);
  const body = (await res.json()) as {
    requirements: Array<{ name: string; type: string; source?: string }>;
  };
  return body.requirements;
}

/** Attach a full-page screenshot to the test artifacts (no snapshot compare). */
async function attachShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

/* ── Tests (spec §5 matrix) ───────────────────────────────────────────────── */

test.describe('Task 11 · AI подгрузка ФТ/НФТ из документации', () => {
  /* §5.1 + §5.2 + §5.7(idle): кнопка, gating запуска, закрытие без confirm. */

  test('кнопка в футере открывает модалку; запуск заблокирован без файла; X при idle закрывает без подтверждения', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('AiImp-Open'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'Qwen-Coder-Next');
    await page.reload(); // pick up the fresh AI config in the UI
    await expect(page.getByTestId('main-page')).toBeVisible();

    // Footer button sits in the project footer and opens the modal.
    await expect(page.getByTestId('footer-ai-import')).toBeVisible();
    await openAiImport(page);
    await expect(page.getByTestId('ai-import-drop')).toBeVisible();

    // No file yet → start is disabled with the mandated tooltip.
    const start = page.getByTestId('ai-import-start');
    await expect(start).toBeDisabled();
    await expect(start).toHaveAttribute('title', 'Загрузите архив документации');

    // Selecting an archive activates the start button.
    const zip = makeZip(testInfo, 'docs.zip', { 'auth.md': DOCS['auth.md']! });
    await chooseFile(page, zip);
    await expect(start).toBeEnabled();
    await attachShot(page, testInfo, 'setup-file-selected');

    // Idle X: closes immediately, no ConfirmDialog involved.
    await page.getByTestId('ai-import-close').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);
    await expect(page.getByTestId('ai-import-confirm')).toHaveCount(0);
  });

  /* §5.3: без ключа — серый селект с тултипом, запуск disabled. */

  test('без API-ключа: селект модели disabled с тултипом, запуск заблокирован даже с файлом', async ({
    page,
  }, testInfo) => {
    await resetAiConfig(page); // clear the key stored by earlier specs/tests
    await createProject(page, uniqueName('AiImp-NoKey'));
    await openAiImport(page);

    // Model select is disabled and wrapped in the tooltip hint.
    await expect(page.getByTestId('ai-import-model-select')).toBeDisabled();
    const hint = page.getByTestId('ai-import-model-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveAttribute('title', /API-ключ/);

    // Even with an archive selected the start button stays disabled.
    const zip = makeZip(testInfo, 'docs.zip', { 'auth.md': DOCS['auth.md']! });
    await chooseFile(page, zip);
    const start = page.getByTestId('ai-import-start');
    await expect(start).toBeDisabled();
    await expect(start).toHaveAttribute('title', 'Настройте AI Hub');
    await attachShot(page, testInfo, 'setup-no-key');
  });

  /* §5.4: happy-path zip → 100%, лог, итоги, дерево, провенанс. */

  test('happy-path zip: прогресс до 100%, итоги, требования в дереве, провенанс в «Источник»', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('AiImp-Happy'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'Qwen-Coder-Next');
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    const zip = makeZip(testInfo, 'docs.zip', {
      'auth.md': DOCS['auth.md']!,
      'reports.md': DOCS['reports.md']!,
    });
    const callsBefore = stub.extractionRequests.length;

    await openAiImport(page);
    await chooseFile(page, zip);
    await startAnalysis(page);

    // Job finishes: success block with the exact counters (2 ФТ + 1 НФТ, 1 связь).
    const success = page.getByTestId('ai-import-success');
    await expect(success).toBeVisible(JOB_TIMEOUT);
    await expect(success).toContainText('Создано: 2 ФТ и 1 НФТ');
    await expect(success).toContainText('связей: 1');
    await expect(success).toContainText('Пропущено как существующие: 0');
    await expect(page.getByTestId('ai-import-progress-pct')).toHaveText('100%');

    // The work log is populated (stages + created items).
    const log = page.getByTestId('ai-import-log');
    await expect(log).toContainText('Распаковка архива');
    await expect(log).toContainText(`Создано: «${REQ_LOGIN}» (FUNCTION).`);
    await attachShot(page, testInfo, 'success');

    // The stub saw one extraction call per doc file, with the project model.
    const calls = stub.extractionRequests.slice(callsBefore);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.model).toBe('Qwen-Coder-Next');

    // «Закрыть и перейти к проекту» → modal gone, tree already refreshed.
    await page.getByTestId('ai-import-done').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);
    await expect(rowByName(page, REQ_LOGIN)).toBeVisible();
    await expect(rowByName(page, REQ_RESET)).toBeVisible();
    await expect(rowByName(page, REQ_REPORT)).toBeVisible();

    // Provenance (FR-19): the «Источник» field carries файл § раздел.
    const reqs = await listRequirements(page, id);
    const byName = new Map(reqs.map((r) => [r.name, r]));
    expect(byName.get(REQ_LOGIN)?.source).toBe('auth.md § Вход');
    expect(byName.get(REQ_RESET)?.source).toBe('auth.md § Восстановление');
    expect(byName.get(REQ_REPORT)?.source).toBe('reports.md § Производительность');
  });

  /* Task 13: архив с древовидной структурой директорий — относительные пути
     в «Файл:», «Директория текущего файла» и карта архива в каждом
     extraction-вызове; не-doc файлы (png) в карту не попадают. */

  test('архив с вложенными директориями: требования из вложенных файлов, карта архива и директория в запросах к модели', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('AiImp-Tree'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'Qwen-Coder-Next');
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    // Tree-shaped archive: root doc + two nested docs + a non-doc binary.
    const zip = makeZip(testInfo, 'docs-tree.zip', {
      'overview.md': DOCS['overview.md']!,
      'docs/api/auth.md': DOCS['docs/api/auth.md']!,
      'docs/nfr/perf.md': DOCS['docs/nfr/perf.md']!,
      'docs/img/pixel.png': Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
      ]),
    });
    const callsBefore = stub.extractionRequests.length;

    await openAiImport(page);
    await chooseFile(page, zip);
    await startAnalysis(page);

    // Success with requirements extracted from the NESTED files too.
    const success = page.getByTestId('ai-import-success');
    await expect(success).toBeVisible(JOB_TIMEOUT);
    await expect(success).toContainText('Создано: 2 ФТ и 1 НФТ');
    await attachShot(page, testInfo, 'tree-success');

    await page.getByTestId('ai-import-done').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);
    await expect(rowByName(page, REQ_TREE_OVERVIEW)).toBeVisible();
    await expect(rowByName(page, REQ_TREE_TOKEN)).toBeVisible();
    await expect(rowByName(page, REQ_TREE_LATENCY)).toBeVisible();

    // Provenance keeps the FULL relative path of the nested source file.
    const reqs = await listRequirements(page, id);
    const byName = new Map(reqs.map((r) => [r.name, r]));
    expect(byName.get(REQ_TREE_TOKEN)?.source).toBe('docs/api/auth.md § Вход');
    expect(byName.get(REQ_TREE_LATENCY)?.source).toBe('docs/nfr/perf.md § Отклик');
    expect(byName.get(REQ_TREE_OVERVIEW)?.source).toBe('overview.md § Обзор');

    // The stub captured one extraction call per DOC file — the png caused none.
    const calls = stub.extractionRequests.slice(callsBefore);
    expect(calls).toHaveLength(3);
    const userOf = (relPath: string): string => {
      const call = calls.find((c) =>
        (c.messages?.find((m) => m.role === 'user')?.content ?? '').startsWith(
          `Файл: ${relPath} (фрагмент`,
        ),
      );
      expect(call, `extraction call for ${relPath}`).toBeDefined();
      return call?.messages?.find((m) => m.role === 'user')?.content ?? '';
    };

    // Nested file: full relative path, its directory and the archive map.
    const authMsg = userOf('docs/api/auth.md');
    expect(authMsg).toContain('Директория текущего файла: docs/api');
    expect(authMsg).toContain('Структура архива (файлы документации):');
    for (const rel of ['docs/api/auth.md', 'docs/nfr/perf.md', 'overview.md']) {
      expect(authMsg).toContain(rel);
    }

    // Root-level file is labelled «корень архива».
    const overviewMsg = userOf('overview.md');
    expect(overviewMsg).toContain('Директория текущего файла: корень архива');
    expect(overviewMsg).toContain('Структура архива (файлы документации):');

    // Non-doc file never reaches the archive map of ANY extraction call.
    for (const call of calls) {
      const user = call.messages?.find((m) => m.role === 'user')?.content ?? '';
      expect(user).not.toContain('pixel.png');
    }
  });

  /* §5.5: идемпотентность — повторный запуск того же архива только пропускает. */

  test('повторный запуск того же архива: created=0, skipped>0, без дублей в проекте', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('AiImp-Idem'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'Qwen-Coder-Next');
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    const zip = makeZip(testInfo, 'docs.zip', {
      'auth.md': DOCS['auth.md']!,
      'reports.md': DOCS['reports.md']!,
    });

    // First run creates 3 requirements.
    await openAiImport(page);
    await chooseFile(page, zip);
    await startAnalysis(page);
    await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
    await page.getByTestId('ai-import-done').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);
    expect(await listRequirements(page, id)).toHaveLength(3);

    // Second run of the SAME archive: nothing created, all skipped.
    await openAiImport(page);
    await chooseFile(page, zip);
    await startAnalysis(page);
    const success = page.getByTestId('ai-import-success');
    await expect(success).toBeVisible(JOB_TIMEOUT);
    await expect(success).toContainText('Создано: 0 ФТ и 0 НФТ');
    await expect(success).toContainText('связей: 0');
    await expect(success).toContainText('Пропущено как существующие: 3');
    await attachShot(page, testInfo, 'idempotent-second-run');
    await page.getByTestId('ai-import-done').click();

    // The project still has exactly the original 3 requirements.
    expect(await listRequirements(page, id)).toHaveLength(3);
  });

  /* §5.6: отмена кнопкой «Остановить» → cancelled, закрытие без confirm. */

  test('отмена: «Остановить» переводит job в cancelled; модалка закрывается без подтверждения', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('AiImp-Cancel'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'Qwen-Coder-Next');
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    // 3 doc files × 1.5 s per extraction call → a comfortable running window.
    const zip = makeZip(testInfo, 'docs.zip', {
      'auth.md': DOCS['auth.md']!,
      'reports.md': DOCS['reports.md']!,
      'ops.md': DOCS['ops.md']!,
    });
    stub.setExtractionDelay(1500);
    try {
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      // Running view: stage + progress + stop button.
      const stop = page.getByTestId('ai-import-stop');
      await expect(stop).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-import-stage')).toBeVisible();
      await attachShot(page, testInfo, 'running');

      // Stop → the job cancels on the next chunk boundary.
      await stop.click();
      await expect(page.getByTestId('ai-import-cancelled')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-import-log')).toContainText(
        'Автоматизация остановлена пользователем',
      );
      await expect(page.getByTestId('ai-import-cancelled-close')).toBeVisible();
      await attachShot(page, testInfo, 'cancelled');

      // After cancellation the X closes silently — no ConfirmDialog.
      await page.getByTestId('ai-import-close').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);
      await expect(page.getByTestId('ai-import-confirm')).toHaveCount(0);
    } finally {
      stub.setExtractionDelay(0);
    }
  });

  /* §5.7: X при running → ConfirmDialog; отказ продолжает, подтверждение отменяет. */

  test('X при running: «Продолжить анализ» оставляет работу; «Остановить и закрыть» отменяет job', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('AiImp-Confirm'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'Qwen-Coder-Next');
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    // 3 files × 2 s per call ≈ 6 s of guaranteed running time.
    const zip = makeZip(testInfo, 'docs.zip', {
      'auth.md': DOCS['auth.md']!,
      'reports.md': DOCS['reports.md']!,
      'ops.md': DOCS['ops.md']!,
    });
    stub.setExtractionDelay(2000);
    try {
      await openAiImport(page);
      await chooseFile(page, zip);
      const jobId = await startAnalysis(page);
      await expect(page.getByTestId('ai-import-stop')).toBeVisible(JOB_TIMEOUT);

      // X while running → ConfirmDialog appears instead of closing.
      await page.getByTestId('ai-import-close').click();
      const confirm = page.getByTestId('ai-import-confirm');
      await expect(confirm).toBeVisible();
      await attachShot(page, testInfo, 'confirm-on-close');

      // «Продолжить анализ»: dialog closes, the job keeps running.
      await page.getByTestId('ai-import-confirm-cancel').click();
      await expect(confirm).toHaveCount(0);
      await expect(page.getByTestId('ai-import')).toBeVisible();
      await expect(page.getByTestId('ai-import-stop')).toBeVisible();

      // X again → «Остановить и закрыть»: modal closes, job is cancelled.
      await page.getByTestId('ai-import-close').click();
      await expect(confirm).toBeVisible();
      await page.getByTestId('ai-import-confirm-confirm').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);

      // The server-side job really reaches `cancelled` (next chunk boundary).
      await expect
        .poll(
          async () => {
            const res = await page.request.get(`/api/ai-import/${encodeURIComponent(jobId)}`);
            const body = (await res.json()) as { status?: string };
            return body.status;
          },
          { timeout: 30_000, message: 'job must become cancelled after confirm-close' },
        )
        .toBe('cancelled');
    } finally {
      stub.setExtractionDelay(0);
    }
  });

  /* §5.8a: ошибка этапа analyze (стаб 500) → блок ошибки + «Что делать», retry. */

  test('ошибка AI Hub (500): блок ошибки с инструкцией; «Повторить анализ» возвращает к запуску', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('AiImp-Err'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'Qwen-Coder-Next');
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    const zip = makeZip(testInfo, 'docs.zip', { 'auth.md': DOCS['auth.md']! });
    stub.setChatMode('error');
    try {
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      // Failed job → error block: stage, message, mandatory «Что делать» hint (§4).
      const error = page.getByTestId('ai-import-error');
      await expect(error).toBeVisible(JOB_TIMEOUT);
      await expect(error).toContainText('Извлечение требований');
      await expect(error).toContainText('Что делать:');
      await expect(error).toContainText('Проверьте доступность AI Hub');
      // The API key never leaks into the user-facing message.
      await expect(error).not.toContainText('sk-e2e-import-key');
      await attachShot(page, testInfo, 'stage-error');

      // «Повторить анализ» → back to setup with the file kept.
      await page.getByTestId('ai-import-retry').click();
      const start = page.getByTestId('ai-import-start');
      await expect(start).toBeVisible();
      await expect(start).toBeEnabled();
      await expect(page.getByTestId('ai-import-file-name')).toContainText('docs.zip');

      // After fixing the upstream, the retry actually succeeds.
      stub.setChatMode('ok');
      await startAnalysis(page);
      await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
    } finally {
      stub.setChatMode('ok');
    }
  });

  /* §5.8b: архив без файлов документации → ошибка unpack с инструкцией. */

  test('архив без .md/.txt: ошибка этапа распаковки с инструкцией про файлы документации', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('AiImp-NoDocs'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'Qwen-Coder-Next');
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    // A zip whose only entry is a binary .png — no documentation inside.
    const zip = makeZip(testInfo, 'image-only.zip', {
      'diagram.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
    });
    await openAiImport(page);
    await chooseFile(page, zip);
    await startAnalysis(page);

    const error = page.getByTestId('ai-import-error');
    await expect(error).toBeVisible(JOB_TIMEOUT);
    await expect(error).toContainText('Распаковка архива');
    await expect(error).toContainText('нет файлов документации');
    await expect(error).toContainText('Что делать:');
    await expect(error).toContainText('Добавьте документацию в архив и повторите');
    await attachShot(page, testInfo, 'no-docs-error');
  });

  /* §5.9: tar.gz работает так же, как zip. */

  test('tar.gz happy-path: анализ завершается успехом, требование появляется в дереве', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('AiImp-TarGz'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'Qwen-Coder-Next');
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    const archive = await makeTarGz(testInfo, 'docs.tar.gz', { 'ops.md': DOCS['ops.md']! });
    await openAiImport(page);
    await chooseFile(page, archive);
    await startAnalysis(page);

    const success = page.getByTestId('ai-import-success');
    await expect(success).toBeVisible(JOB_TIMEOUT);
    await expect(success).toContainText('Создано: 0 ФТ и 1 НФТ');
    await attachShot(page, testInfo, 'targz-success');

    await page.getByTestId('ai-import-done').click();
    await expect(rowByName(page, REQ_LOGS)).toBeVisible();

    const reqs = await listRequirements(page, id);
    expect(reqs.find((r) => r.name === REQ_LOGS)?.source).toBe('ops.md § Логи');
  });
});
