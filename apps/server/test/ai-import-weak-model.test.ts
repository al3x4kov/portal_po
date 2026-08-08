import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiClient } from '../src/services/AiHubService.js';
import {
  compareWithEtalon,
  parseEtalonList,
  projectRequirementNames,
} from '../src/tools/compareEtalon.js';
import { cleanup, makeTmpRoot } from './helpers.js';
import {
  KIT_PROJECT,
  approveDocsReview,
  httpError,
  makeImportHarness,
  makeWeakModelClient,
  syntheticArchive,
  writeZipArchive,
  type ImportHarness,
} from './aiImportKit.js';

/*
 * todo_20 · T-216: интеграционные приёмки на «слабой модели».
 * №2 — «500 вызовов, 5% сбоят (429/500/тайм-аут/рваный JSON)» завершается сам;
 * №3 — kill → interrupted → resume → до конца, без дублей и повторной оплаты;
 * №6b — вариант F2b (другая раскладка/кириллические пути/другая разметка) даёт
 * полноту в пределах 5% от F2; команда сравнения с эталоном.
 */

describe('T-216 · сравнение с эталоном (unit)', () => {
  it('parseEtalonList: JSON-массив строк/объектов и построчный текст', () => {
    expect(parseEtalonList('["Функция А", {"name":"Функция Б"}, {"x":1}]')).toEqual([
      'Функция А',
      'Функция Б',
    ]);
    expect(parseEtalonList('# комментарий\nФункция А\n\n  Функция Б  \n')).toEqual([
      'Функция А',
      'Функция Б',
    ]);
  });

  it('compareWithEtalon: полнота/точность по нормализованным именам, списки расхождений', () => {
    const report = compareWithEtalon(
      ['«Вход по паролю»', 'ЭКСПОРТ ОТЧЁТА!', 'Лишняя функция'],
      ['Вход по паролю', 'Экспорт отчета', 'Ненайденная функция', 'Ненайденная функция'],
    );
    expect(report.etalonTotal).toBe(3); // дубль эталона схлопнут
    expect(report.extractedTotal).toBe(3);
    expect(report.matched).toBe(2); // нормализация: кавычки/регистр/ё
    expect(report.completeness).toBeCloseTo(2 / 3);
    expect(report.precision).toBeCloseTo(2 / 3);
    expect(report.missing).toEqual(['Ненайденная функция']);
    expect(report.extra).toEqual(['Лишняя функция']);
  });
});

describe('T-216 · приёмки на слабой модели (интеграция)', () => {
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

  it('приёмка №2: ~500 вызовов, 5% сбоят — прогон завершается сам, без действий пользователя', async () => {
    // ≥200 файлов (критерий генератора) × ~2 фрагмента ≈ 450+ вызовов извлечения.
    const { files } = syntheticArchive({ files: 200, recordsPerFile: 0, fillerLines: 14 });
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(200);
    const weak = makeWeakModelClient({ failureRate: 0.05, seed: 7 });
    const service = h.makeService(weak.client, { chunkChars: 300, callTimeoutMs: 25 });
    const { jobId } = await service.start(KIT_PROJECT, await zip(files));
    await service.waitForCompletion(jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded'); // сам, без участия пользователя
    expect(weak.stats.calls).toBeGreaterThanOrEqual(450);
    expect(weak.stats.failures).toBeGreaterThanOrEqual(15); // сбои реально были
    // Деградации видны в логе по-русски (ретраи), а не «голый Timeout».
    expect(view.log.some((l) => l.message.includes('Повтор запроса к модели'))).toBe(true);
  }, 30000);

  it('приёмка №3: kill → interrupted → resume → до конца; без дублей и повторной оплаты', async () => {
    await h.setPreset({ parallelism: 1 });
    const archive = syntheticArchive({ files: 6, recordsPerFile: 2, fillerLines: 10 });
    const zipFile = await zip(archive.files);

    // Фаза 1: модель здорова первые 7 вызовов извлечения, затем вечный 429.
    const weak1 = makeWeakModelClient({ failureRate: 0 });
    let extractionCalls = 0;
    const failing: AiClient = {
      models: weak1.client.models,
      chat: {
        completions: {
          create: ((
            params: { messages: Array<{ role: string; content: string }> },
            options?: unknown,
          ) => {
            const text = params.messages.map((m) => m.content).join('\n');
            const isExtraction =
              !text.includes('"parentName":string|null') && !text.includes('дедуплицируешь');
            if (isExtraction && ++extractionCalls > 7) {
              return Promise.reject(httpError(429, 'always throttled'));
            }
            return (
              weak1.client.chat.completions.create as (p: unknown, o?: unknown) => Promise<unknown>
            )(params, options);
          }) as never,
        },
      },
    };
    const service1 = h.makeService(failing, { chunkChars: 300 });
    const { jobId } = await service1.start(KIT_PROJECT, zipFile);
    await service1.waitForCompletion(jobId);
    expect(service1.getView(jobId).error?.code).toBe('NET-01');

    // «kill -9»: контрольная точка осталась в running (как при обрыве процесса).
    const state = (await h.checkpoints.load(KIT_PROJECT, jobId))!;
    const paidChunks = state.analyze!.processedChunks;
    const totalChunks = state.analyze!.totalChunks;
    expect(paidChunks).toBeGreaterThan(0);
    expect(paidChunks).toBeLessThan(totalChunks);
    state.status = 'running';
    delete state.finishedAt;
    await h.checkpoints.save(state);

    // «Рестарт»: новый реестр джоб; скан помечает джобу как interrupted.
    const restarted = await makeImportHarness(root);
    const weak2 = makeWeakModelClient({ failureRate: 0 });
    const service2 = restarted.makeService(weak2.client, { chunkChars: 300 });
    await service2.recoverInterrupted();
    expect(service2.getView(jobId).status).toBe('interrupted');

    await service2.resume(jobId);
    await service2.waitForCompletion(jobId);
    // Двухзонная выверка: подтверждаем оба гейта — никаких вызовов извлечения.
    await approveDocsReview(service2, jobId);
    expect(service2.getView(jobId).status).toBe('succeeded');

    // Пройденные фрагменты не переоплачены.
    expect(weak2.stats.extractionCalls).toBe(totalChunks - paidChunks);
    // Дублей нет; полнота против эталона — 100%.
    const names = await projectRequirementNames(root, KIT_PROJECT);
    expect(new Set(names).size).toBe(names.length);
    const report = compareWithEtalon(names, archive.etalon);
    expect(report.completeness).toBe(1);
    expect(report.missing).toEqual([]);
  }, 30000);

  it('приёмка №6b: вариант F2b (другая раскладка, кириллические пути, другая разметка) — полнота в пределах 5% от F2', async () => {
    const runVariant = async (variant: 'F2' | 'F2b', project: string): Promise<number> => {
      const harness = await makeImportHarness(root, project);
      const archive = syntheticArchive({ files: 10, recordsPerFile: 3, fillerLines: 4, variant });
      const weak = makeWeakModelClient({ failureRate: 0 });
      const service = harness.makeService(weak.client, { chunkChars: 2000 });
      const { jobId } = await service.start(project, await zip(archive.files));
      await service.waitForCompletion(jobId);
      await approveDocsReview(service, jobId);
      expect(service.getView(jobId).status).toBe('succeeded');
      const names = await projectRequirementNames(root, project);
      return compareWithEtalon(names, archive.etalon).completeness;
    };

    const f2 = await runVariant('F2', 'Variant-F2');
    const f2b = await runVariant('F2b', 'Variant-F2b');
    expect(f2).toBeGreaterThan(0.9);
    expect(Math.abs(f2 - f2b)).toBeLessThanOrEqual(0.05);
  }, 30000);
});
