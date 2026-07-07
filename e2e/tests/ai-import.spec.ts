import { promises as fs } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  startAiStub,
  structureBatchOf,
  structureParentsListOf,
  type AiStub,
} from './helpers/ai-stub.js';
import {
  apiCreateRequirement,
  createProject,
  expandNode,
  openEdit,
  projectIdFromUrl,
  rowByName,
  setTreeMode,
  uniqueName,
} from './helpers/app.js';
import { expectAiImportSummary } from './helpers/ai-import.js';

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
 *
 * Task 13 additions: the pipeline is unpack → analyze → structure → aggregate
 * → populate. The stub answers the NEW structure calls (system prompt «Ты —
 * архитектор дерева требований…») by echoing every BATCH item with a parent
 * from its parents map — the tree comes ONLY from that answer. Imported
 * requirements keep «Источник» EMPTY and are created implemented. The
 * dedicated Task 13 describe block covers hierarchy, fields, JSON retries and
 * the structure stage visibility.
 *
 * Task 14 (tree validity): the structure user message now carries THREE
 * sections — archive map, FULL allowed-parents list (`TYPE\tимя`) and the
 * batch (`TYPE\tимя\tисточник`); structure calls go with max_tokens 4000
 * (extraction stays 2000). The Task 14 describe block covers the tree summary
 * log line and the foreign-node coverage warn (B5).
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
      // Task 13 B2: extraction-time parentName is IGNORED by the pipeline —
      // the tree comes ONLY from the structure stage (see structureParents).
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
    // Task 13 B2: parents now come ONLY from the structure stage. The default
    // map reproduces the pre-13 auth.md hierarchy (RESET under LOGIN) so the
    // happy-path/idempotency counters («связей: 1») stay meaningful; tests
    // that need a different tree override it via setStructureParents.
    structureParents: { [REQ_RESET]: REQ_LOGIN },
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

/** Click «Начать анализ» and return the started job's id (202 body). */
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

/** Requirement DTO subset the import tests assert on (fields + links). */
interface ReqDto {
  slug: string;
  name: string;
  type: string;
  source?: string;
  implemented?: boolean;
  targetQuarter?: string;
  targetYear?: number;
  links: Array<{ type: string; targetSlug: string }>;
}

/** GET /api/projects/:id/requirements through the page's request context. */
async function listRequirements(page: Page, projectId: string): Promise<ReqDto[]> {
  const res = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/requirements`);
  if (!res.ok()) throw new Error(`GET requirements failed (${res.status()})`);
  const body = (await res.json()) as { requirements: ReqDto[] };
  return body.requirements;
}

/** CHILD_OF target slugs of one requirement (empty array → root). */
function childOfTargets(req: ReqDto | undefined): string[] {
  return (req?.links ?? []).filter((l) => l.type === 'CHILD_OF').map((l) => l.targetSlug);
}

/** RELATES_TO target slugs of one requirement (symmetric — paired records). */
function relatesTargets(req: ReqDto | undefined): string[] {
  return (req?.links ?? []).filter((l) => l.type === 'RELATES_TO').map((l) => l.targetSlug);
}

/** Attach a full-page screenshot to the test artifacts (no snapshot compare). */
async function attachShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

/** Fresh project with AI configured; returns the project id. */
async function projectWithAi(page: Page, prefix: string): Promise<string> {
  await createProject(page, uniqueName(prefix));
  const id = projectIdFromUrl(page);
  await configureAi(page, id, 'Qwen-Coder-Next');
  await page.reload();
  await expect(page.getByTestId('main-page')).toBeVisible();
  return id;
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
    // T5 (todo_17): new title + «Начать анализ» label + footer hint/cancel.
    await expect(page.getByTestId('ai-import')).toContainText('AI-импорт документации');

    // No file yet → start is disabled with the mandated tooltip; the same
    // reason is readable text in the footer hint.
    const start = page.getByTestId('ai-import-start');
    await expect(start).toBeDisabled();
    await expect(start).toHaveText('Начать анализ');
    await expect(start).toHaveAttribute('title', 'Загрузите архив документации');
    await expect(page.getByTestId('ai-import-footer-hint')).toHaveText(
      'Загрузите архив документации',
    );
    await expect(page.getByTestId('ai-import-cancel')).toBeVisible();

    // Selecting an archive activates the start button; the hint flips.
    const zip = makeZip(testInfo, 'docs.zip', { 'auth.md': DOCS['auth.md']! });
    await chooseFile(page, zip);
    await expect(start).toBeEnabled();
    await expect(page.getByTestId('ai-import-footer-hint')).toHaveText(
      'Файл выбран — можно начинать',
    );
    await attachShot(page, testInfo, 'setup-file-selected');

    // «Отмена» in the setup footer closes silently too — reopen for the X check.
    await page.getByTestId('ai-import-cancel').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);
    await openAiImport(page);

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

  /* §5.4: happy-path zip → 100%, лог, итоги, дерево; «Источник» пуст (Task 13). */

  test('happy-path zip: прогресс до 100%, итоги, требования в дереве, «Источник» пуст', async ({
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

    // Job finishes: success view with the 5-row summary TABLE (§2.18.3):
    // 2 ФТ + 1 НФТ, 1 связь в дереве, 0 связей НФТ↔ФТ, 0 пропущено.
    const success = page.getByTestId('ai-import-success');
    await expect(success).toBeVisible(JOB_TIMEOUT);
    await expect(success).toContainText('Анализ завершён');
    await expectAiImportSummary(page, {
      functions: 2,
      nfrs: 1,
      treeLinks: 1,
      relatesLinks: 0,
      skipped: 0,
    });
    await expect(page.getByTestId('ai-import-progress-pct')).toHaveText('100%');

    // The work log is populated (stages + created items).
    const log = page.getByTestId('ai-import-log');
    await expect(log).toContainText('Распаковка архива');
    await expect(log).toContainText(`Создано: «${REQ_LOGIN}» (FUNCTION).`);
    await attachShot(page, testInfo, 'success');

    // The stub saw one extraction call per doc file, with the project model.
    // todo_18 (58b7342): import calls now request the model's FULL generation
    // budget (`preset.maxOutputTokens`) instead of a per-call cap — 'Qwen-Coder-Next'
    // has no explicit preset, so it resolves to __default__ (maxOutputTokens 4000).
    const calls = stub.extractionRequests.slice(callsBefore);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.model).toBe('Qwen-Coder-Next');
      expect(call['max_tokens']).toBe(4000);
    }

    // «Готово» → modal gone, tree already refreshed.
    await page.getByTestId('ai-import-done').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);
    await expect(rowByName(page, REQ_LOGIN)).toBeVisible();
    await expect(rowByName(page, REQ_RESET)).toBeVisible();
    await expect(rowByName(page, REQ_REPORT)).toBeVisible();

    // Task 13 A1/A2: «Источник» is a BUSINESS field — imports leave it empty
    // (provenance lives in the job log only); everything imported is created
    // as already implemented, so no target quarter/year.
    const reqs = await listRequirements(page, id);
    const byName = new Map(reqs.map((r) => [r.name, r]));
    for (const name of [REQ_LOGIN, REQ_RESET, REQ_REPORT]) {
      const req = byName.get(name);
      expect(req?.source ?? '', `source of «${name}» must stay empty`).toBe('');
      expect(req?.implemented, `«${name}» must be created implemented`).toBe(true);
      expect(req?.targetQuarter).toBeUndefined();
      expect(req?.targetYear).toBeUndefined();
    }
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
    await expectAiImportSummary(page, {
      functions: 2,
      nfrs: 1,
      treeLinks: 0,
      relatesLinks: 0,
      skipped: 0,
    });
    await attachShot(page, testInfo, 'tree-success');

    await page.getByTestId('ai-import-done').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);
    await expect(rowByName(page, REQ_TREE_OVERVIEW)).toBeVisible();
    await expect(rowByName(page, REQ_TREE_TOKEN)).toBeVisible();
    await expect(rowByName(page, REQ_TREE_LATENCY)).toBeVisible();

    // Task 13 A1: even for nested files the business field «Источник» stays
    // empty — file provenance is job-log-only.
    const reqs = await listRequirements(page, id);
    const byName = new Map(reqs.map((r) => [r.name, r]));
    for (const name of [REQ_TREE_TOKEN, REQ_TREE_LATENCY, REQ_TREE_OVERVIEW]) {
      expect(byName.get(name)?.source ?? '', `source of «${name}» must stay empty`).toBe('');
    }

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
    await expectAiImportSummary(page, {
      functions: 0,
      nfrs: 0,
      treeLinks: 0,
      relatesLinks: 0,
      skipped: 3,
    });
    await attachShot(page, testInfo, 'idempotent-second-run');
    await page.getByTestId('ai-import-done').click();

    // The project still has exactly the original 3 requirements.
    expect(await listRequirements(page, id)).toHaveLength(3);
  });

  /* §5.6 + §2.18.1 (T5): «Остановить» открывает mini-confirm; «Продолжить
     анализ» возвращает к прогрессу, «Остановить» реально отменяет job. */

  test('отмена: mini-confirm остановки — «Продолжить анализ» возвращает к прогрессу, «Остановить» отменяет; закрытие без подтверждения', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('AiImp-Cancel'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, 'Qwen-Coder-Next');
    await page.reload();
    await expect(page.getByTestId('main-page')).toBeVisible();

    // 3 doc files × 2 s per extraction call → a comfortable running window.
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

      // Running view: stage + progress + stop button.
      const stop = page.getByTestId('ai-import-stop');
      await expect(stop).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-import-stage')).toBeVisible();
      await attachShot(page, testInfo, 'running');

      // «Остановить» is NOT instant: a mini-confirm opens first.
      await stop.click();
      const stopConfirm = page.getByTestId('ai-import-stop-confirm');
      await expect(stopConfirm).toBeVisible();
      await expect(stopConfirm).toContainText('Остановить анализ?');
      await attachShot(page, testInfo, 'stop-mini-confirm');

      // «Продолжить анализ» → back to the live progress, the job keeps running.
      await page.getByTestId('ai-import-stop-confirm-cancel').click();
      await expect(stopConfirm).toHaveCount(0);
      await expect(page.getByTestId('ai-import-stop')).toBeVisible();
      await expect(page.getByTestId('ai-import-stage')).toBeVisible();
      const st = await page.request.get(`/api/ai-import/${encodeURIComponent(jobId)}`);
      expect(((await st.json()) as { status?: string }).status).toBe('running');

      // Second stop → confirm: the job cancels on the next chunk boundary.
      await stop.click();
      await expect(stopConfirm).toBeVisible();
      await page.getByTestId('ai-import-stop-confirm-confirm').click();
      await expect(page.getByTestId('ai-import-cancelled')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-import-log')).toContainText(
        'Автоматизация остановлена пользователем',
      );

      // T5: honest cancelled panel — stage + what was already created.
      const cancelledSummary = page.getByTestId('ai-import-cancelled-summary');
      await expect(cancelledSummary).toBeVisible();
      await expect(cancelledSummary).toContainText('Анализ прерван на этапе');
      await expect(cancelledSummary).toContainText('Успели создать:');
      await expect(cancelledSummary).toContainText('они уже сохранены в проекте');

      // Footer: «Готово» + «Повторить анализ»; the old cancelled-close is gone.
      await expect(page.getByTestId('ai-import-done')).toBeVisible();
      await expect(page.getByTestId('ai-import-retry')).toBeVisible();
      await expect(page.getByTestId('ai-import-cancelled-close')).toHaveCount(0);
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
    await expectAiImportSummary(page, {
      functions: 0,
      nfrs: 1,
      treeLinks: 0,
      relatesLinks: 0,
      skipped: 0,
    });
    await attachShot(page, testInfo, 'targz-success');

    await page.getByTestId('ai-import-done').click();
    await expect(rowByName(page, REQ_LOGS)).toBeVisible();

    // Task 13 A1/A2: source empty, created as implemented (same as zip).
    const logsReq = (await listRequirements(page, id)).find((r) => r.name === REQ_LOGS);
    expect(logsReq?.source ?? '').toBe('');
    expect(logsReq?.implemented).toBe(true);
  });
});

/* ══ Task 13 · стадия structure (дерево через AI hub), поля, ретраи ═══════ */

test.describe('Task 13 · AI-импорт: структура, поля, ретраи JSON', () => {
  /* B4#1: structure-ответ строит дерево; родитель из structure ПЕРЕКРЫВАЕТ
     extraction (RESET: extraction говорит LOGIN, structure — OVERVIEW). */

  test('структуризация: дерево из structure-ответа AI hub — корни с детьми, родитель extraction перекрыт', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'AiImp-Struct');

    // FUNCTION: OVERVIEW — корень, LOGIN и RESET — его дети (structure);
    // NFR: REPORT — корень, LOGS — его ребёнок. Для RESET extraction-ответ
    // содержит parentName=LOGIN — итоговым родителем обязан стать OVERVIEW.
    stub.setStructureParents({
      [REQ_LOGIN]: REQ_TREE_OVERVIEW,
      [REQ_RESET]: REQ_TREE_OVERVIEW,
      [REQ_LOGS]: REQ_REPORT,
    });
    try {
      const zip = makeZip(testInfo, 'docs-struct.zip', {
        'auth.md': DOCS['auth.md']!,
        'overview.md': DOCS['overview.md']!,
        'reports.md': DOCS['reports.md']!,
        'ops.md': DOCS['ops.md']!,
      });
      const structureCallsBefore = stub.structureRequests.length;

      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      const success = page.getByTestId('ai-import-success');
      await expect(success).toBeVisible(JOB_TIMEOUT);
      await expectAiImportSummary(page, {
        functions: 3,
        nfrs: 2,
        treeLinks: 3,
        relatesLinks: 0,
        skipped: 0,
      });
      await attachShot(page, testInfo, 'structure-success');

      // Контракт structure-вызова (Task 14): system «архитектор дерева
      // требований…», max_tokens 4000; user несёт ТРИ секции — карту архива,
      // полный список допустимых родителей (TYPE\tимя) и батч с провенансом
      // (TYPE\tимя\tисточник).
      const structureCalls = stub.structureRequests.slice(structureCallsBefore);
      expect(structureCalls).toHaveLength(1);
      const call = structureCalls[0]!;
      expect(call.messages?.[0]?.role).toBe('system');
      expect(call.messages?.[0]?.content).toContain('архитектор дерева требований');
      expect(call['max_tokens']).toBe(4000);
      const user = call.messages?.find((m) => m.role === 'user')?.content ?? '';
      expect(user).toContain('Структура архива (файлы документации):');
      expect(user).toContain('Полный список требований (допустимые родители):');
      expect(user).toContain('Батч (5 шт., формат: тип, имя и источник через табуляцию):');

      // Полный список: все 5 требований, сначала FUNCTION, затем NFR
      // (порядок внутри типа не фиксируем — сверяем множества).
      const parents = structureParentsListOf(call);
      const parentFns = parents.filter((p) => p.type === 'FUNCTION').map((p) => p.name);
      const parentNfrs = parents.filter((p) => p.type === 'NFR').map((p) => p.name);
      expect(parentFns.sort()).toEqual([REQ_LOGIN, REQ_RESET, REQ_TREE_OVERVIEW].sort());
      expect(parentNfrs.sort()).toEqual([REQ_LOGS, REQ_REPORT].sort());
      // FUNCTION-строки идут раньше NFR-строк.
      expect(parents.findIndex((p) => p.type === 'NFR')).toBeGreaterThanOrEqual(parentFns.length);

      // Батч: по строке на требование, третье поле — источник «файл § раздел».
      const batch = structureBatchOf(call);
      const batchByName = new Map(batch.map((b) => [b.name, b]));
      expect(batch).toHaveLength(5);
      expect(batchByName.get(REQ_LOGIN)?.source).toBe('auth.md § Вход');
      expect(batchByName.get(REQ_RESET)?.source).toBe('auth.md § Восстановление');
      expect(batchByName.get(REQ_TREE_OVERVIEW)?.source).toBe('overview.md § Обзор');
      expect(batchByName.get(REQ_REPORT)?.source).toBe('reports.md § Производительность');
      expect(batchByName.get(REQ_LOGS)?.source).toBe('ops.md § Логи');

      await page.getByTestId('ai-import-done').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);

      // API: CHILD_OF ровно по structure-ответу; корни — без CHILD_OF.
      const reqs = await listRequirements(page, id);
      const byName = new Map(reqs.map((r) => [r.name, r]));
      const slugOfName = (name: string): string => {
        const slug = byName.get(name)?.slug;
        expect(slug, `slug of «${name}»`).toBeTruthy();
        return slug!;
      };
      expect(childOfTargets(byName.get(REQ_LOGIN))).toEqual([slugOfName(REQ_TREE_OVERVIEW)]);
      expect(childOfTargets(byName.get(REQ_RESET))).toEqual([slugOfName(REQ_TREE_OVERVIEW)]);
      expect(childOfTargets(byName.get(REQ_RESET))).not.toContain(slugOfName(REQ_LOGIN));
      expect(childOfTargets(byName.get(REQ_LOGS))).toEqual([slugOfName(REQ_REPORT)]);
      expect(childOfTargets(byName.get(REQ_TREE_OVERVIEW))).toEqual([]);
      expect(childOfTargets(byName.get(REQ_REPORT))).toEqual([]);

      // UI-дерево (НЕ два плоских списка): UX-2 — удаление доступно и у корней,
      // но корень с детьми ведёт к каскадному диалогу (усиленное подтверждение),
      // а лист LOGS — к обычному. Так подтверждаем древовидную структуру.
      const overviewRow = rowByName(page, REQ_TREE_OVERVIEW);
      await expect(overviewRow.locator('[data-testid^="delete-btn-"]')).toBeEnabled();
      await expect(
        rowByName(page, REQ_REPORT).locator('[data-testid^="delete-btn-"]'),
      ).toBeEnabled();
      await expect(rowByName(page, REQ_LOGS).locator('[data-testid^="delete-btn-"]')).toBeEnabled();

      // Корень с детьми → каскадный диалог (блок с числом потомков присутствует).
      await overviewRow.hover();
      await overviewRow.locator('[data-testid^="delete-btn-"]').click();
      await expect(page.getByTestId('delete-dialog')).toBeVisible();
      await expect(page.getByTestId('delete-dialog-cascade')).toBeVisible();
      await page.getByTestId('delete-dialog-cancel').click();
      await expect(page.getByTestId('delete-dialog')).toBeHidden();

      // Лист → обычный диалог (без каскадного блока и без поля ввода имени).
      const logsRow = rowByName(page, REQ_LOGS);
      await logsRow.hover();
      await logsRow.locator('[data-testid^="delete-btn-"]').click();
      await expect(page.getByTestId('delete-dialog')).toBeVisible();
      await expect(page.getByTestId('delete-dialog-cascade')).toHaveCount(0);
      await expect(page.getByTestId('delete-dialog-input')).toHaveCount(0);
      await page.getByTestId('delete-dialog-cancel').click();
      await expect(page.getByTestId('delete-dialog')).toBeHidden();

      // Режим «Скрыть зависимости»: дети сворачиваются под корни, chip
      // «N зависимостей» на корне раскрывает ветку обратно (паттерн S25).
      await setTreeMode(page, 'collapse');
      await expect(overviewRow).toBeVisible();
      await expect(rowByName(page, REQ_REPORT)).toBeVisible();
      await expect(rowByName(page, REQ_LOGIN)).toBeHidden();
      await expect(rowByName(page, REQ_RESET)).toBeHidden();
      await expect(rowByName(page, REQ_LOGS)).toBeHidden();
      await expect(overviewRow.getByTestId('expand-node')).toBeVisible();
      await attachShot(page, testInfo, 'structure-tree-collapsed');
      await expandNode(page, REQ_TREE_OVERVIEW);
      await expect(rowByName(page, REQ_LOGIN)).toBeVisible();
      await expect(rowByName(page, REQ_RESET)).toBeVisible();
    } finally {
      stub.setStructureParents(null);
    }
  });

  /* B4#2: у созданного требования «Источник» пуст, «Реализация» = «Реализовано»
     — проверка и через API, и в модалке редактирования. */

  test('поля импортированного требования: «Источник» пуст и «Реализация» = «Реализовано» (API + модалка)', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'AiImp-Fields');

    const zip = makeZip(testInfo, 'docs-fields.zip', { 'ops.md': DOCS['ops.md']! });
    await openAiImport(page);
    await chooseFile(page, zip);
    await startAnalysis(page);
    await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
    await page.getByTestId('ai-import-done').click();
    await expect(page.getByTestId('ai-import')).toHaveCount(0);

    // API: source пуст, implemented=true, квартал/год не назначены.
    const req = (await listRequirements(page, id)).find((r) => r.name === REQ_LOGS);
    expect(req, 'imported requirement must exist').toBeDefined();
    expect(req?.source ?? '').toBe('');
    expect(req?.implemented).toBe(true);
    expect(req?.targetQuarter).toBeUndefined();
    expect(req?.targetYear).toBeUndefined();

    // UI: модалка редактирования показывает пустой «Источник» и активную
    // кнопку «Реализовано» без блока квартала/года.
    await openEdit(page, REQ_LOGS);
    await expect(page.getByTestId('req-source')).toHaveValue('');
    await expect(page.getByTestId('req-implemented-yes')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('req-target')).toHaveCount(0);
    await attachShot(page, testInfo, 'imported-fields-modal');
    await page.getByTestId('req-cancel').click();
    await expect(page.getByTestId('requirement-modal')).toBeHidden();
  });

  /* B4#3: первый extraction-ответ не-JSON → повтор, warn «попытка 1 из 3»,
     импорт успешен со 2-й попытки. */

  test('ретрай extraction: не-JSON ответ → warn «попытка 1 из 3», со 2-й попытки импорт успешен', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'AiImp-Retry');

    stub.failNextExtractionJson(1);
    try {
      const zip = makeZip(testInfo, 'docs-retry.zip', { 'reports.md': DOCS['reports.md']! });
      const callsBefore = stub.extractionRequests.length;

      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      const success = page.getByTestId('ai-import-success');
      await expect(success).toBeVisible(JOB_TIMEOUT);
      await expectAiImportSummary(page, {
        functions: 0,
        nfrs: 1,
        treeLinks: 0,
        relatesLinks: 0,
        skipped: 0,
      });

      // Warn о неудачной попытке есть, «фрагмент пропущен» — нет.
      const log = page.getByTestId('ai-import-log');
      await expect(log).toContainText('ответ модели не распознан как JSON-массив (попытка 1 из 3)');
      await expect(log).not.toContainText('фрагмент пропущен');
      await attachShot(page, testInfo, 'retry-success');

      // Стаб получил ровно 2 extraction-вызова: неудачный + успешный повтор.
      expect(stub.extractionRequests.slice(callsBefore)).toHaveLength(2);

      await page.getByTestId('ai-import-done').click();
      await expect(rowByName(page, REQ_REPORT)).toBeVisible();
      expect((await listRequirements(page, id)).map((r) => r.name)).toContain(REQ_REPORT);
    } finally {
      stub.failNextExtractionJson(0);
    }
  });

  /* B4#4: стадия «Построение древовидной структуры ФТ/НФТ» видна в модалке
     (задержка structure-ответа даёт поллеру окно) и остаётся в логе. */

  test('стадия structure: «Этап: Построение древовидной структуры ФТ/НФТ» в модалке и строка в логе', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'AiImp-Stage');

    // 3 секунды на structure-ответ ≥ 3 опроса статуса (800 мс) — этап виден.
    stub.setStructureDelay(3000);
    try {
      const zip = makeZip(testInfo, 'docs-stage.zip', { 'auth.md': DOCS['auth.md']! });
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      await expect(page.getByTestId('ai-import-stage')).toHaveText(
        'Этап: Построение древовидной структуры ФТ/НФТ',
        JOB_TIMEOUT,
      );
      await attachShot(page, testInfo, 'structure-stage-visible');

      const success = page.getByTestId('ai-import-success');
      await expect(success).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-import-log')).toContainText(
        'Построение древовидной структуры ФТ/НФТ через AI hub…',
      );
    } finally {
      stub.setStructureDelay(0);
    }
  });

  /* B4-бонус (spec B2): 3 не-JSON structure-ответа → warn «останутся
     корневыми», job НЕ фейлится, требования созданы плоско. */

  test('structure не получен за 3 попытки: warn «записи останутся корневыми», импорт продолжается плоско', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'AiImp-FlatFallback');

    stub.failNextStructureJson(3);
    try {
      const zip = makeZip(testInfo, 'docs-flat.zip', {
        'auth.md': DOCS['auth.md']!,
        'reports.md': DOCS['reports.md']!,
      });
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      // Job succeeded несмотря на провал структуризации; связей нет.
      const success = page.getByTestId('ai-import-success');
      await expect(success).toBeVisible(JOB_TIMEOUT);
      await expectAiImportSummary(page, {
        functions: 2,
        nfrs: 1,
        treeLinks: 0,
        relatesLinks: 0,
        skipped: 0,
      });

      const log = page.getByTestId('ai-import-log');
      await expect(log).toContainText(
        'ответ модели не распознан как JSON-массив структуры (попытка 3 из 3)',
      );
      await expect(log).toContainText(
        'Структура для батча не получена — записи останутся корневыми.',
      );
      await attachShot(page, testInfo, 'structure-flat-fallback');

      await page.getByTestId('ai-import-done').click();
      // Все записи — корневые: ни одной CHILD_OF-связи.
      const reqs = await listRequirements(page, id);
      for (const name of [REQ_LOGIN, REQ_RESET, REQ_REPORT]) {
        expect(
          childOfTargets(reqs.find((r) => r.name === name)),
          `«${name}» must stay a root`,
        ).toEqual([]);
      }
    } finally {
      stub.failNextStructureJson(0);
    }
  });
});

/* ══ Task 14 · валидность дерева: сводка в логе, посторонние узлы (B5/B6/B9) ══ */

test.describe('Task 14 · AI-импорт: валидность дерева', () => {
  /* B6/B9: стартовый лог объёма и итоговая сводка дерева видны в ai-import-log
     после успешного импорта (default-стаб строит RESET под LOGIN → глубина 2). */

  test('лог импорта: «Модель… Файлов… фрагментов…» на старте и сводка «Дерево: ФТ — …» после структуризации', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'AiImp-TreeSummary');

    // auth.md → 2 ФТ (RESET — ребёнок LOGIN из structure-ответа стаба),
    // reports.md → 1 НФТ-корень. Итого: ФТ 1 корень + 1 с родителем,
    // НФТ 1 корень + 0 с родителем, максимальная глубина 2 (корень = 1).
    const zip = makeZip(testInfo, 'docs-summary.zip', {
      'auth.md': DOCS['auth.md']!,
      'reports.md': DOCS['reports.md']!,
    });
    await openAiImport(page);
    await chooseFile(page, zip);
    await startAnalysis(page);

    const success = page.getByTestId('ai-import-success');
    await expect(success).toBeVisible(JOB_TIMEOUT);
    await expectAiImportSummary(page, {
      functions: 2,
      nfrs: 1,
      treeLinks: 1,
      relatesLinks: 0,
      skipped: 0,
    });

    const log = page.getByTestId('ai-import-log');
    // B9: стартовый лог объёма — модель проекта, число файлов и фрагментов.
    await expect(log).toContainText('Модель: Qwen-Coder-Next. Файлов: 2, фрагментов: 2.');
    // B6: точная сводка дерева в конце стадии structure.
    await expect(log).toContainText(
      'Дерево: ФТ — 1 корней, 1 с родителем; НФТ — 1 корней, 0 с родителем; максимальная глубина 2.',
    );
    // Никаких warn покрытия при чистом эхо-ответе стаба.
    await expect(log).not.toContainText('посторонних узлов');
    await expect(log).not.toContainText('без узла в ответе');
    await attachShot(page, testInfo, 'tree-summary-log');
  });

  /* B5: structure-ответ с посторонним узлом (не из извлечённых требований) →
     warn «посторонних узлов проигнорировано: 1», узел не применён — лишних
     требований и связей нет, легитимное дерево не пострадало. */

  test('посторонний узел в structure-ответе: warn в логе, узел проигнорирован, дерево не искажено', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'AiImp-Foreign');

    const FOREIGN = 'Посторонний раздел, которого нет среди требований';
    stub.setStructureExtraNodes([{ type: 'FUNCTION', name: FOREIGN, parentName: null }]);
    try {
      const zip = makeZip(testInfo, 'docs-foreign.zip', { 'auth.md': DOCS['auth.md']! });
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      // Импорт успешен, счётчики без постороннего узла (2 ФТ, 1 связь).
      const success = page.getByTestId('ai-import-success');
      await expect(success).toBeVisible(JOB_TIMEOUT);
      await expectAiImportSummary(page, {
        functions: 2,
        nfrs: 0,
        treeLinks: 1,
        relatesLinks: 0,
        skipped: 0,
      });

      // Warn покрытия B5 — точная строка батча 1/1.
      const log = page.getByTestId('ai-import-log');
      await expect(log).toContainText(
        'Структуризация (батч 1/1): посторонних узлов проигнорировано: 1.',
      );
      // Все требования батча получили узлы — второго warn нет.
      await expect(log).not.toContainText('без узла в ответе');
      await attachShot(page, testInfo, 'foreign-node-warn');

      await page.getByTestId('ai-import-done').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);

      // Постороннее требование НЕ создано; легитимная иерархия сохранена:
      // RESET — ребёнок LOGIN (default-стаб), LOGIN — корень.
      const reqs = await listRequirements(page, id);
      expect(reqs.map((r) => r.name).sort()).toEqual([REQ_LOGIN, REQ_RESET].sort());
      const byName = new Map(reqs.map((r) => [r.name, r]));
      expect(childOfTargets(byName.get(REQ_RESET))).toEqual([byName.get(REQ_LOGIN)!.slug]);
      expect(childOfTargets(byName.get(REQ_LOGIN))).toEqual([]);
      await expect(rowByName(page, REQ_LOGIN)).toBeVisible();
      await expect(rowByName(page, FOREIGN)).toHaveCount(0);
    } finally {
      stub.setStructureExtraNodes(null);
    }
  });
});

/* ══ Task 15 · связи RELATES_TO НФТ→ФТ из relatedFunctions (extraction) ═════ */

test.describe('Task 15 · AI-импорт: связи НФТ→ФТ', () => {
  /* Локальные фикстуры блока: ФТ «экспорт в PDF» + НФТ, ограничивающая его
     скорость. Каждый тест подменяет extraction-ответ стаба целиком
     (setExtractionItems) и обязан вернуть дефолт в finally. */

  const REL_FT = 'Экспорт отчёта в PDF';
  const REL_NFR = 'Экспорт PDF не дольше 10 секунд';

  const REL_DOCS: Record<string, string> = {
    'export.md': ['# Экспорт', '', '## PDF', 'Система должна экспортировать отчёт в PDF.', ''].join(
      '\n',
    ),
    'perf-export.md': [
      '# Ограничения',
      '',
      '## Скорость',
      'Экспорт PDF должен занимать не более 10 секунд.',
      '',
    ].join('\n'),
  };

  /** FUNCTION-запись extraction-ответа для export.md. */
  function ftRecord(extra?: Record<string, unknown>): Record<string, unknown> {
    return {
      type: 'FUNCTION',
      name: REL_FT,
      description: 'Система экспортирует отчёт в PDF.',
      source: 'export.md § PDF',
      ...extra,
    };
  }

  /** NFR-запись extraction-ответа для perf-export.md c relatedFunctions. */
  function nfrRecord(relatedFunctions: string[]): Record<string, unknown> {
    return {
      type: 'NFR',
      name: REL_NFR,
      description: 'Экспорт PDF занимает не более 10 секунд.',
      source: 'perf-export.md § Скорость',
      relatedFunctions,
    };
  }

  /* C5#1: успешный импорт — RELATES_TO на обоих концах, лог, счётчик. */

  test('связь НФТ→ФТ создана: RELATES_TO симметрична, инфо-строка в логе, счётчик в модалке', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'AiImp-Rel');

    stub.setExtractionItems({
      'export.md': [ftRecord()],
      'perf-export.md': [nfrRecord([REL_FT])],
    });
    try {
      const zip = makeZip(testInfo, 'docs-relates.zip', REL_DOCS);
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      const success = page.getByTestId('ai-import-success');
      await expect(success).toBeVisible(JOB_TIMEOUT);

      // Счётчик в сводке-таблице — числовая ячейка «Смысловые связи НФТ↔ФТ».
      await expectAiImportSummary(page, {
        functions: 1,
        nfrs: 1,
        treeLinks: 0,
        relatesLinks: 1,
        skipped: 0,
      });

      // Инфо-строка лога — дословно по контракту Task 15.
      await expect(page.getByTestId('ai-import-log')).toContainText(
        `Связано: НФТ «${REL_NFR}» → ФТ «${REL_FT}» (RELATES_TO).`,
      );
      await attachShot(page, testInfo, 'relates-success');

      await page.getByTestId('ai-import-done').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);
      await expect(rowByName(page, REL_FT)).toBeVisible();
      await expect(rowByName(page, REL_NFR)).toBeVisible();

      // API: связь симметрична — запись у НФТ И парная запись у ФТ.
      const reqs = await listRequirements(page, id);
      const byName = new Map(reqs.map((r) => [r.name, r]));
      const ft = byName.get(REL_FT);
      const nfr = byName.get(REL_NFR);
      expect(nfr, 'НФТ создана').toBeDefined();
      expect(ft, 'ФТ создана').toBeDefined();
      expect(relatesTargets(nfr)).toEqual([ft!.slug]);
      expect(relatesTargets(ft)).toEqual([nfr!.slug]);
    } finally {
      stub.setExtractionItems(null);
    }
  });

  /* C5#2: несуществующая ФТ → warn, job успешен; relatedFunctions у FUNCTION
     игнорируется со своим warn. relatesLinks = 0. */

  test('несуществующая ФТ и relatedFunctions у FUNCTION: оба warn, job успешен, связей НФТ→ФТ 0', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'AiImp-RelMiss');

    const missingFt = 'Функция, которой нет в проекте';
    stub.setExtractionItems({
      // Галлюцинация модели: relatedFunctions на FUNCTION-записи.
      'export.md': [ftRecord({ relatedFunctions: [REL_NFR] })],
      'perf-export.md': [nfrRecord([missingFt])],
    });
    try {
      const zip = makeZip(testInfo, 'docs-relates-miss.zip', REL_DOCS);
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      // Job УСПЕШЕН, несмотря на оба отклонения; связей НФТ→ФТ нет.
      const success = page.getByTestId('ai-import-success');
      await expect(success).toBeVisible(JOB_TIMEOUT);
      await expectAiImportSummary(page, {
        functions: 1,
        nfrs: 1,
        treeLinks: 0,
        relatesLinks: 0,
        skipped: 0,
      });

      const log = page.getByTestId('ai-import-log');
      await expect(log).toContainText(
        `НФТ «${REL_NFR}»: связанная ФТ «${missingFt}» не найдена — связь пропущена.`,
      );
      await expect(log).toContainText(
        `«${REL_FT}» (FUNCTION): relatedFunctions игнорируется — привязка допустима только от НФТ.`,
      );
      await attachShot(page, testInfo, 'relates-missing-warn');

      await page.getByTestId('ai-import-done').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);

      // API: ни одной RELATES_TO ни у кого; посторонняя ФТ не создана.
      const reqs = await listRequirements(page, id);
      expect(reqs.map((r) => r.name).sort()).toEqual([REL_FT, REL_NFR].sort());
      for (const req of reqs) expect(relatesTargets(req)).toEqual([]);
    } finally {
      stub.setExtractionItems(null);
    }
  });

  /* C5#3: идемпотентность — re-run того же архива не дублирует связь,
     счётчик relatesLinks = 0 на повторе; done-сводка проверяется дословно. */

  test('идемпотентность: повторный импорт не дублирует RELATES_TO, счётчик 0 на re-run', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'AiImp-RelRerun');

    stub.setExtractionItems({
      'export.md': [ftRecord()],
      'perf-export.md': [nfrRecord([REL_FT])],
    });
    try {
      const zip = makeZip(testInfo, 'docs-relates-rerun.zip', REL_DOCS);

      // Первый прогон: связь создана.
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);
      await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
      await expect(page.getByTestId('ai-import-relates-links')).toHaveText('1');
      await page.getByTestId('ai-import-done').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);

      // Второй прогон ТОГО ЖЕ архива: всё пропущено, связь не дублируется.
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);
      const success = page.getByTestId('ai-import-success');
      await expect(success).toBeVisible(JOB_TIMEOUT);
      await expectAiImportSummary(page, {
        functions: 0,
        nfrs: 0,
        treeLinks: 0,
        relatesLinks: 0,
        skipped: 2,
      });

      // Done-сводка re-run — дословно (полнотекстовый контракт Task 15).
      await expect(page.getByTestId('ai-import-log')).toContainText(
        'Готово: создано ФТ 0, НФТ 0; пропущено существующих 2; связей 0, связей НФТ→ФТ: 0.',
      );
      await attachShot(page, testInfo, 'relates-idempotent-rerun');
      await page.getByTestId('ai-import-done').click();

      // API: у НФТ РОВНО одна RELATES_TO (и одна парная у ФТ), без дублей.
      const reqs = await listRequirements(page, id);
      const byName = new Map(reqs.map((r) => [r.name, r]));
      const ft = byName.get(REL_FT);
      const nfr = byName.get(REL_NFR);
      expect(relatesTargets(nfr)).toEqual([ft!.slug]);
      expect(relatesTargets(ft)).toEqual([nfr!.slug]);
    } finally {
      stub.setExtractionItems(null);
    }
  });

  /* C5#4 (бонус спеки): привязка к ФТ, созданной вручную ДО импорта; резолв
     имени регистронезависимый (relatedFunctions в ВЕРХНЕМ регистре). */

  test('связь с ФТ, существовавшей до импорта: резолв имени регистронезависимый', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'AiImp-RelPre');

    // ФТ заведена вручную через API до какого-либо импорта.
    const manualFt = 'Ручная функция экспорта';
    const manualFtSlug = await apiCreateRequirement(page, id, {
      kind: 'function',
      name: manualFt,
    });

    const upperFt = manualFt.toUpperCase();
    stub.setExtractionItems({
      'perf-export.md': [nfrRecord([upperFt])], // регистр НЕ совпадает
    });
    try {
      const zip = makeZip(testInfo, 'docs-relates-pre.zip', {
        'perf-export.md': REL_DOCS['perf-export.md']!,
      });
      await openAiImport(page);
      await chooseFile(page, zip);
      await startAnalysis(page);

      const success = page.getByTestId('ai-import-success');
      await expect(success).toBeVisible(JOB_TIMEOUT);
      await expectAiImportSummary(page, {
        functions: 0,
        nfrs: 1,
        treeLinks: 0,
        relatesLinks: 1,
        skipped: 0,
      });
      await expect(page.getByTestId('ai-import-log')).toContainText(
        `Связано: НФТ «${REL_NFR}» → ФТ «${upperFt}» (RELATES_TO).`,
      );
      await attachShot(page, testInfo, 'relates-preexisting-ft');
      await page.getByTestId('ai-import-done').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);

      // API: связь ведёт именно на РАНЕЕ созданную ФТ, парная запись у неё.
      const reqs = await listRequirements(page, id);
      const byName = new Map(reqs.map((r) => [r.name, r]));
      const nfr = byName.get(REL_NFR);
      expect(relatesTargets(nfr)).toEqual([manualFtSlug]);
      expect(relatesTargets(byName.get(manualFt))).toEqual([nfr!.slug]);
    } finally {
      stub.setExtractionItems(null);
    }
  });
});

/* ══ todo_16 · A3 (модалка) + B2: обновление моделей и AI-шаг связей ФТ↔НФТ ══ */

test.describe('todo_16 · AI-импорт: обновление списка моделей и шаг связей', () => {
  /** Текстовые поля multipart-запуска, `file:<имя>` для файловой части. */
  type AiImportFields = Record<string, string>;

  /**
   * B2 проверяет СОСТАВ полей multipart-запуска (`inferLinks`), но CDP не
   * отдаёт postData для FormData с файлом (`postDataBuffer()` → null). Поэтому
   * оборачиваем window.fetch и фиксируем поля FormData ровно того запроса,
   * который уходит на POST …/ai-import (клиент шлёт его через fetch,
   * api/client.ts). Вызвать ПОСЛЕ загрузки страницы, ДО клика «Запустить».
   */
  async function captureAiImportFormData(page: Page): Promise<void> {
    await page.evaluate(() => {
      const w = window as unknown as {
        __aiImportFields: Record<string, string> | null;
        fetch: typeof fetch;
      };
      w.__aiImportFields = null;
      const orig = w.fetch.bind(window);
      w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/ai-import') && init?.body instanceof FormData) {
          const fields: Record<string, string> = {};
          // forEach вместо entries(): lib e2e-tsconfig без DOM.Iterable.
          init.body.forEach((value, key) => {
            fields[key] = typeof value === 'string' ? value : `file:${value.name}`;
          });
          w.__aiImportFields = fields;
        }
        return orig(input, init);
      };
    });
  }

  /** Запуск анализа + захваченные поля multipart (см. captureAiImportFormData). */
  async function startAnalysisCaptured(page: Page): Promise<{ fields: AiImportFields }> {
    await startAnalysis(page);
    const fields = await page.evaluate(
      () => (window as unknown as { __aiImportFields: AiImportFields | null }).__aiImportFields,
    );
    expect(fields, 'поля multipart-запуска должны быть захвачены').not.toBeNull();
    return { fields: fields! };
  }

  /* ── A3: кнопка обновления списка моделей в модалке AI-импорта ─────────── */

  test('A3: обновление списка моделей в модалке; сброс исчезнувшей модели; выбранная модель уходит в extraction-запрос', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'AiImp-Refresh');

    await openAiImport(page);
    const select = page.getByTestId('ai-import-model-select');
    await expect(select).toHaveValue('Qwen-Coder-Next');
    // Автозагрузка списка при открытой модалке (ключ есть) — обе модели стаба.
    await expect(select.locator('option[value="GigaChat-2-Pro"]')).toHaveCount(1);

    try {
      // Список изменился: выбранная модель проекта исчезла, появилась новая.
      stub.setModels(['GigaChat-2-Pro', 'Qwen-3-Coder']);
      const [res] = await Promise.all([
        page.waitForResponse(
          (r) => r.request().method() === 'GET' && r.url().includes('/api/ai/models'),
        ),
        page.getByTestId('ai-models-refresh-import').click(),
      ]);
      expect(res.status()).toBe(200);

      // Options обновлены, выбор сброшен на первую модель нового списка.
      await expect(select.locator('option[value="Qwen-3-Coder"]')).toHaveCount(1);
      await expect(select.locator('option[value="Qwen-Coder-Next"]')).toHaveCount(0);
      await expect(select).toHaveValue('GigaChat-2-Pro');
      const notice = page.getByTestId('ai-models-notice-import');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('Qwen-Coder-Next');
      await expect(notice).toContainText('больше недоступна');

      // Смена модели применяется к последующему запросу: extraction-вызовы
      // стаба идут с выбранной вручную моделью.
      await select.selectOption('Qwen-3-Coder');
      const zip = makeZip(testInfo, 'docs-refresh.zip', { 'auth.md': DOCS['auth.md']! });
      await chooseFile(page, zip);
      const callsBefore = stub.extractionRequests.length;
      await startAnalysis(page);
      await expect(page.getByTestId('ai-import-success')).toBeVisible(JOB_TIMEOUT);
      const calls = stub.extractionRequests.slice(callsBefore);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.model).toBe('Qwen-3-Coder');
    } finally {
      stub.setModels(null); // общий стаб файла — вернуть исходный список
    }
  });

  /* ── B2: чекбокс выключен (default) — поведение прежнее ────────────────── */

  test('B2: чекбокс связей по умолчанию выключен — inferLinks не уходит в multipart, блока статуса нет, relate-запросов нет', async ({
    page,
  }, testInfo) => {
    await projectWithAi(page, 'AiImp-RelOff');

    await openAiImport(page);
    // Default off (spec B2).
    const checkbox = page.getByTestId('ai-import-infer-links');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();

    const zip = makeZip(testInfo, 'docs-rel-off.zip', { 'auth.md': DOCS['auth.md']! });
    await chooseFile(page, zip);
    await captureAiImportFormData(page);

    const relateBefore = stub.relateRequests.length;
    const { fields } = await startAnalysisCaptured(page);
    // Off-путь прежний: поля inferLinks в multipart нет ВОВСЕ (не 'false').
    expect(Object.keys(fields)).not.toContain('inferLinks');
    expect(fields['file']).toBe('file:docs-rel-off.zip');

    const success = page.getByTestId('ai-import-success');
    await expect(success).toBeVisible(JOB_TIMEOUT);
    await expectAiImportSummary(page, {
      functions: 2,
      nfrs: 0,
      treeLinks: 1,
      relatesLinks: 0,
      skipped: 0,
    });

    // Блок статуса relate-шага не рендерится, AI-hub relate-вызовов не было.
    await expect(page.getByTestId('ai-import-relate-status')).toHaveCount(0);
    expect(stub.relateRequests.length).toBe(relateBefore);
  });

  /* ── B2: чекбокс включён — happy-path с «выполняется…» → «создано связей: N» ── */

  test('B2: включённый чекбокс — inferLinks=true в multipart, статусы шага, только RELATES_TO между существующими, выдуманные id отброшены', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'AiImp-RelOn');

    // Ответ relate-вызова: НФТ «отчёт ≤ 5 c» ↔ ФТ «вход по логину» + одна
    // выдуманная пара, которую пайплайн обязан отбросить (не найдя id).
    stub.setRelatePairsByName({ [REQ_REPORT]: [REQ_LOGIN] });
    stub.setRelateRawPairs([{ nfr: 'fake-nfr-id', function: 'fake-fn-id' }]);
    // Задержка relate-ответа — окно для статуса «выполняется…» (поллер 800 мс).
    stub.setRelateDelay(3000);

    try {
      const zip = makeZip(testInfo, 'docs-rel-on.zip', {
        'auth.md': DOCS['auth.md']!,
        'reports.md': DOCS['reports.md']!,
      });
      await openAiImport(page);
      await chooseFile(page, zip);
      await page.getByTestId('ai-import-infer-links').check();
      await captureAiImportFormData(page);

      const relateBefore = stub.relateRequests.length;
      const { fields } = await startAnalysisCaptured(page);
      // Флаг уходит текстовым multipart-полем со значением 'true'.
      expect(fields['inferLinks']).toBe('true');

      // Пока стаб держит relate-ответ, шаг виден как «выполняется…».
      const relateStatus = page.getByTestId('ai-import-relate-status');
      await expect(relateStatus).toContainText(
        'Проставление связей ФТ↔НФТ: выполняется…',
        JOB_TIMEOUT,
      );

      // Импорт завершён; итог шага — «создано связей: 1». Сводка-таблица
      // (todo_18): «Смысловые связи НФТ↔ФТ» суммирует extraction (0) + relate-шаг
      // (1) = 1 — счётчик стал совокупным.
      const success = page.getByTestId('ai-import-success');
      await expect(success).toBeVisible(JOB_TIMEOUT);
      await expectAiImportSummary(page, {
        functions: 2,
        nfrs: 1,
        treeLinks: 1,
        relatesLinks: 1,
        skipped: 0,
      });
      await expect(relateStatus).toHaveText('Проставление связей ФТ↔НФТ: создано связей: 1');

      // Лог: созданная связь + отброшенная выдуманная пара.
      const log = page.getByTestId('ai-import-log');
      await expect(log).toContainText(
        `Связано (AI): НФТ «${REQ_REPORT}» → ФТ «${REQ_LOGIN}» (RELATES_TO).`,
      );
      await expect(log).toContainText('выдуманные id: 1');
      await attachShot(page, testInfo, 'relate-done');

      // Ровно один relate-вызов, той же моделью, оба списка переданы.
      const relateCalls = stub.relateRequests.slice(relateBefore);
      expect(relateCalls.length).toBe(1);
      expect(relateCalls[0]?.model).toBe('Qwen-Coder-Next');

      // API-истина: требований по-прежнему 3 (шаг ничего не создал/не изменил),
      // появилась ровно одна связь RELATES_TO — симметричные записи у обоих концов.
      const reqs = await listRequirements(page, id);
      expect(reqs.length).toBe(3);
      const byName = new Map(reqs.map((r) => [r.name, r]));
      const nfr = byName.get(REQ_REPORT);
      const fn = byName.get(REQ_LOGIN);
      expect(relatesTargets(nfr)).toEqual([fn!.slug]);
      expect(relatesTargets(fn)).toEqual([nfr!.slug]);
      // Иерархия extraction/structure не пострадала (RESET остался под LOGIN).
      expect(childOfTargets(byName.get(REQ_RESET))).toEqual([fn!.slug]);
    } finally {
      stub.setRelatePairsByName(null);
      stub.setRelateRawPairs(null);
      stub.setRelateDelay(0);
    }
  });

  /* ── B2: ошибка AI на relate-шаге — «шаг пропущен», импорт успешен ──────── */

  test('B2: relate-ответ не парсится (все ретраи) — «шаг пропущен из-за ошибки AI», импорт успешен, связей нет', async ({
    page,
  }, testInfo) => {
    const id = await projectWithAi(page, 'AiImp-RelSkip');

    // Все 3 попытки relate-вызова отвечают прозой без JSON → шаг деградирует.
    stub.failNextRelateJson(3);

    try {
      const zip = makeZip(testInfo, 'docs-rel-skip.zip', {
        'auth.md': DOCS['auth.md']!,
        'reports.md': DOCS['reports.md']!,
      });
      await openAiImport(page);
      await chooseFile(page, zip);
      await page.getByTestId('ai-import-infer-links').check();
      await startAnalysis(page);

      // Импорт НЕ падает: success-блок + статус пропуска relate-шага.
      const success = page.getByTestId('ai-import-success');
      await expect(success).toBeVisible(JOB_TIMEOUT);
      await expectAiImportSummary(page, {
        functions: 2,
        nfrs: 1,
        treeLinks: 1,
        relatesLinks: 0,
        skipped: 0,
      });
      await expect(page.getByTestId('ai-import-relate-status')).toHaveText(
        'Проставление связей ФТ↔НФТ: шаг пропущен из-за ошибки AI',
      );
      await expect(page.getByTestId('ai-import-log')).toContainText(
        'Проставление связей ФТ↔НФТ: ответ модели не распознан',
      );
      await attachShot(page, testInfo, 'relate-skipped');

      // API-истина: требования созданы, RELATES_TO связей нет.
      const reqs = await listRequirements(page, id);
      expect(reqs.length).toBe(3);
      for (const r of reqs) expect(relatesTargets(r)).toEqual([]);
    } finally {
      stub.failNextRelateJson(0);
      stub.setRelateDelay(0);
    }
  });
});
