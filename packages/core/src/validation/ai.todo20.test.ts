import { describe, expect, it } from 'vitest';
import {
  AI_IMPORT_ERROR_CATEGORIES,
  AI_IMPORT_ERROR_CODES,
  AI_IMPORT_MAX_ARCHIVE_BYTES,
  AI_IMPORT_MAX_DOC_FILES,
  AI_IMPORT_MAX_TEXT_FILES,
  AI_IMPORT_SOURCE_CLASSES,
  AI_IMPORT_STATUSES,
  AI_MODEL_ESTIMATE_THRESHOLD_TOKENS_DEFAULT,
  AI_MODEL_PARALLELISM_DEFAULT,
  AI_MODEL_PER_CALL_TIMEOUT_SEC_DEFAULT,
  AI_MODEL_PRESET_DEFAULTS,
  aiImportErrorFromCode,
  aiImportEstimateViewSchema,
  aiImportInventoryViewSchema,
  aiImportJobErrorSchema,
  aiImportJobListSchema,
  aiImportJobSummarySchema,
  aiImportJobViewSchema,
  aiImportReportViewSchema,
  aiImportUsageViewSchema,
  aiModelPresetOverrideSchema,
  aiModelPresetSchema,
  resolveModelPreset,
  type AiImportErrorCode,
} from './ai.js';

/*
 * todo_20 · T-201: контракт качества AI-импорта — пресет прогона, опись/смета,
 * usage, отчёт, история джоб, таксономия ошибок и новые статусы.
 */

describe('T-201 · aiModelPresetSchema: поля прогона', () => {
  const base = {
    temperature: 0.2,
    maxOutputTokens: 4000,
    chunkChars: 12_000,
    reasoning: 'none',
  };

  it('полный пресет с новыми полями валиден', () => {
    const parsed = aiModelPresetSchema.safeParse({
      ...base,
      parallelism: 4,
      perCallTimeoutSec: 60,
      runBudgetTokens: 1_000_000,
      estimateThresholdTokens: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it('runBudgetTokens/estimateThresholdTokens допускают null (= выключено)', () => {
    const parsed = aiModelPresetSchema.safeParse({
      ...base,
      parallelism: 1,
      perCallTimeoutSec: 10,
      runBudgetTokens: null,
      estimateThresholdTokens: null,
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['parallelism ниже 1', { parallelism: 0 }],
    ['parallelism выше 8', { parallelism: 9 }],
    ['parallelism дробный', { parallelism: 2.5 }],
    ['perCallTimeoutSec ниже 10', { perCallTimeoutSec: 9 }],
    ['runBudgetTokens отрицательный', { runBudgetTokens: -1 }],
    ['estimateThresholdTokens отрицательный', { estimateThresholdTokens: -5 }],
  ])('невалидно: %s', (_label, patch) => {
    const parsed = aiModelPresetSchema.safeParse({
      ...base,
      parallelism: 2,
      perCallTimeoutSec: 120,
      runBudgetTokens: null,
      estimateThresholdTokens: 2_000_000,
      ...patch,
    });
    expect(parsed.success).toBe(false);
  });

  it('обратная совместимость: старый override без новых полей валиден', () => {
    const parsed = aiModelPresetOverrideSchema.safeParse({
      temperature: 0.7,
      maxOutputTokens: 8000,
    });
    expect(parsed.success).toBe(true);
  });

  it('пустой override {} остаётся валидным (сброс к дефолтам)', () => {
    expect(aiModelPresetOverrideSchema.safeParse({}).success).toBe(true);
  });

  it('resolveModelPreset подставляет дефолты прогона для любого id', () => {
    const preset = resolveModelPreset('Unknown/Model');
    expect(preset.parallelism).toBe(AI_MODEL_PARALLELISM_DEFAULT);
    expect(preset.perCallTimeoutSec).toBe(AI_MODEL_PER_CALL_TIMEOUT_SEC_DEFAULT);
    expect(preset.runBudgetTokens).toBeNull();
    expect(preset.estimateThresholdTokens).toBe(AI_MODEL_ESTIMATE_THRESHOLD_TOKENS_DEFAULT);
  });

  it('resolveModelPreset: старый override не затирает новые дефолты, новый — переопределяет', () => {
    const legacy = resolveModelPreset('Qwen/Qwen3-Coder-Next', { temperature: 0.9 });
    expect(legacy.temperature).toBe(0.9);
    expect(legacy.parallelism).toBe(AI_MODEL_PARALLELISM_DEFAULT);

    const modern = resolveModelPreset('Qwen/Qwen3-Coder-Next', {
      parallelism: 8,
      runBudgetTokens: 5000,
      estimateThresholdTokens: 0,
    });
    expect(modern.parallelism).toBe(8);
    expect(modern.runBudgetTokens).toBe(5000);
    expect(modern.estimateThresholdTokens).toBe(0);
  });

  it('каждый штатный пресет по id — полный (валиден по схеме)', () => {
    for (const preset of Object.values(AI_MODEL_PRESET_DEFAULTS)) {
      expect(aiModelPresetSchema.safeParse(preset).success).toBe(true);
    }
  });
});

describe('T-201 · лимиты и классы источников', () => {
  it('лимит архива поднят до 200 МБ (решение PO №1)', () => {
    expect(AI_IMPORT_MAX_ARCHIVE_BYTES).toBe(200 * 1024 * 1024);
  });

  it('лимит текстовых файлов — 2000 (Н1)', () => {
    expect(AI_IMPORT_MAX_TEXT_FILES).toBe(2000);
    // Старое имя остаётся рабочим алиасом для существующих потребителей.
    expect(AI_IMPORT_MAX_DOC_FILES).toBe(AI_IMPORT_MAX_TEXT_FILES);
  });

  it('классы источников зафиксированы контрактом', () => {
    expect(AI_IMPORT_SOURCE_CLASSES).toEqual([
      'release-notes',
      'user-guide',
      'admin-guide',
      'security',
      'api-spec',
      'config',
      'other',
    ]);
  });

  it('статусы дополнены awaiting-confirmation и interrupted, старые сохранены', () => {
    for (const s of ['running', 'succeeded', 'failed', 'cancelled']) {
      expect(AI_IMPORT_STATUSES).toContain(s);
    }
    expect(AI_IMPORT_STATUSES).toContain('awaiting-confirmation');
    expect(AI_IMPORT_STATUSES).toContain('interrupted');
  });
});

describe('T-201 · схемы описи/сметы/usage/отчёта/истории', () => {
  it('inventory: агрегированная опись валидна', () => {
    const parsed = aiImportInventoryViewSchema.safeParse({
      totalFiles: 12,
      processed: { 'release-notes': 3, other: 2 },
      excluded: [{ path: '*.png', reason: 'бинарный файл (изображение)', count: 7 }],
    });
    expect(parsed.success).toBe(true);
  });

  it('inventory: неизвестный класс в processed отклоняется', () => {
    const parsed = aiImportInventoryViewSchema.safeParse({
      totalFiles: 1,
      processed: { docs: 1 },
      excluded: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('estimate: смета с порогом и без', () => {
    expect(
      aiImportEstimateViewSchema.safeParse({
        files: 5,
        chunks: 12,
        calls: 12,
        tokens: 48_000,
        thresholdTokens: 2_000_000,
        overThreshold: false,
      }).success,
    ).toBe(true);
    expect(
      aiImportEstimateViewSchema.safeParse({
        files: 5,
        chunks: 12,
        calls: 12,
        tokens: 48_000,
        thresholdTokens: null,
        overThreshold: false,
      }).success,
    ).toBe(true);
  });

  it('usage: отрицательные счётчики отклоняются', () => {
    expect(
      aiImportUsageViewSchema.safeParse({ promptTokens: 10, completionTokens: 0 }).success,
    ).toBe(true);
    expect(
      aiImportUsageViewSchema.safeParse({ promptTokens: -1, completionTokens: 0 }).success,
    ).toBe(false);
  });

  it('report: покрытие по классам + слепые зоны', () => {
    const parsed = aiImportReportViewSchema.safeParse({
      coverage: [
        {
          sourceClass: 'release-notes',
          files: 3,
          processedFiles: 3,
          extractedFunctions: 40,
          extractedNfrs: 5,
          retriedChunks: 1,
        },
      ],
      blindSpots: [{ kind: 'truncated', message: 'Ответ обрезан в 2 фрагментах.', count: 2 }],
    });
    expect(parsed.success).toBe(true);
    expect(
      aiImportReportViewSchema.safeParse({
        coverage: [],
        blindSpots: [{ kind: 'lost', message: 'x', count: 1 }],
      }).success,
    ).toBe(false);
  });

  it('история: summary и список джоб', () => {
    const summary = {
      jobId: 'j1',
      projectId: 'Demo',
      status: 'interrupted',
      startedAt: '2026-08-03T10:00:00.000Z',
      resumable: true,
    };
    expect(aiImportJobSummarySchema.safeParse(summary).success).toBe(true);
    expect(aiImportJobListSchema.safeParse({ jobs: [summary] }).success).toBe(true);
    expect(aiImportJobSummarySchema.safeParse({ ...summary, status: 'exploded' }).success).toBe(
      false,
    );
  });
});

describe('T-201 · таксономия ошибок', () => {
  const EXPECTED_CODES: AiImportErrorCode[] = [
    'CFG-01',
    'CFG-02',
    'CFG-03',
    'DATA-01',
    'DATA-02',
    'NET-01',
    'NET-02',
    'NET-03',
    'MODEL-01',
    'MODEL-02',
    'BUDGET-01',
    // Волна 1.2 (T-213): каждый fail-путь прод-кода имеет код реестра.
    'DATA-03',
    'INT-01',
  ];

  it('реестр содержит минимум кодов из контракта', () => {
    for (const code of EXPECTED_CODES) {
      expect(AI_IMPORT_ERROR_CODES[code]).toBeDefined();
    }
  });

  it('каждый код: русские message/action, валидная категория, флаг resumable', () => {
    for (const [code, info] of Object.entries(AI_IMPORT_ERROR_CODES)) {
      expect(info.message.length, code).toBeGreaterThan(0);
      expect(info.action.length, code).toBeGreaterThan(0);
      // Русский текст без техножаргона: обязана быть кириллица.
      expect(info.message, code).toMatch(/[а-яА-ЯёЁ]/);
      expect(info.action, code).toMatch(/[а-яА-ЯёЁ]/);
      expect(AI_IMPORT_ERROR_CATEGORIES).toContain(info.category);
      expect(typeof info.resumable, code).toBe('boolean');
    }
  });

  it('категории кодов соответствуют префиксам', () => {
    expect(AI_IMPORT_ERROR_CODES['CFG-02'].category).toBe('config');
    expect(AI_IMPORT_ERROR_CODES['DATA-02'].category).toBe('data');
    expect(AI_IMPORT_ERROR_CODES['NET-01'].category).toBe('network');
    expect(AI_IMPORT_ERROR_CODES['MODEL-01'].category).toBe('model');
    expect(AI_IMPORT_ERROR_CODES['BUDGET-01'].category).toBe('budget');
    expect(AI_IMPORT_ERROR_CODES['DATA-03'].category).toBe('data');
    expect(AI_IMPORT_ERROR_CODES['INT-01'].category).toBe('internal');
  });

  it('T-213: INT-01 резюмируем (чекпоинт сохраняет прогресс), DATA-03 — нет', () => {
    expect(AI_IMPORT_ERROR_CODES['INT-01'].resumable).toBe(true);
    expect(AI_IMPORT_ERROR_CODES['DATA-03'].resumable).toBe(false);
    expect(aiImportJobErrorSchema.safeParse(aiImportErrorFromCode('INT-01')).success).toBe(true);
    expect(aiImportJobErrorSchema.safeParse(aiImportErrorFromCode('DATA-03')).success).toBe(true);
  });

  it('aiImportErrorFromCode строит полный error-объект (hint = action)', () => {
    const error = aiImportErrorFromCode('BUDGET-01');
    expect(error).toMatchObject({
      code: 'BUDGET-01',
      category: 'budget',
      resumable: true,
      message: AI_IMPORT_ERROR_CODES['BUDGET-01'].message,
      hint: AI_IMPORT_ERROR_CODES['BUDGET-01'].action,
      action: AI_IMPORT_ERROR_CODES['BUDGET-01'].action,
    });
    expect(aiImportJobErrorSchema.safeParse(error).success).toBe(true);
  });

  it('aiImportErrorFromCode допускает переопределение message/hint', () => {
    const error = aiImportErrorFromCode('CFG-03', {
      message: 'Модель «x» не найдена. Доступные: a, b.',
    });
    expect(error.message).toContain('не найдена');
    expect(error.code).toBe('CFG-03');
  });
});

describe('T-201 · расширенный job view (обратная совместимость)', () => {
  const legacyView = {
    jobId: 'j1',
    projectId: 'Demo',
    status: 'failed',
    stage: 'analyze',
    progress: 40,
    log: [{ ts: '2026-08-03T10:00:00.000Z', level: 'error', message: 'x' }],
    error: { message: 'Ошибка.', hint: 'Повторите.' },
  };

  it('старый view (error только message+hint) валиден', () => {
    expect(aiImportJobViewSchema.safeParse(legacyView).success).toBe(true);
  });

  it('новый view: usage/inventory/estimate/report/прогресс-поля/расширенный error', () => {
    const parsed = aiImportJobViewSchema.safeParse({
      ...legacyView,
      status: 'awaiting-confirmation',
      currentFile: 'docs/notes.json',
      currentClass: 'release-notes',
      chunkIndex: 3,
      chunkTotal: 10,
      etaSeconds: null,
      usage: { promptTokens: 100, completionTokens: 20 },
      inventory: { totalFiles: 2, processed: { other: 2 }, excluded: [] },
      estimate: {
        files: 2,
        chunks: 4,
        calls: 4,
        tokens: 16_000,
        thresholdTokens: 0,
        overThreshold: true,
      },
      report: { coverage: [], blindSpots: [] },
      error: aiImportErrorFromCode('NET-01'),
    });
    expect(parsed.success).toBe(true);
  });

  it('невалидный currentClass отклоняется', () => {
    expect(aiImportJobViewSchema.safeParse({ ...legacyView, currentClass: 'docs' }).success).toBe(
      false,
    );
  });
});
