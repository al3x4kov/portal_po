import AdmZip from 'adm-zip';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startAiStub, type AiStub } from './helpers/ai-stub.js';
import { createProject, projectIdFromUrl, rowByName, uniqueName } from './helpers/app.js';
import { approveDocsReviewGates, expectAiImportSummary } from './helpers/ai-import.js';

/**
 * todo_18 · E2E for the two user-facing outcomes of the «thinking models»
 * work: (1) editing per-model best-practice presets in AI settings, and
 * (2) an AI documentation import driven by a «thinking» model whose answers
 * are wrapped in `<think>…</think>` — proving the reasoning-strip fix and that
 * both the CHILD_OF tree AND the RELATES_TO meaning links are created (the
 * «0 связей на думающих моделях» defect is gone).
 *
 * The upstream AI Hub is the shared in-process stub (helpers/ai-stub.ts),
 * pointed at via the SAVED config (`PUT /api/ai/config`, base URL + key). The
 * stub's `setThinkWrap(true)` toggle wraps every model answer in a leading
 * reasoning block; the server strips it only when the effective model preset
 * has `reasoning: 'strip'` (the thinking model's default). The global config is
 * shared across spec files, so each test configures it explicitly and the file
 * resets the key in `afterAll` — the same discipline as ai-import.spec.ts.
 */

/*
 * «Думающая» модель: дефолтный пресет reasoning='strip', chunk 16000,
 * maxOut 12000. todo_18/58b7342: бюджет думающей модели поднят 6000→12000,
 * потому что в пайплайне ИМПОРТА max_tokens = preset.maxOutputTokens (полный
 * бюджет), и reasoning-блок `<think>…</think>` не должен съедать место до JSON.
 */
const THINKING_MODEL = 'Qwen/Qwen3.6-27B';
const STUB_MODELS = [THINKING_MODEL, 'Qwen/Qwen3-Coder-Next', 'GigaChat-2-Pro'];
const JOB_TIMEOUT = { timeout: 30_000 } as const;

/** Дефолты пресета для THINKING_MODEL (packages/core/src/validation/ai.ts). */
const DEFAULTS = {
  temperature: '0.2',
  maxOutputTokens: '12000',
  chunkChars: '16000',
  reasoning: 'strip',
  topP: '',
} as const;

/** Точная строка лога усечения ответа (AiImportService.chatWithJsonRetries). */
const TRUNCATED_LOG_MARKER = 'обрезан по лимиту токенов';

let stub: AiStub;

test.beforeAll(async () => {
  stub = await startAiStub({ models: STUB_MODELS, reply: 'ответ ассистента' });
});

test.afterAll(async () => {
  await stub.close();
});

/** Сбросить глобальный ключ, чтобы не влиять на другие spec-файлы. */
async function resetAiConfig(page: Page): Promise<void> {
  const res = await page.request.put('/api/ai/config', { data: { apiKey: null } });
  if (!res.ok()) throw new Error(`PUT /api/ai/config {apiKey:null} failed (${res.status()})`);
}

test.afterEach(async ({ page }) => {
  stub.setThinkWrap(false);
  await resetAiConfig(page);
});

/** Сохранить ключ+baseURL+модель проекта через официальный API. */
async function configureAi(page: Page, projectId: string, model: string): Promise<void> {
  const res = await page.request.put('/api/ai/config', {
    data: { baseURL: stub.baseUrl, apiKey: 'sk-e2e-preset-key', projectId, model },
  });
  if (!res.ok()) throw new Error(`PUT /api/ai/config failed (${res.status()})`);
}

/** Бейдж «переопределено / по умолчанию» рядом с конкретным полем пресета. */
function presetBadge(page: Page, fieldTestId: string) {
  return page.getByTestId(fieldTestId).locator('xpath=..').getByTestId('badge');
}

/** Собрать zip-архив из файлов в памяти; вернуть путь на диске. */
function makeZip(testInfo: TestInfo, name: string, files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [entry, content] of Object.entries(files)) {
    zip.addFile(entry, Buffer.from(content, 'utf8'));
  }
  const target = testInfo.outputPath(name);
  zip.writeZip(target);
  return target;
}

interface ReqDto {
  slug: string;
  name: string;
  type: string;
  links: Array<{ type: string; targetSlug: string }>;
}

async function listRequirements(page: Page, projectId: string): Promise<ReqDto[]> {
  const res = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}/requirements`);
  if (!res.ok()) throw new Error(`GET requirements failed (${res.status()})`);
  return ((await res.json()) as { requirements: ReqDto[] }).requirements;
}

const linkTargets = (req: ReqDto | undefined, type: string): string[] =>
  (req?.links ?? []).filter((l) => l.type === type).map((l) => l.targetSlug);

/* ══ 1 · Пресеты модели в настройках AI ═════════════════════════════════════ */

test.describe('todo_18 · пресеты модели в настройках AI', () => {
  test('сохранение оверрайдов пресета, перечитывание конфига, сброс к дефолту', async ({
    page,
  }) => {
    await createProject(page, uniqueName('AiPreset'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, THINKING_MODEL);

    await page.goto(`/p/${id}/ai`);
    await expect(page.getByTestId('ai-page')).toBeVisible();

    // Секция пресетов присутствует, выбрана думающая модель.
    const section = page.getByTestId('ai-preset-section');
    await expect(section).toBeVisible();
    const modelSelect = page.getByTestId('ai-preset-model-select');
    await modelSelect.selectOption(THINKING_MODEL);

    // Дефолтные значения модели; все бейджи — «по умолчанию».
    await expect(page.getByTestId('ai-preset-temperature')).toHaveValue(DEFAULTS.temperature);
    await expect(page.getByTestId('ai-preset-maxOutputTokens')).toHaveValue(
      DEFAULTS.maxOutputTokens,
    );
    await expect(page.getByTestId('ai-preset-chunkChars')).toHaveValue(DEFAULTS.chunkChars);
    await expect(page.getByTestId('ai-preset-reasoning')).toHaveValue(DEFAULTS.reasoning);
    await expect(page.getByTestId('ai-preset-topP')).toHaveValue(DEFAULTS.topP);
    for (const f of ['temperature', 'maxOutputTokens', 'chunkChars', 'reasoning', 'topP']) {
      await expect(presetBadge(page, `ai-preset-${f}`)).toHaveAttribute('data-overridden', 'false');
    }

    // Меняем поля и сохраняем.
    await page.getByTestId('ai-preset-temperature').fill('0.9');
    await page.getByTestId('ai-preset-maxOutputTokens').fill('5000');
    await page.getByTestId('ai-preset-chunkChars').fill('20000');
    await page.getByTestId('ai-preset-reasoning').selectOption('none');
    await page.getByTestId('ai-preset-topP').fill('0.8');
    await page.getByTestId('ai-preset-save').click();
    await expect(page.getByTestId('ai-preset-status')).toContainText('Параметры модели сохранены');

    // Перечитываем конфиг (перезагрузка страницы) — значения сохранились,
    // бейджи изменённых полей помечены «переопределено».
    await page.reload();
    await expect(page.getByTestId('ai-preset-section')).toBeVisible();
    await expect(page.getByTestId('ai-preset-model-select')).toHaveValue(THINKING_MODEL);
    await expect(page.getByTestId('ai-preset-temperature')).toHaveValue('0.9');
    await expect(page.getByTestId('ai-preset-maxOutputTokens')).toHaveValue('5000');
    await expect(page.getByTestId('ai-preset-chunkChars')).toHaveValue('20000');
    await expect(page.getByTestId('ai-preset-reasoning')).toHaveValue('none');
    await expect(page.getByTestId('ai-preset-topP')).toHaveValue('0.8');
    for (const f of ['temperature', 'maxOutputTokens', 'chunkChars', 'reasoning', 'topP']) {
      await expect(presetBadge(page, `ai-preset-${f}`)).toHaveAttribute('data-overridden', 'true');
    }

    // «Сбросить к дефолту» — поля возвращаются к дефолтным, бейджи «по умолчанию».
    await page.getByTestId('ai-preset-reset').click();
    await expect(page.getByTestId('ai-preset-status')).toContainText(
      'Параметры сброшены к дефолту',
    );
    await expect(page.getByTestId('ai-preset-temperature')).toHaveValue(DEFAULTS.temperature);
    await expect(page.getByTestId('ai-preset-maxOutputTokens')).toHaveValue(
      DEFAULTS.maxOutputTokens,
    );
    await expect(page.getByTestId('ai-preset-chunkChars')).toHaveValue(DEFAULTS.chunkChars);
    await expect(page.getByTestId('ai-preset-reasoning')).toHaveValue(DEFAULTS.reasoning);
    await expect(page.getByTestId('ai-preset-topP')).toHaveValue(DEFAULTS.topP);
    for (const f of ['temperature', 'maxOutputTokens', 'chunkChars', 'reasoning', 'topP']) {
      await expect(presetBadge(page, `ai-preset-${f}`)).toHaveAttribute('data-overridden', 'false');
    }

    // Сброс переживает перечитывание конфига — оверрайд удалён с диска.
    await page.reload();
    await expect(page.getByTestId('ai-preset-section')).toBeVisible();
    await expect(page.getByTestId('ai-preset-temperature')).toHaveValue(DEFAULTS.temperature);
    await expect(page.getByTestId('ai-preset-reasoning')).toHaveValue(DEFAULTS.reasoning);
    await expect(presetBadge(page, 'ai-preset-temperature')).toHaveAttribute(
      'data-overridden',
      'false',
    );
  });

  test('справка по параметрам: вводный абзац секции и блоки «Влияет на:» у каждого поля', async ({
    page,
  }) => {
    await createProject(page, uniqueName('AiPresetHelp'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, THINKING_MODEL);

    await page.goto(`/p/${id}/ai`);
    const section = page.getByTestId('ai-preset-section');
    await expect(section).toBeVisible();
    await page.getByTestId('ai-preset-model-select').selectOption(THINKING_MODEL);

    // Вводный абзац объясняет назначение параметров и привязку к AI-функциям.
    await expect(section).toContainText('что он делает простыми словами и на какие функции влияет');

    // У каждого параметра есть блок пояснения с привязкой «Влияет на:».
    for (const param of ['temperature', 'maxOutputTokens', 'chunkChars', 'reasoning', 'topP']) {
      const help = page.getByTestId(`ai-preset-help-${param}`);
      await expect(help).toBeVisible();
      await expect(help).toContainText('Влияет на:');
    }
  });
});

/* ══ 2 · Импорт «думающей» моделью: дерево + смысловые связи (reasoning-strip) ═ */

test.describe('todo_18 · AI-импорт думающей моделью со связями ФТ↔НФТ', () => {
  const FT_ROOT = 'Реестр требований учитывает все ФТ';
  const FT_LOGIN = 'Вход по логину и паролю';
  const NFR_PERF = 'Отклик входа не более 2 секунд';

  const DOCS: Record<string, string> = {
    'overview.md': ['# Обзор', '', '## Реестр', 'Система ведёт реестр требований.', ''].join('\n'),
    'login.md': [
      '# Доступ',
      '',
      '## Вход',
      'Система обеспечивает вход по логину и паролю.',
      '',
    ].join('\n'),
    'perf.md': [
      '# Производительность',
      '',
      '## Отклик',
      'Вход должен выполняться не дольше 2 секунд.',
      '',
    ].join('\n'),
  };

  test('импорт с inferLinks: <think>-обёртка вырезана, построены дерево (CHILD_OF) и связи НФТ↔ФТ (RELATES_TO)', async ({
    page,
  }, testInfo) => {
    await createProject(page, uniqueName('AiThink'));
    const id = projectIdFromUrl(page);
    await configureAi(page, id, THINKING_MODEL);

    // extraction: FT-корень + FT-ребёнок + НФТ с relatedFunctions на FT-ребёнка.
    stub.setExtractionItems({
      'overview.md': [
        {
          type: 'FUNCTION',
          name: FT_ROOT,
          description: 'Система ведёт реестр требований.',
          source: 'overview.md § Реестр',
        },
      ],
      'login.md': [
        {
          type: 'FUNCTION',
          name: FT_LOGIN,
          description: 'Система обеспечивает вход по логину и паролю.',
          source: 'login.md § Вход',
        },
      ],
      'perf.md': [
        {
          type: 'NFR',
          name: NFR_PERF,
          description: 'Вход выполняется не дольше 2 секунд.',
          source: 'perf.md § Отклик',
          relatedFunctions: [FT_LOGIN],
        },
      ],
    });
    // structure: FT_LOGIN — ребёнок FT_ROOT (одна CHILD_OF-связь дерева).
    stub.setStructureParents({ [FT_LOGIN]: FT_ROOT });
    // relate-шаг: НФТ ↔ второй ФТ (FT_ROOT) — отдельная смысловая связь, которую
    // extraction не давал, чтобы показать работу шага «связи ФТ↔НФТ».
    stub.setRelatePairsByName({ [NFR_PERF]: [FT_ROOT] });
    // Каждый ответ модели обёрнут в <think>…</think> — проверка reasoning-strip.
    stub.setThinkWrap(true);

    try {
      await page.reload();
      await expect(page.getByTestId('main-page')).toBeVisible();

      const zip = makeZip(testInfo, 'docs-think.zip', DOCS);
      const extractionBefore = stub.extractionRequests.length;

      await page.getByTestId('footer-ai-import').click();
      await expect(page.getByTestId('ai-import')).toBeVisible();
      await page.getByTestId('ai-import-file').setInputFiles(zip);
      await page.getByTestId('ai-import-infer-links').check();
      await page.getByTestId('ai-import-start').click();

      // Двухзонная выверка дублей: одобряем обе зоны (гейт идёт до populate
      // и relate-шага).
      await approveDocsReviewGates(page);

      // Импорт завершился успешно, несмотря на <think>-обёртку во всех ответах.
      const success = page.getByTestId('ai-import-success');
      await expect(success).toBeVisible(JOB_TIMEOUT);

      // Сводка: 2 ФТ + 1 НФТ; 1 связь дерева (CHILD_OF); смысловых связей 2 =
      // extraction (НФТ→FT_LOGIN) + relate-шаг (НФТ→FT_ROOT).
      await expectAiImportSummary(page, {
        functions: 2,
        nfrs: 1,
        treeLinks: 1,
        relatesLinks: 2,
        skipped: 0,
      });

      // DoD: обе группы связей > 0 — баг «0 связей на думающих моделях» устранён.
      const treeLinks = Number(await page.getByTestId('ai-import-tree-links').innerText());
      const relatesLinks = Number(await page.getByTestId('ai-import-relates-links').innerText());
      expect(treeLinks).toBeGreaterThan(0);
      expect(relatesLinks).toBeGreaterThan(0);

      // Регресс бага «ответ обрезан по лимиту токенов» (todo_18/58b7342): при
      // дефолтном бюджете думающей модели (12000) и max_tokens = полный бюджет
      // reasoning-обёртка `<think>…</think>` помещается ЦЕЛИКОМ, ответ модели не
      // усекается. Наблюдаемый инвариант успешного импорта думающей моделью — в
      // журнале анализа НЕТ ни одной строки об усечении по лимиту токенов (её
      // сервер пишет только на finish_reason === 'length', и на всех этапах:
      // извлечение, структуризация, связи ФТ↔НФТ).
      const log = page.getByTestId('ai-import-log');
      await expect(log).toBeVisible();
      await expect(log).not.toContainText(TRUNCATED_LOG_MARKER);

      // Шаг «связи ФТ↔НФТ» реально отработал (relate-ответ тоже был в <think>).
      await expect(page.getByTestId('ai-import-relate-status')).toHaveText(
        'Проставление связей ФТ↔НФТ: создано связей: 1',
      );

      // Extraction шёл именно думающей моделью.
      const extractionCalls = stub.extractionRequests.slice(extractionBefore);
      expect(extractionCalls.length).toBeGreaterThan(0);
      for (const call of extractionCalls) expect(call.model).toBe(THINKING_MODEL);

      await page.getByTestId('ai-import-done').click();
      await expect(page.getByTestId('ai-import')).toHaveCount(0);
      await expect(rowByName(page, FT_ROOT)).toBeVisible();
      await expect(rowByName(page, NFR_PERF)).toBeVisible();

      // API-истина: дерево и симметричные RELATES_TO построены корректно.
      const reqs = await listRequirements(page, id);
      const byName = new Map(reqs.map((r) => [r.name, r]));
      const root = byName.get(FT_ROOT)!;
      const login = byName.get(FT_LOGIN)!;
      const nfr = byName.get(NFR_PERF)!;

      // CHILD_OF: FT_LOGIN → FT_ROOT; корень без родителя.
      expect(linkTargets(login, 'CHILD_OF')).toEqual([root.slug]);
      expect(linkTargets(root, 'CHILD_OF')).toEqual([]);

      // RELATES_TO симметричны: НФТ связана с обоими ФТ, у каждого — парная запись.
      expect(linkTargets(nfr, 'RELATES_TO').sort()).toEqual([login.slug, root.slug].sort());
      expect(linkTargets(login, 'RELATES_TO')).toEqual([nfr.slug]);
      expect(linkTargets(root, 'RELATES_TO')).toEqual([nfr.slug]);
    } finally {
      stub.setExtractionItems(null);
      stub.setStructureParents(null);
      stub.setRelatePairsByName(null);
      stub.setThinkWrap(false);
    }
  });
});
