import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { FsAiJobsRepo } from '../src/repositories/AiJobsRepo.js';
import { ConflictError, NotFoundError } from '../src/lib/errors.js';
import type { AiJobCheckpoint } from '../src/services/aiImport/checkpoint.js';
import { createProjectService, createRequirementService } from '../src/factory.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';
import {
  KIT_MODEL,
  KIT_PROJECT,
  KIT_SECRET,
  approveDocsReview,
  makeImportHarness,
  scriptedClient,
  writeZipArchive,
  type ImportHarness,
} from './aiImportKit.js';

/*
 * todo_20 · T-212: resume failed | cancelled | interrupted с чекпоинта —
 * пройденные фрагменты повторно не оплачиваются, populate идемпотентен (D3);
 * роуты: GET /api/projects/:id/ai-import/jobs (история), POST /resume (202),
 * GET /log (text/plain attachment), 404/409 на неверные состояния.
 */

function extraction(names: string[]): string {
  return JSON.stringify(
    names.map((name) => ({
      type: 'FUNCTION',
      name,
      description: `Описание: ${name}.`,
      source: `doc.md § ${name}`,
    })),
  );
}

/** ~N chunks of chunkChars each, heuristically classifiable. */
function bigDoc(chunks: number, chunkChars: number): string {
  const line = 'строка документации о возможности системы\n';
  const perChunk = Math.ceil(chunkChars / line.length) + 1;
  return '# Что нового\n' + line.repeat(perChunk * chunks);
}

describe('T-212 · resume с чекпоинта (сервис)', () => {
  let root: string;
  let h: ImportHarness;
  const archives: string[] = [];

  beforeEach(async () => {
    root = await makeTmpRoot();
    h = await makeImportHarness(root);
    await h.setPreset({ parallelism: 1 }); // детерминированные границы фрагментов
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

  it('BUDGET-01 → повышение лимита → resume доводит до конца; пройденный фрагмент не переоплачивается; дублей нет', async () => {
    await h.setPreset({ parallelism: 1, runBudgetTokens: 100 });
    // Фаза 1: первый фрагмент отвечает с usage 200 > бюджета 100 → BUDGET-01.
    const phase1 = scriptedClient([
      {
        content: extraction(['Вход по паролю']),
        usage: { prompt_tokens: 150, completion_tokens: 50 },
      },
    ]);
    const service1 = h.makeService(phase1, { chunkChars: 400 });
    const archive = await zip({ 'doc.md': bigDoc(3, 400) });
    const { jobId } = await service1.start(KIT_PROJECT, archive);
    await service1.waitForCompletion(jobId);

    const failed = service1.getView(jobId);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('BUDGET-01');
    expect(failed.error?.resumable).toBe(true);
    const state1 = await h.checkpoints.load(KIT_PROJECT, jobId);
    expect(state1?.analyze?.processedChunks).toBeGreaterThanOrEqual(1);
    const paidChunks = state1!.analyze!.processedChunks;
    const totalChunks = state1!.analyze!.totalChunks;
    expect(paidChunks).toBeLessThan(totalChunks);

    // «Увеличьте бюджет и продолжите» (решение PO): лимит перечитывается из пресета.
    await h.setPreset({ parallelism: 1, runBudgetTokens: null });
    const phase2 = scriptedClient([
      extraction(['Просмотр отчётов']),
      extraction(['Экспорт данных']),
      '[]',
    ]);
    const service2 = h.makeService(phase2, { chunkChars: 400 });
    const resumed = await service2.resume(jobId);
    expect(resumed.jobId).toBe(jobId); // тот же jobId — клиент продолжает поллинг
    await service2.waitForCompletion(jobId);
    // Двухзонная выверка: подтверждаем оба гейта (никаких новых AI-вызовов).
    await approveDocsReview(service2, jobId);

    const done = service2.getView(jobId);
    expect(done.status).toBe('succeeded');
    expect(done.log.some((l) => l.message.includes('повторно не оплачиваются'))).toBe(true);
    // Пройденные фрагменты НЕ переоплачены: вызовы фазы 2 = остаток + структура.
    const phase2Calls = (phase2.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(phase2Calls).toBe(totalChunks - paidChunks + 1); // +1 — структурная стадия
    // Дублей нет: «Функция А» из чекпоинта + Б/В из продолжения.
    const { requirements } = await createRequirementService(h.ctx, KIT_PROJECT).list();
    expect(requirements.map((r) => r.name).sort()).toEqual([
      'Вход по паролю',
      'Просмотр отчётов',
      'Экспорт данных',
    ]);
    // Usage фазы 1 сохранился и дополнился фазой 2.
    expect(done.usage!.promptTokens).toBeGreaterThanOrEqual(150);
  });

  it('D3: повторный прогон того же архива идемпотентен — created 0, skippedExisting N', async () => {
    const answers = [extraction(['Функция А', 'Функция Б']), '[]'];
    const service = h.makeService(scriptedClient(answers));
    const first = await service.start(KIT_PROJECT, await zip({ 'doc.md': '# Что нового\nТекст.' }));
    await service.waitForCompletion(first.jobId);
    await approveDocsReview(service, first.jobId);
    expect(service.getView(first.jobId).result?.createdFunctions).toBe(2);

    const again = h.makeService(scriptedClient(answers));
    const second = await again.start(KIT_PROJECT, await zip({ 'doc.md': '# Что нового\nТекст.' }));
    await again.waitForCompletion(second.jobId);
    await approveDocsReview(again, second.jobId);
    const view = again.getView(second.jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result).toMatchObject({ createdFunctions: 0, skippedExisting: 2 });
  });

  it('resume: 409 для succeeded, 404 для неизвестного jobId', async () => {
    const service = h.makeService(scriptedClient([extraction(['Функция А']), '[]']));
    const { jobId } = await service.start(
      KIT_PROJECT,
      await zip({ 'doc.md': '# Что нового\nТекст.' }),
    );
    await service.waitForCompletion(jobId);
    await approveDocsReview(service, jobId);
    expect(service.getView(jobId).status).toBe('succeeded');
    await expect(service.resume(jobId)).rejects.toThrow(ConflictError);
    await expect(service.resume('ghost')).rejects.toThrow(NotFoundError);
  });

  it('interrupted (после kill) → resume доводит до конца', async () => {
    await h.setPreset({ parallelism: 1, runBudgetTokens: 100 });
    const service1 = h.makeService(
      scriptedClient([
        { content: extraction(['Функция А']), usage: { prompt_tokens: 200, completion_tokens: 0 } },
      ]),
      { chunkChars: 400 },
    );
    const archive = await zip({ 'doc.md': bigDoc(2, 400) });
    const { jobId } = await service1.start(KIT_PROJECT, archive);
    await service1.waitForCompletion(jobId);
    // Симуляция kill -9: state.json как будто остался в running.
    const state = (await h.checkpoints.load(KIT_PROJECT, jobId))!;
    state.status = 'running';
    delete state.finishedAt;
    await h.checkpoints.save(state);

    // «Рестарт сервера»: новый реестр джоб + новый сервис поверх того же root.
    await h.setPreset({ parallelism: 1, runBudgetTokens: null });
    const restarted = await makeImportHarness(root);
    const fresh = restarted.makeService(scriptedClient([extraction(['Функция Б']), '[]']), {
      chunkChars: 400,
    });
    await fresh.recoverInterrupted();
    expect(fresh.getView(jobId).status).toBe('interrupted');

    await fresh.resume(jobId);
    await fresh.waitForCompletion(jobId);
    await approveDocsReview(fresh, jobId);
    expect(fresh.getView(jobId).status).toBe('succeeded');
    const { requirements } = await createRequirementService(h.ctx, KIT_PROJECT).list();
    const names = requirements.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length); // дублей нет
    expect(names.sort()).toEqual(['Функция А', 'Функция Б']);
  });
});

describe('T-212 · роуты resume/история/лог (integration, mock client)', () => {
  let root: string;
  let app: FastifyInstance;

  const EXTRACTION = extraction(['Функция из чекпоинта']);

  function checkpoint(over: Partial<AiJobCheckpoint> = {}): AiJobCheckpoint {
    return {
      version: 1,
      jobId: 'resume0001',
      projectId: KIT_PROJECT,
      model: KIT_MODEL,
      inferLinks: false,
      startedAt: '2026-06-29T09:00:00.000Z',
      status: 'failed',
      stage: 'analyze',
      progress: 30,
      confirmed: true,
      log: [{ ts: fixedNow(), level: 'error', message: '[BUDGET-01] Бюджет исчерпан.' }],
      counters: {
        createdFunctions: 0,
        createdNfrs: 0,
        skippedExisting: 0,
        links: 0,
        relatesLinks: 0,
      },
      error: {
        message: 'Бюджет прогона исчерпан — анализ мягко остановлен, результат сохранён.',
        hint: 'Увеличьте бюджет.',
        code: 'BUDGET-01',
        category: 'budget',
        action: 'Увеличьте бюджет и продолжите.',
        resumable: true,
      },
      analyze: {
        files: [{ path: 'doc.md', sourceClass: 'release-notes', size: 40 }],
        fileIndex: 0,
        charOffset: 0,
        processedChunks: 0,
        totalChunks: 1,
        extracted: [],
      },
      ...over,
    };
  }

  beforeEach(async () => {
    root = await makeTmpRoot();
    const ctx = { projectsRoot: root, now: fixedNow };
    await createProjectService(ctx).create(KIT_PROJECT);
    await new AiConfigRepo(root).update({
      apiKey: KIT_SECRET,
      projectId: KIT_PROJECT,
      model: KIT_MODEL,
    });
    // Готовый чекпоинт «упавшей» джобы + её docs на диске.
    const repo = new FsAiJobsRepo(root);
    await repo.save(checkpoint());
    const docs = repo.docsDir(KIT_PROJECT, 'resume0001');
    await fs.mkdir(docs, { recursive: true });
    await fs.writeFile(path.join(docs, 'doc.md'), '# Что нового\nВозможность.', 'utf8');

    app = await buildApp({
      projectsRoot: root,
      now: fixedNow,
      makeAiClient: () => scriptedClient([EXTRACTION, '[]']),
    });
  });
  afterEach(async () => {
    await app.close();
    await cleanup(root);
  });

  it('история: GET /api/projects/:id/ai-import/jobs; 404 для неизвестного проекта', async () => {
    const res = await app.inject({ url: `/api/projects/${KIT_PROJECT}/ai-import/jobs` });
    expect(res.statusCode).toBe(200);
    const { jobs } = res.json() as { jobs: Array<Record<string, unknown>> };
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      jobId: 'resume0001',
      status: 'failed',
      resumable: true,
      startedAt: '2026-06-29T09:00:00.000Z',
    });

    const missing = await app.inject({ url: '/api/projects/NoSuch/ai-import/jobs' });
    expect(missing.statusCode).toBe(404);
  });

  it('GET /:jobId отдаёт вид из чекпоинта (история переживает рестарт), GET /log — text/plain attachment', async () => {
    const view = await app.inject({ url: '/api/ai-import/resume0001' });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ jobId: 'resume0001', status: 'failed' });

    const log = await app.inject({ url: '/api/ai-import/resume0001/log' });
    expect(log.statusCode).toBe(200);
    expect(log.headers['content-type']).toContain('text/plain');
    expect(log.headers['content-disposition']).toContain('attachment');
    expect(log.headers['content-disposition']).toContain('resume0001');
    expect(log.body).toContain('[BUDGET-01]');

    const missing = await app.inject({ url: '/api/ai-import/ghost/log' });
    expect(missing.statusCode).toBe(404);
  });

  it('POST /resume: 202 тем же jobId → джоба доходит до succeeded; создано требование', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ai-import/resume0001/resume' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ jobId: 'resume0001' });

    type View = {
      status: string;
      docsReview?: { phase: string; items: Array<{ id: string }> };
    };
    const poll = async (until: (v: View) => boolean): Promise<View> => {
      const started = Date.now();
      for (;;) {
        const r = await app.inject({ url: '/api/ai-import/resume0001' });
        const view = r.json() as View;
        if (until(view)) return view;
        if (Date.now() - started > 5000) throw new Error(`stuck in status "${view.status}"`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    // Двухзонная выверка: анализ ставит джобу на паузу — подтверждаем обе зоны
    // по REST (тот же /apply, что у backlog), затем populate доводит до конца.
    const zone1 = await poll((v) => v.status === 'awaiting-review');
    expect(zone1.docsReview?.phase).toBe('self');
    const applied1 = await app.inject({
      method: 'POST',
      url: '/api/ai-import/resume0001/apply',
      payload: { phase: 'self', ids: zone1.docsReview!.items.map((i) => i.id) },
    });
    expect(applied1.statusCode).toBe(200);
    const zone2 = applied1.json() as View;
    expect(zone2.status).toBe('awaiting-review');
    expect(zone2.docsReview?.phase).toBe('existing');
    const applied2 = await app.inject({
      method: 'POST',
      url: '/api/ai-import/resume0001/apply',
      payload: { phase: 'existing', ids: zone2.docsReview!.items.map((i) => i.id) },
    });
    expect(applied2.statusCode).toBe(200);
    await poll((v) => v.status === 'succeeded');
    const reqs = await app.inject({ url: `/api/projects/${KIT_PROJECT}/requirements` });
    const names = (reqs.json() as { requirements: Array<{ name: string }> }).requirements.map(
      (r) => r.name,
    );
    expect(names).toContain('Функция из чекпоинта');

    // Повторный resume уже завершённой джобы — 409.
    const again = await app.inject({ method: 'POST', url: '/api/ai-import/resume0001/resume' });
    expect(again.statusCode).toBe(409);
  });

  it('POST /confirm на не-ожидающей джобе → 409, на неизвестной → 404', async () => {
    const conflict = await app.inject({ method: 'POST', url: '/api/ai-import/resume0001/confirm' });
    expect(conflict.statusCode).toBe(409);
    const missing = await app.inject({ method: 'POST', url: '/api/ai-import/ghost/confirm' });
    expect(missing.statusCode).toBe(404);
  });
});
