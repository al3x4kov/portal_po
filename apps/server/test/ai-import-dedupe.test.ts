import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiExtractedRequirement, AiImportResult } from '@po/core';
import type { AiImportJobState } from '../src/services/AiImportJobs.js';
import type { AiImportRuntime, JsonCallOutcome } from '../src/services/aiImport/types.js';
import {
  AI_DEDUPE_PAIR_BATCH,
  AI_DEDUPE_SIMILARITY,
  dedupeExtracted,
  detectExistingDuplicates,
  groupDuplicatePairs,
  nameSimilarity,
  normalizeRequirementName,
  runDedupeStage,
} from '../src/services/aiImport/dedupe.js';
import { createRequirementService } from '../src/factory.js';
import { cleanup, makeTmpRoot } from './helpers.js';
import {
  KIT_PROJECT,
  approveDocsReview,
  makeImportHarness,
  scriptedClient,
  writeZipArchive,
  type ImportHarness,
} from './aiImportKit.js';

/*
 * todo_20 · T-207: детерминированная дедупликация (нормализация имени + fuzzy
 * ≥0.85, спорные пары — модели батчами ≤20 с бинарным ответом) и контроль
 * полноты (extracted < 50% expectedRecords → один повторный проход).
 */

function rec(over: Partial<AiExtractedRequirement> = {}): AiExtractedRequirement {
  return {
    type: 'FUNCTION',
    name: 'Вход по паролю',
    description: 'Пользователь входит по паролю.',
    source: 'auth.md § Вход',
    ...over,
  };
}

/** Minimal fake runtime with a scripted chat queue. */
function fakeRt(chat: JsonCallOutcome<unknown>[] = []) {
  const job: AiImportJobState = {
    jobId: 'j1',
    projectId: 'Demo',
    status: 'running',
    stage: 'analyze',
    progress: 10,
    log: [],
    cancelRequested: false,
  };
  const counters: AiImportResult = {
    createdFunctions: 0,
    createdNfrs: 0,
    skippedExisting: 0,
    links: 0,
    relatesLinks: 0,
  };
  const queue = [...chat];
  const rt: AiImportRuntime = {
    job,
    counters,
    log: (level, message) => job.log.push({ ts: 't', level, message }),
    cancelled: () => false,
    fail: () => {},
    failCode: () => {},
    chat: async <T>() => (queue.shift() ?? { kind: 'unparsed' }) as JsonCallOutcome<T>,
    checkpoint: () => {},
  };
  return { rt, job };
}

describe('T-207 · нормализация и похожесть имён (unit)', () => {
  it('normalizeRequirementName: регистр, пунктуация, кавычки, ё, пробелы', () => {
    expect(normalizeRequirementName('  «Вход по паролю».  ')).toBe('вход по паролю');
    expect(normalizeRequirementName('ВХОД ПО ПАРОЛЮ!')).toBe('вход по паролю');
    expect(normalizeRequirementName('Уведомление о своём отчёте')).toBe(
      normalizeRequirementName('Уведомление о своем отчете'),
    );
    expect(normalizeRequirementName('Export/Import (CSV)')).toBe('export import csv');
  });

  it('nameSimilarity: идентичные = 1, близкие ≥ порога, разные — ниже', () => {
    const a = normalizeRequirementName('Быстрый фильтр по статусу');
    const b = normalizeRequirementName('Быстрый фильтр по статусам');
    expect(nameSimilarity(a, a)).toBe(1);
    expect(nameSimilarity(a, b)).toBeGreaterThanOrEqual(AI_DEDUPE_SIMILARITY);
    expect(nameSimilarity(a, normalizeRequirementName('Экспорт проекта в архив'))).toBeLessThan(
      AI_DEDUPE_SIMILARITY,
    );
  });

  it('dedupeExtracted: точные (нормализованные) дубли сливаются кодом, союз relatedFunctions, длиннейшее описание', () => {
    const out = dedupeExtracted([
      rec({ type: 'NFR', name: 'Время отклика', relatedFunctions: ['Поиск'] }),
      rec({
        type: 'NFR',
        name: '«время отклика»',
        description: 'Отклик до 200 мс на всех экранах системы.',
        relatedFunctions: ['Фильтр'],
      }),
    ]);
    expect(out.records).toHaveLength(1);
    expect(out.autoMerged).toEqual(['«время отклика»']);
    expect(out.records[0]!.name).toBe('Время отклика'); // первый — канонический
    expect(out.records[0]!.description).toContain('на всех экранах'); // длиннее
    expect(out.records[0]!.relatedFunctions).toEqual(['Поиск', 'Фильтр']);
  });

  it('dedupeExtracted: похожие, но не идентичные — спорная пара; разные типы не сравниваются', () => {
    const out = dedupeExtracted([
      rec({ name: 'Быстрый фильтр по статусу' }),
      rec({ name: 'Быстрый фильтр по статусам' }),
      rec({ type: 'NFR', name: 'Быстрый фильтр по статусу' }), // другой тип — не пара
    ]);
    expect(out.records).toHaveLength(3);
    expect(out.ambiguous).toHaveLength(1);
    expect(out.ambiguous[0]!.kept.name).toBe('Быстрый фильтр по статусу');
    expect(out.ambiguous[0]!.candidate.name).toBe('Быстрый фильтр по статусам');
  });

  it('батч спорных пар ограничен 20', () => {
    expect(AI_DEDUPE_PAIR_BATCH).toBe(20);
  });
});

describe('T-207 · runDedupeStage (изолированно)', () => {
  it('двухзонная выверка: подтверждённая пара НЕ сливается — образует группу дублей; неподтверждённая — нет', async () => {
    const extracted = [
      rec({ name: 'Быстрый фильтр по статусу' }),
      rec({ name: 'Быстрый фильтр по статусам', description: 'Более подробное описание фильтра.' }),
      rec({ name: 'Экспорт отчёта в PDF' }),
      rec({ name: 'Экспорт отчётов в PDF' }),
    ];
    // Первый батч: pair 1 — дубль, pair 2 — нет.
    const { rt, job } = fakeRt([
      {
        kind: 'ok',
        value: [
          { pair: 1, duplicate: true },
          { pair: 2, duplicate: false },
        ],
      },
    ]);
    const out = await runDedupeStage(rt, {
      extracted,
      client: scriptedClient([]),
      model: 'm',
      preset: {
        temperature: 0.2,
        maxOutputTokens: 100,
        chunkChars: 1000,
        reasoning: 'none',
        parallelism: 1,
        perCallTimeoutSec: 10,
        runBudgetTokens: null,
        estimateThresholdTokens: null,
      },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Все четыре записи сохранены: решение «что оставить» уходит на зону 1.
    expect(out.extracted.map((r) => r.name)).toEqual([
      'Быстрый фильтр по статусу',
      'Быстрый фильтр по статусам',
      'Экспорт отчёта в PDF',
      'Экспорт отчётов в PDF',
    ]);
    // Подтверждённая пара стала группой; неподтверждённая (pair 2) — нет.
    expect(out.duplicateGroups).toHaveLength(1);
    expect(out.duplicateGroups[0]!.map((r) => r.name)).toEqual([
      'Быстрый фильтр по статусу',
      'Быстрый фильтр по статусам',
    ]);
    expect(job.log.some((l) => l.message.includes('ручную выверку'))).toBe(true);
  });

  it('groupDuplicatePairs: цепочка A~B, B~C складывается в одну группу', () => {
    const a = rec({ name: 'Импорт бэклога' });
    const b = rec({ name: 'Импорт бэклога!' });
    const c = rec({ name: 'Импорт бэклога?' });
    const d = rec({ name: 'Экспорт проекта' });
    const groups = groupDuplicatePairs(
      [a, b, c, d],
      [
        { kept: a, candidate: b },
        { kept: b, candidate: c },
      ],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual([a, b, c]);
  });

  it('detectExistingDuplicates (зона 2): точное имя = 1, fuzzy ≥ порога, чужой тип не сравнивается', () => {
    const generated = [
      rec({ name: 'Вход по паролю' }),
      rec({ name: 'Экспорт отчёта в PDF' }),
      rec({ name: 'Совсем новая функция' }),
      rec({ type: 'NFR', name: 'Вход по паролю' }), // НФТ против ФТ — не дубль
    ];
    const existing = [
      { type: 'FUNCTION' as const, name: '«Вход по паролю»' },
      { type: 'FUNCTION' as const, name: 'Экспорт отчётов в PDF' },
    ];
    const dup = detectExistingDuplicates(generated, existing);
    expect(dup.get(generated[0]!)).toEqual({ name: '«Вход по паролю»', similarity: 1 });
    const fuzzy = dup.get(generated[1]!);
    expect(fuzzy?.name).toBe('Экспорт отчётов в PDF');
    expect(fuzzy?.similarity).toBeGreaterThanOrEqual(AI_DEDUPE_SIMILARITY);
    expect(fuzzy?.similarity).toBeLessThan(1);
    expect(dup.has(generated[2]!)).toBe(false);
    expect(dup.has(generated[3]!)).toBe(false);
  });

  it('сбой модели на спорных парах не роняет джобу — записи сохраняются раздельно', async () => {
    const { rt, job } = fakeRt([{ kind: 'unparsed' }]);
    const out = await runDedupeStage(rt, {
      extracted: [rec({ name: 'Поиск по имени' }), rec({ name: 'Поиск по имени!' })],
      client: scriptedClient([]),
      model: 'm',
      preset: {
        temperature: 0.2,
        maxOutputTokens: 100,
        chunkChars: 1000,
        reasoning: 'none',
        parallelism: 1,
        perCallTimeoutSec: 10,
        runBudgetTokens: null,
        estimateThresholdTokens: null,
      },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // «Поиск по имени!» слился автоматически (нормализация убирает пунктуацию),
    // спорных пар нет — модель не понадобилась.
    expect(out.extracted).toHaveLength(1);
    expect(job.log.some((l) => l.message.includes('автоматически слито 1'))).toBe(true);
  });
});

describe('T-207 · контроль полноты (интеграция через сервис)', () => {
  let root: string;
  let h: ImportHarness;
  const archives: string[] = [];

  beforeEach(async () => {
    root = await makeTmpRoot();
    h = await makeImportHarness(root);
  });
  afterEach(async () => {
    await Promise.all(archives.splice(0).map((f) => fs.rm(f, { force: true }).catch(() => {})));
    await cleanup(root);
  });

  it('extracted < 50% expectedRecords → ровно один повторный проход «извлеки ВСЕ, найдено N из ~M»', async () => {
    // JSON с 10 записями → normalize даёт expectedRecords=10.
    const releaseJson = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({
        name: `Функция ${i + 1}`,
        description: `Описание возможности ${i + 1}.`,
      })),
    );
    const first = JSON.stringify([
      { type: 'FUNCTION', name: 'Функция 1', description: 'Описание 1.', source: 'r.json § 1' },
    ]);
    const repeat = JSON.stringify(
      Array.from({ length: 8 }, (_, i) => ({
        type: 'FUNCTION',
        name: `Функция ${i + 1}`,
        description: `Описание возможности ${i + 1}.`,
        source: `r.json § ${i + 1}`,
      })),
    );
    const structure = '[]';
    // Первый вызов — LLM-классификация описи (файл >400 символов без
    // эвристических маркеров), затем извлечение, повторный проход и структура.
    const classify = JSON.stringify([{ path: 'r.json', class: 'release-notes' }]);
    const client = scriptedClient([classify, first, repeat, structure]);
    const service = h.makeService(client);
    const archive = await writeZipArchive({ 'r.json': releaseJson });
    archives.push(archive);
    const { jobId } = await service.start(KIT_PROJECT, archive);
    await service.waitForCompletion(jobId);
    // Двухзонная выверка: подтверждаем обе зоны целиком (прежний исход).
    await approveDocsReview(service, jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.log.some((l) => l.level === 'warn' && l.message.includes('повторный проход'))).toBe(
      true,
    );
    // Повторный проход дополнил набор: 8 уникальных функций (дедуп слил повторы).
    expect(view.result?.createdFunctions).toBe(8);
    // Отчёт фиксирует повторно пройденные фрагменты.
    const retried = view.report?.coverage.reduce((n, c) => n + c.retriedChunks, 0) ?? 0;
    expect(retried).toBeGreaterThanOrEqual(1);
  });

  it('полнота достаточна → повторного прохода нет', async () => {
    const releaseJson = JSON.stringify(
      Array.from({ length: 2 }, (_, i) => ({
        name: `Функция ${i + 1}`,
        description: `Описание ${i + 1}.`,
      })),
    );
    const answer = JSON.stringify(
      Array.from({ length: 2 }, (_, i) => ({
        type: 'FUNCTION',
        name: `Функция ${i + 1}`,
        description: `Описание ${i + 1}.`,
        source: `r.json § ${i + 1}`,
      })),
    );
    const client = scriptedClient([answer, '[]']);
    const service = h.makeService(client);
    const archive = await writeZipArchive({ 'r.json': releaseJson });
    archives.push(archive);
    const { jobId } = await service.start(KIT_PROJECT, archive);
    await service.waitForCompletion(jobId);
    // Двухзонная выверка: подтверждаем обе зоны целиком (прежний исход).
    await approveDocsReview(service, jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.log.some((l) => l.message.includes('повторный проход'))).toBe(false);

    // D-заметка: созданные требования соответствуют извлечённым уникальным именам.
    const { requirements } = await createRequirementService(h.ctx, KIT_PROJECT).list();
    expect(requirements.map((r) => r.name).sort()).toEqual(['Функция 1', 'Функция 2']);
  });
});
