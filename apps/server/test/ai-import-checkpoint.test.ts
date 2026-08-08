import { promises as fs } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsAiJobsRepo } from '../src/repositories/AiJobsRepo.js';
import { ArchiveRepo } from '../src/repositories/ArchiveRepo.js';
import { PathSafetyError } from '../src/lib/errors.js';
import type { AiJobCheckpoint } from '../src/services/aiImport/checkpoint.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';
import {
  KIT_PROJECT,
  approveDocsReview,
  httpError,
  makeImportHarness,
  scriptedClient,
  writeZipArchive,
  type ImportHarness,
} from './aiImportKit.js';

/*
 * todo_20 · T-211: чекпоинты в Projects/<project>/.ai-jobs/<jobId>/state.json
 * (atomicWrite, pathSafe/NFR-5); `.ai-jobs` исключён из экспорта и
 * игнорируется при импорте; при старте сервера незавершённые джобы
 * поднимаются в статус `interrupted`.
 */

const EXTRACTION = JSON.stringify([
  {
    type: 'FUNCTION',
    name: 'Аутентификация',
    description: 'Пользователь входит в систему.',
    source: 'auth.md § Вход',
  },
]);
const STRUCTURE = '[]';

function baseState(over: Partial<AiJobCheckpoint> = {}): AiJobCheckpoint {
  return {
    version: 1,
    jobId: 'job0001',
    projectId: KIT_PROJECT,
    model: 'Qwen-Coder-Next',
    inferLinks: false,
    startedAt: fixedNow(),
    status: 'running',
    stage: 'analyze',
    progress: 42,
    confirmed: true,
    log: [{ ts: fixedNow(), level: 'info', message: 'Запись лога.' }],
    counters: {
      createdFunctions: 2,
      createdNfrs: 1,
      skippedExisting: 0,
      links: 1,
      relatesLinks: 0,
    },
    ...over,
  };
}

describe('T-211 · FsAiJobsRepo (unit)', () => {
  let root: string;
  let repo: FsAiJobsRepo;

  beforeEach(async () => {
    root = await makeTmpRoot();
    repo = new FsAiJobsRepo(root);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('save/load round-trip; невалидный state.json → undefined (не бросает)', async () => {
    const state = baseState();
    await repo.save(state);
    expect(await repo.load(KIT_PROJECT, 'job0001')).toEqual(state);

    await fs
      .writeFile(path.join(root, KIT_PROJECT, '.ai-jobs', 'broken', 'state.json'), '{not json')
      .catch(async () => {
        await fs.mkdir(path.join(root, KIT_PROJECT, '.ai-jobs', 'broken'), { recursive: true });
        await fs.writeFile(path.join(root, KIT_PROJECT, '.ai-jobs', 'broken', 'state.json'), '{no');
      });
    expect(await repo.load(KIT_PROJECT, 'broken')).toBeUndefined();
    expect(await repo.load(KIT_PROJECT, 'missing')).toBeUndefined();
  });

  it('NFR-5: traversal в projectId/jobId отвергается pathSafe', () => {
    expect(() => repo.jobDir(KIT_PROJECT, '../../evil')).toThrow(PathSafetyError);
    expect(() => repo.jobDir('..', 'job')).toThrow(PathSafetyError);
  });

  it('list: новые первыми; findByJobId сканирует проекты', async () => {
    await repo.save(baseState({ jobId: 'older', startedAt: '2026-06-01T10:00:00.000Z' }));
    await repo.save(baseState({ jobId: 'newer', startedAt: '2026-07-01T10:00:00.000Z' }));
    const list = await repo.list(KIT_PROJECT);
    expect(list.map((s) => s.jobId)).toEqual(['newer', 'older']);
    expect((await repo.findByJobId('older'))?.projectId).toBe(KIT_PROJECT);
    expect(await repo.findByJobId('ghost')).toBeUndefined();
  });

  it('markInterrupted: running/awaiting → interrupted + warn-строка в логе; завершённые не трогает', async () => {
    await repo.save(baseState({ jobId: 'run1', status: 'running' }));
    await repo.save(baseState({ jobId: 'wait1', status: 'awaiting-confirmation' }));
    await repo.save(baseState({ jobId: 'done1', status: 'succeeded' }));
    const marked = await repo.markInterrupted(fixedNow);
    expect(marked.map((s) => s.jobId).sort()).toEqual(['run1', 'wait1']);
    const run1 = await repo.load(KIT_PROJECT, 'run1');
    expect(run1?.status).toBe('interrupted');
    expect(run1?.finishedAt).toBe(fixedNow());
    expect(run1?.log.some((l) => l.message.includes('прерван перезапуском'))).toBe(true);
    expect((await repo.load(KIT_PROJECT, 'done1'))?.status).toBe('succeeded');
  });
});

describe('T-211 · интеграция с сервисом + экспорт/импорт', () => {
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

  it('успешный прогон: state.json со статусом succeeded остаётся (история), docs удалены', async () => {
    const service = h.makeService(scriptedClient([EXTRACTION, STRUCTURE]));
    const { jobId } = await service.start(
      KIT_PROJECT,
      await zip({ 'auth.md': '# Что нового\nВход.' }),
    );
    await service.waitForCompletion(jobId);
    // Двухзонная выверка: подтверждаем оба гейта — только после этого populate
    // пишет в проект и джоба завершается.
    await approveDocsReview(service, jobId);
    expect(service.getView(jobId).status).toBe('succeeded');

    const state = await h.checkpoints.load(KIT_PROJECT, jobId);
    expect(state?.status).toBe('succeeded');
    expect(state?.result?.createdFunctions).toBe(1);
    expect(state?.finishedAt).toBeDefined();
    expect(await h.checkpoints.hasDocs(KIT_PROJECT, jobId)).toBe(false); // резюмировать нечего
  });

  it('резюмируемый fail (NET-01): чекпоинт хранит ошибку/лог/срез analyze, docs сохранены', async () => {
    const service = h.makeService(scriptedClient([httpError(429, 'rate limited')]));
    const { jobId } = await service.start(
      KIT_PROJECT,
      await zip({ 'auth.md': '# Что нового\nВход.' }),
    );
    await service.waitForCompletion(jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.error?.code).toBe('NET-01');
    const state = await h.checkpoints.load(KIT_PROJECT, jobId);
    expect(state?.status).toBe('failed');
    expect(state?.error?.code).toBe('NET-01');
    expect(state?.analyze?.files.map((f) => f.path)).toEqual(['auth.md']);
    expect(state?.log.length).toBeGreaterThan(0);
    expect(await h.checkpoints.hasDocs(KIT_PROJECT, jobId)).toBe(true); // можно продолжить
  });

  it('kill → рестарт: recoverInterrupted поднимает джобу как interrupted со счётчиками', async () => {
    // «Kill -9»: state.json остался в статусе running.
    await h.checkpoints.save(baseState({ jobId: 'killed01' }));
    const service = h.makeService(scriptedClient([]));
    await service.recoverInterrupted();

    const view = service.getView('killed01');
    expect(view.status).toBe('interrupted');
    expect(view.result?.createdFunctions).toBe(2); // счётчики пережили рестарт
    expect(view.log.some((l) => l.message.includes('прерван перезапуском'))).toBe(true);
    const jobs = await service.listJobs(KIT_PROJECT);
    const entry = jobs.jobs.find((j) => j.jobId === 'killed01');
    expect(entry?.status).toBe('interrupted');
    expect(entry?.resumable).toBe(true);
  });

  it('экспорт проекта (zip и tar.gz) не содержит .ai-jobs; импорт архива с .ai-jobs игнорирует его', async () => {
    // Наполняем проект чекпоинтом + валидной структурой openspec (см. validate()).
    const { createRequirementService } = await import('../src/factory.js');
    await createRequirementService(h.ctx, KIT_PROJECT).create({
      type: 'FUNCTION',
      name: 'Экспортируемая функция',
      criticality: 'MEDIUM',
      implemented: true,
    });
    await h.checkpoints.save(baseState({ jobId: 'exp1' }));
    const projectDir = path.join(root, KIT_PROJECT);
    const archiveRepo = new ArchiveRepo(root);

    const zipExport = await archiveRepo.export(projectDir, 'zip', KIT_PROJECT);
    const entries = new AdmZip(zipExport.body as Buffer).getEntries().map((e) => e.entryName);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.includes('.ai-jobs'))).toBe(false);

    const tarExport = await archiveRepo.export(projectDir, 'targz', KIT_PROJECT);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = tarExport.body as NodeJS.ReadableStream;
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    // Разворачиваем tar.gz через сам импорт: .ai-jobs не должен появиться.
    const tarFile = path.join(root, '..', 'export.tar.gz');
    await fs.writeFile(tarFile, Buffer.concat(chunks));
    const importedId = await archiveRepo.import(tarFile, 'Imported-Tar');
    const importedDir = path.join(root, importedId);
    await expect(fs.stat(path.join(importedDir, '.ai-jobs'))).rejects.toThrow();

    // Импорт zip-архива, в который .ai-jobs подложили вручную.
    const evil = new AdmZip();
    for (const entry of new AdmZip(zipExport.body as Buffer).getEntries()) {
      if (!entry.isDirectory) evil.addFile(entry.entryName, entry.getData());
    }
    evil.addFile('.ai-jobs/foreign/state.json', Buffer.from('{"hacked":true}', 'utf8'));
    const evilFile = path.join(root, '..', 'evil.zip');
    await fs.writeFile(evilFile, evil.toBuffer());
    const evilId = await archiveRepo.import(evilFile, 'Imported-Evil');
    await expect(fs.stat(path.join(root, evilId, '.ai-jobs'))).rejects.toThrow();
  });
});
