import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiImportResult, AiImportSourceClass, AiModelPreset } from '@po/core';
import { aiImportErrorFromCode, resolveModelPreset } from '@po/core';
import type { AiClient } from '../src/services/AiHubService.js';
import type { AiImportJobState } from '../src/services/AiImportJobs.js';
import type { AiImportRuntime, ChatArgs, JsonCallOutcome } from '../src/services/aiImport/types.js';
import type { ParsedExtraction } from '../src/services/aiImportPrompt.js';
import {
  batchFileSeparator,
  planWorkUnits,
  runAnalyzeStage,
} from '../src/services/aiImport/analyzeStage.js';
import { runInventoryStage } from '../src/services/aiImport/inventoryStage.js';
import { computeEstimate } from '../src/services/aiImport/estimateStage.js';
import {
  AI_TIMEOUT_BACKOFF_MAX_MS,
  AI_TIMEOUT_BACKOFF_MIN_MS,
  callAiWithRetries,
  type AiRetryDiagnostics,
} from '../src/services/aiImport/aiCall.js';
import { ParallelismGovernor } from '../src/services/aiImport/parallel.js';
import type { AiJobCheckpoint } from '../src/services/aiImport/checkpoint.js';
import { ReportBuilder } from '../src/services/aiImport/report.js';
import {
  KIT_PROJECT,
  makeImportHarness,
  scriptedClient,
  writeZipArchive,
  type ImportHarness,
} from './aiImportKit.js';
import { cleanup, makeTmpRoot } from './helpers.js';

/*
 * todo_23 — экономика вызовов AI-импорта:
 *  M1 батчинг мелких файлов одного класса (приёмка №1),
 *  M2 контроль полноты только для release-notes, ≤1 повтора (приёмка №2),
 *  M3 честные extracted-счётчики + текст остановки/ошибки (приёмка №3),
 *  M4 быстрый бэкофф после тайм-аута и восстановление параллелизма (приёмка №4),
 *  M5 пульс инвентаризации (приёмка №5).
 */

const PRESET: AiModelPreset = resolveModelPreset('gpt-test');
const STUB_CLIENT = {} as AiClient;

type ChatFake = (args: ChatArgs<unknown>) => JsonCallOutcome<unknown>;

/** Stage-level runtime: dynamic chat fake + живой checkpoint-стейт. */
function harness(opts: { chat?: ChatFake; cancelled?: () => boolean } = {}) {
  const job: AiImportJobState = {
    jobId: 'j1',
    projectId: 'Demo',
    status: 'running',
    stage: 'unpack',
    progress: 0,
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
  const state: AiJobCheckpoint = {
    version: 1,
    jobId: 'j1',
    projectId: 'Demo',
    model: 'gpt-test',
    inferLinks: false,
    startedAt: 't',
    status: 'running',
    stage: 'analyze',
    progress: 10,
    confirmed: true,
    log: [],
    counters: { ...counters },
    analyze: {
      files: [],
      fileIndex: 0,
      charOffset: 0,
      processedChunks: 0,
      totalChunks: 0,
      extracted: [],
    },
  };
  const logs: Array<{ level: string; message: string }> = [];
  const calls: Array<ChatArgs<unknown>> = [];
  const failure: { message?: string; code?: string } = {};
  const rt: AiImportRuntime = {
    job,
    counters,
    log: (level, message) => {
      logs.push({ level, message });
      job.log.push({ ts: 't', level, message });
    },
    cancelled: () => opts.cancelled?.() ?? false,
    fail: (message) => {
      failure.message = message;
      job.status = 'failed';
    },
    failCode: (code, overrides) => {
      const error = aiImportErrorFromCode(code, overrides);
      failure.message = error.message;
      failure.code = code;
      job.status = 'failed';
      job.error = error;
    },
    chat: async <T>(args: ChatArgs<T>) => {
      calls.push(args as ChatArgs<unknown>);
      const fake = opts.chat ?? (() => ({ kind: 'unparsed' }) as JsonCallOutcome<unknown>);
      return fake(args as ChatArgs<unknown>) as JsonCallOutcome<T>;
    },
    checkpoint: (mutate) => mutate?.(state),
  };
  return { rt, job, counters, logs, calls, failure, state };
}

/** Extraction-ответ из промпта: каждый маркер FN-… становится записью. */
const extractionFromPrompt: ChatFake = (args) => {
  const text = args.messages.map((m) => m.content).join('\n');
  const ids = [...new Set(text.match(/FN-[\w-]+/g) ?? [])];
  const value: ParsedExtraction = {
    items: ids.map((id) => ({
      type: 'FUNCTION',
      name: `Функция ${id}`,
      description: `Описание ${id}.`,
      source: `${id}`,
    })) as ParsedExtraction['items'],
    droppedNoSource: 0,
    droppedInvalid: 0,
  };
  return { kind: 'ok', value };
};

const okEmpty: ChatFake = () => ({
  kind: 'ok',
  value: { items: [], droppedNoSource: 0, droppedInvalid: 0 },
});

async function makeDocsDir(files: Record<string, string>): Promise<string> {
  const dir = path.join(os.tmpdir(), `po-todo23-${randomBytes(8).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

function analyzeInput(
  docsDir: string,
  files: string[],
  over: Partial<Parameters<typeof runAnalyzeStage>[1]> = {},
): Parameters<typeof runAnalyzeStage>[1] {
  return {
    docsDir,
    files,
    archiveMap: 'карта архива' as never,
    model: 'gpt-test',
    apiKey: 'sk',
    baseURL: 'http://hub',
    preset: PRESET,
    chunkChars: 4000,
    makeAiClient: () => STUB_CLIENT,
    ...over,
  };
}

/** 120 мелких файлов одного класса с уникальными маркерами. */
function smallFiles(count: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 1; i <= count; i++) {
    const id = String(i).padStart(3, '0');
    out[`small-${id}.md`] = `- Функция FN-${id}-1 — краткое описание возможности.`;
  }
  return out;
}

const MD_TABLE_6 = [
  '| Название | Описание |',
  '| --- | --- |',
  '| Функция Ф1 | описание 1 |',
  '| Функция Ф2 | описание 2 |',
  '| Функция Ф3 | описание 3 |',
  '| Функция Ф4 | описание 4 |',
  '| Функция Ф5 | описание 5 |',
  '| Функция Ф6 | описание 6 |',
].join('\n');

describe('M1 — батчинг мелких файлов одного класса (приёмка №1)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})),
    );
  });

  it('planWorkUnits: пакует мелкие файлы одного класса до chunkChars, большие — отдельно', () => {
    const docs = [
      { file: 'a1.md', length: 100, cls: 'release-notes' as AiImportSourceClass },
      { file: 'a2.md', length: 100, cls: 'release-notes' as AiImportSourceClass },
      { file: 'big.md', length: 9000, cls: 'release-notes' as AiImportSourceClass },
      { file: 'b1.md', length: 100, cls: 'api-spec' as AiImportSourceClass },
      { file: 'b2.md', length: 100, cls: 'api-spec' as AiImportSourceClass },
    ];
    const units = planWorkUnits(docs, 0, 0, 4000);
    expect(units).toEqual([[0, 1], [2], [3, 4]]);
  });

  it('planWorkUnits: возобновлённый частично обработанный файл не батчится', () => {
    const docs = [
      { file: 'a1.md', length: 100, cls: 'other' as AiImportSourceClass },
      { file: 'a2.md', length: 100, cls: 'other' as AiImportSourceClass },
    ];
    expect(planWorkUnits(docs, 0, 50, 4000)).toEqual([[0], [1]]);
  });

  it('≥100 мелких файлов одного класса: вызовов ≤ ceil(суммарный размер/chunkChars)', async () => {
    const files = smallFiles(120);
    const docsDir = await makeDocsDir(files);
    dirs.push(docsDir);
    const names = Object.keys(files);
    const report = ReportBuilder.fromInventory({
      totalFiles: 120,
      processed: { 'release-notes': 120 },
      excluded: [],
    });
    const { rt, calls, logs, state, counters, job } = harness({ chat: extractionFromPrompt });
    const out = await runAnalyzeStage(
      rt,
      analyzeInput(docsDir, names, {
        classes: new Map(names.map((n) => [n, 'release-notes'])),
        report,
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Приёмка №1: количество extraction-вызовов ограничено объёмом, не числом файлов.
    const totalWithSeparators = names.reduce(
      (sum, n) => sum + batchFileSeparator(n).length + 1 + files[n]!.length + 1,
      0,
    );
    const bound = Math.ceil(totalWithSeparators / 4000);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeLessThanOrEqual(bound);

    // Все записи извлечены, provenance по файлам не потерян (120 уникальных).
    expect(new Set(out.extracted.map((r) => r.name)).size).toBe(120);

    // Лог/прогресс: «фрагмент X из Y (N файлов)».
    expect(logs.some((l) => /фрагмент 1 из \d+ \(\d+ файлов\)/.test(l.message))).toBe(true);

    // M3: extracted-счётчики копятся по ходу analyze.
    expect(counters.extractedFunctions).toBe(120);
    expect(counters.extractedNfrs).toBe(0);
    expect(job.extractedFunctions).toBe(120);

    // Курсор описи дошёл до конца, отчёт покрытия не деградировал.
    expect(state.analyze?.fileIndex).toBe(120);
    expect(state.analyze?.charOffset).toBe(0);
    const row = report.view().coverage.find((c) => c.sourceClass === 'release-notes');
    expect(row?.processedFiles).toBe(120);
    expect(row?.extractedFunctions).toBe(120);
  });

  it('файлы разных классов не смешиваются в одном пакете; в тексте есть разделители', async () => {
    const files: Record<string, string> = {
      'a1.md': '- Функция FN-A-1 — апи.',
      'a2.md': '- Функция FN-A-2 — апи.',
      'b1.md': '- Функция FN-B-1 — гайд.',
      'b2.md': '- Функция FN-B-2 — гайд.',
    };
    const docsDir = await makeDocsDir(files);
    dirs.push(docsDir);
    const classes = new Map<string, AiImportSourceClass>([
      ['a1.md', 'api-spec'],
      ['a2.md', 'api-spec'],
      ['b1.md', 'user-guide'],
      ['b2.md', 'user-guide'],
    ]);
    const { rt, calls } = harness({ chat: extractionFromPrompt });
    const out = await runAnalyzeStage(rt, analyzeInput(docsDir, Object.keys(files), { classes }));
    expect(out.ok).toBe(true);
    expect(calls.length).toBe(2);
    const texts = calls.map((c) => c.messages.map((m) => m.content).join('\n'));
    expect(texts[0]).toContain(batchFileSeparator('a1.md'));
    expect(texts[0]).toContain(batchFileSeparator('a2.md'));
    expect(texts[0]).not.toContain(batchFileSeparator('b1.md'));
    expect(texts[1]).toContain(batchFileSeparator('b1.md'));
    expect(texts[1]).toContain(batchFileSeparator('b2.md'));
  });

  it('большой файл делится чанкером как раньше (без разделителей)', async () => {
    const big = Array.from(
      { length: 400 },
      (_, i) => `Строка ${i + 1}: ${'текст '.repeat(10)}`,
    ).join('\n');
    const docsDir = await makeDocsDir({ 'big.md': big });
    dirs.push(docsDir);
    const { rt, calls } = harness({ chat: okEmpty });
    const out = await runAnalyzeStage(
      rt,
      analyzeInput(docsDir, ['big.md'], {
        chunkChars: 10_000,
        classes: new Map([['big.md', 'other']]),
      }),
    );
    expect(out.ok).toBe(true);
    expect(calls.length).toBe(Math.ceil(big.length / 10_000));
    const first = calls[0]!.messages.map((m) => m.content).join('\n');
    expect(first).toContain('Файл: big.md');
    expect(first).not.toContain('=== Файл:');
  });

  it('resume: курсор по описи переживает батчинг (без потери и без дублей)', async () => {
    const files = smallFiles(120);
    const docsDir = await makeDocsDir(files);
    dirs.push(docsDir);
    const names = Object.keys(files);
    const classes = new Map<string, AiImportSourceClass>(
      names.map((n) => [n, 'release-notes'] as const),
    );

    // Прогон 1: второй вызов падает тайм-аутом → NET-03, первый пакет оплачен.
    let n = 0;
    const first = harness({
      chat: (args) => {
        n += 1;
        if (n >= 2) {
          return { kind: 'upstream', error: new Error('timed out'), errorClass: 'timeout' };
        }
        return extractionFromPrompt(args);
      },
    });
    const out1 = await runAnalyzeStage(first.rt, analyzeInput(docsDir, names, { classes }));
    expect(out1.ok).toBe(false);
    expect(first.failure.code).toBe('NET-03');
    const cursor = first.state.analyze!;
    expect(cursor.fileIndex).toBeGreaterThan(0);
    expect(cursor.fileIndex).toBeLessThan(120);
    expect(cursor.extracted.length).toBe(cursor.fileIndex); // 1 запись на файл

    // Прогон 2: продолжение с курсора — извлечены ВСЕ 120, без дублей.
    const second = harness({ chat: extractionFromPrompt });
    const out2 = await runAnalyzeStage(
      second.rt,
      analyzeInput(docsDir, names, {
        classes,
        resume: {
          fileIndex: cursor.fileIndex,
          charOffset: cursor.charOffset,
          extracted: cursor.extracted,
          processedChunks: cursor.processedChunks,
          chunker: first.state.chunker,
        },
      }),
    );
    expect(out2.ok).toBe(true);
    if (!out2.ok) return;
    const names2 = out2.extracted.map((r) => r.name);
    expect(names2.length).toBe(120);
    expect(new Set(names2).size).toBe(120);
  });
});

describe('M2 — контроль полноты только для release-notes (приёмка №2)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})),
    );
  });

  it('не-RN класс: 0 извлечённых → повторного прохода нет', async () => {
    const docsDir = await makeDocsDir({ 'api.md': MD_TABLE_6 });
    dirs.push(docsDir);
    const { rt, calls, logs } = harness({ chat: okEmpty });
    const out = await runAnalyzeStage(
      rt,
      analyzeInput(docsDir, ['api.md'], {
        classes: new Map([['api.md', 'api-spec']]),
      }),
    );
    expect(out.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(logs.some((l) => l.message.includes('повторный проход'))).toBe(false);
  });

  it('release-notes: не более ОДНОГО повторного прохода на фрагмент', async () => {
    const docsDir = await makeDocsDir({ 'rn.md': MD_TABLE_6 });
    dirs.push(docsDir);
    const one: ChatFake = () => ({
      kind: 'ok',
      value: {
        items: [{ type: 'FUNCTION', name: 'Функция Ф1', description: 'д', source: 'rn.md § 1' }],
        droppedNoSource: 0,
        droppedInvalid: 0,
      },
    });
    const { rt, calls, logs } = harness({ chat: one });
    const out = await runAnalyzeStage(
      rt,
      analyzeInput(docsDir, ['rn.md'], {
        classes: new Map([['rn.md', 'release-notes']]),
      }),
    );
    expect(out.ok).toBe(true);
    // Первый проход + ровно один повтор (1 < 6/2), но никогда не третий.
    expect(calls.length).toBe(2);
    expect(logs.filter((l) => l.message.includes('повторный проход')).length).toBe(1);
  });
});

describe('M3 — честные счётчики и сообщение остановки (приёмка №3)', () => {
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

  const RN_DOC = 'Что нового\n- Функция А1 — описание возможности.';
  const GUIDE_DOC = 'Руководство пользователя\nОписание работы с системой.';
  const CONF_DOC = 'Параметры конфигурации\nтаймаут подключения = 5с';
  const rec = (name: string, source: string): string =>
    JSON.stringify([{ type: 'FUNCTION', name, description: 'Описание.', source }]);

  it('остановка: «Извлечено … сохранены в контрольной точке» при extracted>created', async () => {
    const answers = [
      rec('Функция А1', 'rn.md'),
      () => {
        // Пользователь жмёт «Остановить» во время второго вызова.
        const job = h.jobs.byProject(KIT_PROJECT)[0]!;
        job.cancelRequested = true;
        return rec('Функция Б1', 'guide.md');
      },
    ];
    const client = scriptedClient(answers);
    const service = h.makeService(client);
    const archive = await writeZipArchive({
      'rn.md': RN_DOC,
      'guide.md': GUIDE_DOC,
      'conf.md': CONF_DOC,
    });
    archives.push(archive);
    const { jobId } = await service.start(KIT_PROJECT, archive);
    await service.waitForCompletion(jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('cancelled');
    const stop = view.log.find((l) => l.message.includes('Автоматизация остановлена'));
    expect(stop).toBeDefined();
    expect(stop!.message).toContain('Извлечено 2 записей (ФТ 2, НФТ 0)');
    expect(stop!.message).toContain('сохранены в контрольной точке');
    expect(view.result?.createdFunctions).toBe(0);
    expect(view.result?.extractedFunctions).toBe(2);
    expect(view.extractedFunctions).toBe(2);
  });

  it('fail: extracted-счётчики в result и строка про контрольную точку; resume доводит до создания', async () => {
    const timeoutErr = (): Error => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    const client = scriptedClient([rec('Функция А1', 'rn.md'), timeoutErr]);
    const service = h.makeService(client);
    const archive = await writeZipArchive({ 'rn.md': RN_DOC, 'guide.md': GUIDE_DOC });
    archives.push(archive);
    const { jobId } = await service.start(KIT_PROJECT, archive);
    await service.waitForCompletion(jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.error?.code).toBe('NET-03');
    expect(view.result?.extractedFunctions).toBe(1);
    expect(view.result?.createdFunctions).toBe(0);
    expect(
      view.log.some(
        (l) =>
          l.message.includes('сохранены в контрольной точке') &&
          l.message.includes('Извлечено 1 записей (ФТ 1, НФТ 0)'),
      ),
    ).toBe(true);
    const cp = await h.checkpoints.findByJobId(jobId);
    expect(cp?.counters.extractedFunctions).toBe(1);

    // Resume: извлечение продолжается, создание доводится до конца.
    const service2 = h.makeService(scriptedClient([rec('Функция Б1', 'guide.md'), '[]']));
    await service2.resume(jobId);
    await service2.waitForCompletion(jobId);
    const done = service2.getView(jobId);
    expect(done.status).toBe('succeeded');
    expect(done.result?.createdFunctions).toBe(2);
    expect(done.result?.extractedFunctions).toBe(2);
  });
});

describe('M4 — восстановление после тайм-аутов (приёмка №4)', () => {
  it('первый повтор после per-call тайм-аута ждёт 15–30 с, а не экспоненту', async () => {
    const hang = (signal: AbortSignal): Promise<never> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const runWithRandom = async (
      random: () => number,
    ): Promise<{ sleeps: number[]; diags: AiRetryDiagnostics[] }> => {
      const sleeps: number[] = [];
      const diags: AiRetryDiagnostics[] = [];
      const result = await callAiWithRetries({
        call: hang,
        timeoutMs: 5,
        maxAttempts: 2,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random,
        onRetry: (d) => diags.push(d),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errorClass).toBe('timeout');
      return { sleeps, diags };
    };

    const zero = await runWithRandom(() => 0);
    expect(zero.sleeps[0]).toBe(AI_TIMEOUT_BACKOFF_MIN_MS);
    expect(zero.diags[0]?.waitMs).toBe(AI_TIMEOUT_BACKOFF_MIN_MS);

    const one = await runWithRandom(() => 1);
    expect(one.sleeps[0]).toBe(AI_TIMEOUT_BACKOFF_MAX_MS);
  });

  it('governor: после деградации K→1 восстановление +1 за каждые 3 успеха до пресета', () => {
    const governor = new ParallelismGovernor(3);
    expect(governor.limit()).toBe(3);
    expect(governor.noteRateLimited()).toBe(true);
    expect(governor.limit()).toBe(1);

    // 3 успеха → K=2, ещё 3 → K=3 (пресет), дальше — без изменений.
    expect(governor.noteSuccess()).toBe(false);
    expect(governor.noteSuccess()).toBe(false);
    expect(governor.noteSuccess()).toBe(true);
    expect(governor.limit()).toBe(2);
    expect(governor.noteSuccess()).toBe(false);
    expect(governor.noteSuccess()).toBe(false);
    expect(governor.noteSuccess()).toBe(true);
    expect(governor.limit()).toBe(3);
    expect(governor.noteSuccess()).toBe(false);
    expect(governor.limit()).toBe(3);
  });

  it('стадия анализа: тайм-аут схлопывает пул, восстановление пишется в лог INFO', async () => {
    const big = Array.from(
      { length: 200 },
      (_, i) => `Строка ${i + 1}: ${'текст '.repeat(10)}`,
    ).join('\n');
    const docsDir = path.join(os.tmpdir(), `po-todo23-${randomBytes(8).toString('hex')}`);
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, 'long.md'), big, 'utf8');
    try {
      let n = 0;
      const { rt, logs } = harness({
        chat: (args) => {
          n += 1;
          if (n === 1) args.onUpstreamRetry?.('timeout');
          return okEmpty(args);
        },
      });
      const out = await runAnalyzeStage(
        rt,
        analyzeInput(docsDir, ['long.md'], {
          chunkChars: 1000,
          preset: { ...PRESET, parallelism: 2 },
          classes: new Map([['long.md', 'other']]),
        }),
      );
      expect(out.ok).toBe(true);
      expect(
        logs.some((l) => l.level === 'warn' && /параллелизм снижен до 1/i.test(l.message)),
      ).toBe(true);
      expect(
        logs.some(
          (l) => l.level === 'info' && /Параллелизм восстановлен до 2 из 2/.test(l.message),
        ),
      ).toBe(true);
    } finally {
      await fs.rm(docsDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('M5 — пульс инвентаризации (приёмка №5)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})),
    );
  });

  const inventoryInput = (docsDir: string, files: string[]) => ({
    docsDir,
    files,
    totalEntries: files.length,
    extensionCounts: { '.md': files.length },
    model: 'gpt-test',
    apiKey: 'sk',
    baseURL: 'http://hub',
    preset: PRESET,
    makeAiClient: () => STUB_CLIENT,
  });

  it('опись 120 файлов: строки «просмотрено файлов A из B» появляются в логе', async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 120; i++) files[`f-${String(i).padStart(3, '0')}.md`] = 'x';
    const docsDir = await makeDocsDir(files);
    dirs.push(docsDir);
    const { rt, logs } = harness();
    const out = await runInventoryStage(rt, inventoryInput(docsDir, Object.keys(files)));
    expect(out.ok).toBe(true);
    expect(logs.some((l) => l.message.includes('просмотрено файлов 50 из 120'))).toBe(true);
    expect(logs.some((l) => l.message.includes('просмотрено файлов 100 из 120'))).toBe(true);
  });

  it('LLM-классификация: строки «батч C из D» появляются в логе', async () => {
    const body = 'Общий текст о продукте и его возможностях. '.repeat(12);
    const files: Record<string, string> = {};
    for (let i = 1; i <= 35; i++) files[`doc-${String(i).padStart(2, '0')}.md`] = body;
    const docsDir = await makeDocsDir(files);
    dirs.push(docsDir);
    const { rt, logs } = harness({ chat: () => ({ kind: 'ok', value: [] }) });
    const out = await runInventoryStage(rt, inventoryInput(docsDir, Object.keys(files)));
    expect(out.ok).toBe(true);
    expect(logs.some((l) => /батч 1 из 2/.test(l.message))).toBe(true);
    expect(logs.some((l) => /батч 2 из 2/.test(l.message))).toBe(true);
  });

  it('смета учитывает батчинг: мелкие файлы одного класса — общие фрагменты', () => {
    const small = Array.from({ length: 10 }, (_, i) => ({
      path: `s-${i}.md`,
      sourceClass: 'release-notes' as AiImportSourceClass,
      size: 500,
    }));
    const est = computeEstimate({ files: small, chunkChars: 10_000, thresholdTokens: null });
    expect(est.chunks).toBe(1);
    expect(est.calls).toBe(1);

    const mixed = computeEstimate({
      files: [...small, { path: 'big.md', sourceClass: 'other', size: 25_000 }],
      chunkChars: 10_000,
      thresholdTokens: null,
    });
    expect(mixed.chunks).toBe(4); // 1 пул мелких release-notes + ceil(25000/10000)
  });
});
