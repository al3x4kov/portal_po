import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_IMPORT_ERROR_CODES, type AiImportErrorCode } from '@po/core';
import { ReportBuilder } from '../src/services/aiImport/report.js';
import { cleanup, makeTmpRoot } from './helpers.js';
import {
  KIT_PROJECT,
  makeImportHarness,
  scriptedClient,
  writeZipArchive,
  type ImportHarness,
} from './aiImportKit.js';

/*
 * todo_20 · T-213: все fail-пути несут код реестра (code/category/action/
 * resumable — приёмка №5); финальный отчёт (coverage + blindSpots) собирается
 * по ходу и присутствует и при failed/cancelled (частичный); прогресс с
 * содержанием: currentFile/currentClass/chunkIndex/chunkTotal/etaSeconds.
 */

const EXTRACTION = JSON.stringify([
  {
    type: 'FUNCTION',
    name: 'Аутентификация',
    description: 'Пользователь входит в систему.',
    source: 'auth.md § Вход',
  },
]);

describe('T-213 · ReportBuilder (unit)', () => {
  it('fromInventory → coverage/blindSpots; счётчики; round-trip через fromView', () => {
    const builder = ReportBuilder.fromInventory({
      totalFiles: 5,
      processed: { 'release-notes': 2, other: 1 },
      excluded: [{ path: '*.png', reason: 'не текстовый формат документации', count: 2 }],
    });
    builder.noteFileProcessed('release-notes');
    builder.noteExtracted('release-notes', 3, 1);
    builder.noteRetriedChunks('release-notes', 2);
    builder.noteSkippedChunk();
    builder.noteTruncated();

    const view = builder.view();
    expect(view.coverage).toEqual([
      {
        sourceClass: 'release-notes',
        files: 2,
        processedFiles: 1,
        extractedFunctions: 3,
        extractedNfrs: 1,
        retriedChunks: 2,
      },
      {
        sourceClass: 'other',
        files: 1,
        processedFiles: 0,
        extractedFunctions: 0,
        extractedNfrs: 0,
        retriedChunks: 0,
      },
    ]);
    expect(view.blindSpots).toEqual([
      { kind: 'excluded', message: '*.png — не текстовый формат документации', count: 2 },
      { kind: 'skipped-file', message: expect.stringContaining('Фрагменты пропущены'), count: 1 },
      { kind: 'truncated', message: expect.stringContaining('обрезаны'), count: 1 },
    ]);
    // T-212: восстановление отчёта из view (resume) без потерь.
    expect(ReportBuilder.fromView(view).view()).toEqual(view);
  });
});

describe('T-213 · таксономия на всех fail-путях + отчёт при fail/cancel', () => {
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

  async function zip(files: Record<string, string>): Promise<string> {
    const file = await writeZipArchive(files);
    archives.push(file);
    return file;
  }

  /** Приёмка №5: любой fail несёт код/категорию/действие/resumable + счётчики. */
  function expectCodedFailure(view: {
    status: string;
    error?: { code?: string; category?: string; action?: string; resumable?: boolean };
    result?: unknown;
  }): asserts view is never {
    expect(view.status).toBe('failed');
    const code = view.error?.code as AiImportErrorCode;
    expect(AI_IMPORT_ERROR_CODES[code]).toBeDefined();
    expect(view.error?.category).toBe(AI_IMPORT_ERROR_CODES[code].category);
    expect(view.error?.action).toBeTruthy();
    expect(typeof view.error?.resumable).toBe('boolean');
    expect(view.result).toBeDefined(); // «что уже создано» видно на экране ошибки
  }

  it('битый архив → DATA-03; архив без документации → DATA-01', async () => {
    const service = h.makeService(scriptedClient([]));
    const broken = path.join(os.tmpdir(), `po-broken-${randomBytes(6).toString('hex')}.zip`);
    await fs.writeFile(broken, Buffer.from('это не архив'));
    archives.push(broken);
    const first = await service.start(KIT_PROJECT, broken);
    await service.waitForCompletion(first.jobId);
    const view1 = service.getView(first.jobId);
    expectCodedFailure(view1 as never);
    expect(view1.error?.code).toBe('DATA-03');

    const second = await service.start(KIT_PROJECT, await zip({ 'logo.png': 'PNGDATA' }));
    await service.waitForCompletion(second.jobId);
    const view2 = service.getView(second.jobId);
    expectCodedFailure(view2 as never);
    expect(view2.error?.code).toBe('DATA-01');
  });

  it('подвисший вызов → тайм-аут → ретраи → NET-03 (никогда не «голый Timeout»)', async () => {
    const hanging = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: (_p: unknown, options?: { signal?: AbortSignal }) =>
            new Promise((_res, reject) => {
              options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        },
      },
    };
    const service = h.makeService(hanging as never, { callTimeoutMs: 25 });
    const { jobId } = await service.start(
      KIT_PROJECT,
      await zip({ 'auth.md': '# Что нового\nВход.' }),
    );
    await service.waitForCompletion(jobId);
    const view = service.getView(jobId);
    expectCodedFailure(view as never);
    expect(view.error?.code).toBe('NET-03');
    // Диагностика тайм-аута в логе по-русски: сколько ждали.
    expect(view.log.some((l) => l.message.includes('тайм-аут вызова'))).toBe(true);
  });

  it('сплошной мусор в ответах → MODEL-01; отчёт присутствует при failed (частичный)', async () => {
    const service = h.makeService(scriptedClient(['мусор — не JSON']));
    const { jobId } = await service.start(
      KIT_PROJECT,
      await zip({ 'auth.md': '# Что нового\nВход.', 'logo.png': 'PNGDATA' }),
    );
    await service.waitForCompletion(jobId);
    const view = service.getView(jobId);
    expectCodedFailure(view as never);
    expect(view.error?.code).toBe('MODEL-01');
    // Частичный отчёт: исключённый файл виден как слепая зона уже сейчас.
    expect(view.report).toBeDefined();
    expect(view.report?.blindSpots.some((b) => b.kind === 'excluded')).toBe(true);
  });

  it('cancel в середине анализа: отчёт и счётчики присутствуют', async () => {
    let jobId = '';
    const client = scriptedClient([
      () => {
        service.cancel(jobId);
        return EXTRACTION;
      },
      '[]',
    ]);
    const service = h.makeService(client, { chunkChars: 60 });
    const start = await service.start(
      KIT_PROJECT,
      await zip({ 'auth.md': '# Что нового\n' + 'строка о возможности системы\n'.repeat(20) }),
    );
    jobId = start.jobId;
    await service.waitForCompletion(jobId);
    const view = service.getView(jobId);
    expect(view.status).toBe('cancelled');
    expect(view.result).toBeDefined();
    expect(view.report).toBeDefined();
  });

  it('успех: отчёт с покрытием по классам; прогресс с содержанием заполнен; ETA обнулён', async () => {
    const service = h.makeService(scriptedClient([EXTRACTION, '[]']));
    const { jobId } = await service.start(
      KIT_PROJECT,
      await zip({ 'auth.md': '# Что нового\nВход по паролю.', 'logo.png': 'PNGDATA' }),
    );
    await service.waitForCompletion(jobId);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');

    const row = view.report?.coverage.find((c) => c.sourceClass === 'release-notes');
    expect(row).toMatchObject({ files: 1, processedFiles: 1, extractedFunctions: 1 });
    expect(view.report?.blindSpots.some((b) => b.kind === 'excluded')).toBe(true);
    // E3: прогресс с содержанием — последние значения остаются в view.
    expect(view.currentFile).toBe('auth.md');
    expect(view.currentClass).toBe('release-notes');
    expect(view.chunkIndex).toBe(1);
    expect(view.chunkTotal).toBe(1);
    expect(view.etaSeconds).toBe(0); // завершено
  });
});
