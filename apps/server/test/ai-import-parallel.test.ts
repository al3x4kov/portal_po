import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiClient } from '../src/services/AiHubService.js';
import {
  AI_PARALLELISM_RECOVERY_SUCCESSES,
  ParallelismGovernor,
} from '../src/services/aiImport/parallel.js';
import { EtaTracker } from '../src/services/aiImport/eta.js';
import { cleanup, makeTmpRoot } from './helpers.js';
import {
  KIT_PROJECT,
  approveDocsReview,
  httpError,
  makeImportHarness,
  writeZipArchive,
  type ImportHarness,
} from './aiImportKit.js';

/*
 * todo_20 · T-210: пул K=preset.parallelism параллельных вызовов; первый 429
 * снижает K до 1 с постепенным восстановлением; merge детерминирован (не
 * зависит от порядка завершения); usage корректен при параллелизме.
 * Плюс юниты ETA (T-213, решение PO №6).
 */

describe('T-210 · ParallelismGovernor (unit)', () => {
  it('старт с preset K; 429 → 1 (однократный сигнал); восстановление по серии успехов', () => {
    const g = new ParallelismGovernor(3);
    expect(g.limit()).toBe(3);
    expect(g.noteRateLimited()).toBe(true); // упал до 1 — сигнал для warn-лога
    expect(g.limit()).toBe(1);
    expect(g.noteRateLimited()).toBe(false); // уже на минимуме — без нового warn
    for (let i = 0; i < AI_PARALLELISM_RECOVERY_SUCCESSES; i++) g.noteSuccess();
    expect(g.limit()).toBe(2);
    for (let i = 0; i < AI_PARALLELISM_RECOVERY_SUCCESSES; i++) g.noteSuccess();
    expect(g.limit()).toBe(3);
    g.noteSuccess(); // выше пресета не растёт
    expect(g.limit()).toBe(3);
  });

  it('K=1 в пресете — всегда 1', () => {
    const g = new ParallelismGovernor(1);
    expect(g.limit()).toBe(1);
    g.noteSuccess();
    expect(g.limit()).toBe(1);
  });
});

describe('T-213 · EtaTracker (unit, решение PO №6)', () => {
  it('null до первого успешного фрагмента, затем экстраполяция, догрузка работ учитывается', () => {
    const eta = new EtaTracker(10);
    expect(eta.etaSeconds(1000)).toBeNull(); // «оценивается…»
    eta.start(0);
    expect(eta.etaSeconds(1000)).toBeNull(); // ещё ничего не завершено
    eta.noteDone(); // 1 фрагмент за 1с → осталось 9 → ~9с
    expect(eta.etaSeconds(1000)).toBe(9);
    eta.addChunks(5); // делениe/повторный проход добавили работы
    expect(eta.etaSeconds(1000)).toBe(14);
    for (let i = 0; i < 14; i++) eta.noteDone();
    expect(eta.etaSeconds(2000)).toBe(0); // всё завершено
  });
});

describe('T-210 · интеграция пула (сервис + мок-клиент)', () => {
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

  /** Doc with N heuristically-classifiable chunks of ~size chars. */
  function bigDoc(chunks: number, chunkChars: number): string {
    const line = 'строка текста документации о возможностях системы\n';
    const perChunk = Math.ceil(chunkChars / line.length) + 1;
    return '# Что нового\n' + line.repeat(perChunk * chunks);
  }

  it('в полёте не больше K=preset.parallelism вызовов; usage суммируется корректно', async () => {
    await h.setPreset({ parallelism: 3 });
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const client: AiClient = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: vi.fn(async (params: { messages: Array<{ content: string }> }) => {
            const isStructure = params.messages.some((m) =>
              m.content.includes('"parentName":string|null'),
            );
            if (!isStructure) {
              calls += 1;
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              await new Promise((r) => setTimeout(r, 10));
              inFlight -= 1;
            }
            return {
              choices: [{ message: { content: '[]' } }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            };
          }) as never,
        },
      },
    };
    const service = h.makeService(client, { chunkChars: 300 });
    const archive = await writeZipArchive({ 'doc.md': bigDoc(6, 300) });
    archives.push(archive);
    const { jobId } = await service.start(KIT_PROJECT, archive);
    await service.waitForCompletion(jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(maxInFlight).toBe(3);
    // C4: usage считается при параллельных вызовах — ровно по числу ответов.
    const totalCalls = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(view.usage).toEqual({
      promptTokens: totalCalls * 10,
      completionTokens: totalCalls * 5,
    });
  });

  it('merge детерминирован: фрагменты коммитятся по порядку, даже если завершились наоборот', async () => {
    await h.setPreset({ parallelism: 3 });
    const delays = [40, 20, 1]; // первый фрагмент завершается ПОСЛЕДНИМ
    let extractionCall = 0;
    const client: AiClient = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: vi.fn(async (params: { messages: Array<{ content: string }> }) => {
            const isStructure = params.messages.some((m) =>
              m.content.includes('"parentName":string|null'),
            );
            if (isStructure) return { choices: [{ message: { content: '[]' } }] };
            const index = extractionCall++;
            await new Promise((r) => setTimeout(r, delays[index] ?? 1));
            const content = JSON.stringify([
              {
                type: 'FUNCTION',
                name: `Функция очереди ${index + 1}`,
                description: `Ответ фрагмента ${index + 1}.`,
                source: `doc.md § ${index + 1}`,
              },
            ]);
            return { choices: [{ message: { content } }] };
          }) as never,
        },
      },
    };
    const service = h.makeService(client, { chunkChars: 300 });
    const archive = await writeZipArchive({ 'doc.md': bigDoc(3, 300) });
    archives.push(archive);
    const { jobId } = await service.start(KIT_PROJECT, archive);
    await service.waitForCompletion(jobId);
    // Двухзонная выверка: подтверждаем оба гейта, populate дописывает в проект.
    await approveDocsReview(service, jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    // Коммиты строго по порядку фрагментов — независимо от порядка завершения.
    const commits = view.log
      .filter((l) => l.message.includes('извлечено 1 ФТ'))
      .map((l) => /фрагмент (\d+)\//.exec(l.message)?.[1]);
    expect(commits.slice(0, 3)).toEqual(['1', '2', '3']);
    // ETA появился после первых успешных фрагментов (не null к концу прогона).
    expect(view.etaSeconds).not.toBeUndefined();
  });

  it('первый 429 снижает параллелизм до 1 (warn в логе), прогон завершается сам', async () => {
    await h.setPreset({ parallelism: 3 });
    let extractionCall = 0;
    const client: AiClient = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: vi.fn(async (params: { messages: Array<{ content: string }> }) => {
            const isStructure = params.messages.some((m) =>
              m.content.includes('"parentName":string|null'),
            );
            if (!isStructure && extractionCall++ === 0) {
              throw httpError(429, 'slow down');
            }
            return { choices: [{ message: { content: '[]' } }] };
          }) as never,
        },
      },
    };
    const service = h.makeService(client, { chunkChars: 300 });
    const archive = await writeZipArchive({ 'doc.md': bigDoc(5, 300) });
    archives.push(archive);
    const { jobId } = await service.start(KIT_PROJECT, archive);
    await service.waitForCompletion(jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(
      view.log.some((l) => l.level === 'warn' && l.message.includes('параллелизм снижен до 1')),
    ).toBe(true);
  });
});
