import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { AiImportJobs } from '../src/services/AiImportJobs.js';
import {
  AI_IMPORT_HINT_CONFIGURE,
  AI_IMPORT_HINT_NO_DOCS,
  AI_IMPORT_HINT_UNPARSEABLE,
  AI_IMPORT_HINT_UPSTREAM,
  AiImportService,
  nextQuarterOf,
} from '../src/services/AiImportService.js';
import type { AiClient } from '../src/services/AiHubService.js';
import {
  createProjectRepo,
  createProjectService,
  createRequirementService,
  createLinkService,
  type ServiceContext,
} from '../src/factory.js';
import { BadRequestError, ConflictError, NotFoundError } from '../src/lib/errors.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

const SECRET = 'sk-import-secret';
const PROJECT = 'Demo';

/** Build a zip on disk from a name→content map; returns the archive path. */
async function writeZip(files: Record<string, string | Buffer>): Promise<string> {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  }
  const file = path.join(os.tmpdir(), `po-test-ai-zip-${randomBytes(8).toString('hex')}.zip`);
  await fs.writeFile(file, zip.toBuffer());
  return file;
}

/** An AiClient whose chat answers are scripted per call (in order). */
function scriptedClient(answers: Array<string | Error | (() => string)>): AiClient {
  let call = 0;
  return {
    models: { list: vi.fn(async () => ({ data: [] })) },
    chat: {
      completions: {
        create: vi.fn(async () => {
          const answer = answers[Math.min(call, answers.length - 1)];
          call += 1;
          if (answer instanceof Error) throw answer;
          const content = typeof answer === 'function' ? answer() : (answer ?? '[]');
          return { choices: [{ message: { content } }] };
        }),
      },
    },
  };
}

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'FUNCTION',
    name: 'Вход по паролю',
    description: 'Пользователь входит по email и паролю.',
    source: 'auth.md § Вход',
    ...over,
  };
}

describe('T11 AiImportService (unit, mock AI client)', () => {
  let root: string;
  let ctx: ServiceContext;
  let configRepo: AiConfigRepo;
  let jobs: AiImportJobs;

  function makeService(client: AiClient, opts: { chunkChars?: number } = {}): AiImportService {
    const projectRepo = createProjectRepo(ctx);
    return new AiImportService({
      now: fixedNow,
      jobs,
      configRepo,
      makeAiClient: () => client,
      makeRequirementService: (pid) => createRequirementService(ctx, pid),
      makeLinkService: (pid) => createLinkService(ctx, pid),
      projectExists: (pid) => projectRepo.exists(pid),
      chunkChars: opts.chunkChars,
    });
  }

  async function runToEnd(
    service: AiImportService,
    archive: string,
    model?: string,
  ): Promise<string> {
    const { jobId } = await service.start(PROJECT, archive, model);
    await service.waitForCompletion(jobId);
    return jobId;
  }

  beforeEach(async () => {
    root = await makeTmpRoot();
    ctx = { projectsRoot: root, now: fixedNow };
    await createProjectService(ctx).create(PROJECT);
    configRepo = new AiConfigRepo(root);
    await configRepo.update({ apiKey: SECRET, projectId: PROJECT, model: 'Qwen-Coder-Next' });
    jobs = new AiImportJobs(fixedNow);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('happy path: two md files → requirements created with provenance and defaults', async () => {
    const client = scriptedClient([
      JSON.stringify([record()]),
      JSON.stringify([record({ type: 'NFR', name: 'Время отклика', source: 'perf.md § SLA' })]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({
      'auth.md': '# Вход\nПользователь входит по email и паролю.',
      'perf.md': '# SLA\nОтклик до 200 мс.',
    });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.stage).toBe('done');
    expect(view.progress).toBe(100);
    expect(view.result).toEqual({
      createdFunctions: 1,
      createdNfrs: 1,
      skippedExisting: 0,
      links: 0,
    });

    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    expect(requirements).toHaveLength(2);
    const fn = requirements.find((r) => r.type === 'FUNCTION');
    // Provenance is written to the requirement `source` field (FR-19).
    expect(fn?.source).toBe('auth.md § Вход');
    // PO defaults §3.1: MEDIUM, implemented=false, next quarter from now().
    expect(fn?.criticality).toBe('MEDIUM');
    expect(fn?.implemented).toBe(false);
    expect(fn?.targetQuarter).toBe('Q3');
    expect(fn?.targetYear).toBe(2026);
    // Defaults are logged as warnings, not written into the description.
    expect(view.log.some((l) => l.level === 'warn' && l.message.includes('умолчания'))).toBe(true);
    expect(fn?.description).toBe('Пользователь входит по email и паролю.');
    // The upload archive is cleaned up after the run.
    await expect(fs.access(archive)).rejects.toThrow();
  });

  it('T13: nested archive → user message carries the archive map, dir and full relative path', async () => {
    const client = scriptedClient([
      JSON.stringify([record({ name: 'Аутентификация', source: 'docs/api/auth.md § Вход' })]),
      '[]',
      '[]',
    ]);
    const service = makeService(client);
    const archive = await writeZip({
      'docs/api/auth.md': '# Вход\nПользователь входит по email и паролю.',
      'docs/nfr/perf.md': '# SLA\nОтклик до 200 мс.',
      'readme.md': '# Обзор',
    });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');

    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(3);
    type Call = { messages: Array<{ role: string; content: string }> };
    const userOf = (i: number): string =>
      (create.mock.calls[i]?.[0] as Call).messages.find((m) => m.role === 'user')?.content ?? '';
    const expectedMap = 'docs/api/auth.md\ndocs/nfr/perf.md\nreadme.md';
    for (let i = 0; i < 3; i++) {
      expect(userOf(i)).toContain('Структура архива (файлы документации):\n' + expectedMap);
    }
    expect(userOf(0)).toContain('Файл: docs/api/auth.md (фрагмент 1 из 1)');
    expect(userOf(0)).toContain('Директория текущего файла: docs/api');
    expect(userOf(2)).toContain('Директория текущего файла: корень архива');

    // The requirement was created and its source preserved.
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const created = requirements.find((r) => r.name === 'Аутентификация');
    expect(created).toBeDefined();
    expect(created?.source).toBe('docs/api/auth.md § Вход');
  });

  it('respects explicit criticality/implemented from the extraction (no defaults)', async () => {
    const client = scriptedClient([
      JSON.stringify([record({ criticality: 'HIGH', implemented: true })]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Вход по паролю.' });

    await runToEnd(service, archive);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    expect(requirements[0]?.criticality).toBe('HIGH');
    expect(requirements[0]?.implemented).toBe(true);
    expect(requirements[0]?.targetQuarter).toBeUndefined();
    expect(requirements[0]?.targetYear).toBeUndefined();
  });

  it('chunks a large file and makes one sequential AI call per chunk', async () => {
    const client = scriptedClient(['[]']);
    const service = makeService(client, { chunkChars: 100 });
    const lines = Array.from({ length: 12 }, (_, i) => `строка ${i} ${'x'.repeat(30)}`);
    const archive = await writeZip({ 'big.md': lines.join('\n') });

    const jobId = await runToEnd(service, archive);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create.mock.calls.length).toBeGreaterThan(1);
    expect(service.getView(jobId).status).toBe('succeeded');
  });

  it('deduplicates extracted records by (type, name) case-insensitively', async () => {
    const client = scriptedClient([
      JSON.stringify([record(), record({ name: ' вход по паролю ' })]),
      JSON.stringify([record({ name: 'ВХОД ПО ПАРОЛЮ' })]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Вход.', 'b.md': 'Вход дубль.' });

    const jobId = await runToEnd(service, archive);
    expect(service.getView(jobId).result?.createdFunctions).toBe(1);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    expect(requirements).toHaveLength(1);
  });

  it('two files with identical extractions → dropped duplicates surface as a warn with the count', async () => {
    // MockServer e2e regression: 2 docs yield the same 2 records each → 2 created,
    // 2 dropped by (type, name) dedupe — previously invisible in the job log.
    const records = [
      record(),
      record({ type: 'NFR', name: 'Время отклика', source: 'perf.md § SLA' }),
    ];
    const client = scriptedClient([JSON.stringify(records), JSON.stringify(records)]);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Документ 1.', 'b.md': 'Документ 2.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result).toEqual({
      createdFunctions: 1,
      createdNfrs: 1,
      skippedExisting: 0,
      links: 0,
    });
    expect(
      view.log.some(
        (l) => l.level === 'warn' && l.message.includes('Дубликатов в извлечении пропущено: 2'),
      ),
    ).toBe(true);
  });

  it('skips an existing requirement (same type+name) WITHOUT touching its file', async () => {
    const reqService = createRequirementService(ctx, PROJECT);
    const existing = await reqService.create({
      type: 'FUNCTION',
      name: 'Вход по паролю',
      criticality: 'HIGH',
      implemented: true,
      description: 'Ручное описание, не перезаписывать.',
    });
    const file = path.join(root, PROJECT, 'openspec', 'specs', 'functions', `${existing.slug}.md`);
    const before = await fs.readFile(file, 'utf8');

    const client = scriptedClient([JSON.stringify([record()])]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Вход.' });
    const jobId = await runToEnd(service, archive);

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result).toEqual({
      createdFunctions: 0,
      createdNfrs: 0,
      skippedExisting: 1,
      links: 0,
    });
    expect(view.log.some((l) => l.level === 'warn' && l.message.includes('пропущено'))).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('creates CHILD_OF hierarchy when parentName resolves inside the extracted set', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Аутентификация', source: 'auth.md § Аутентификация' }),
        record({ parentName: 'Аутентификация' }),
      ]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Раздел.' });

    const jobId = await runToEnd(service, archive);
    expect(service.getView(jobId).result?.links).toBe(1);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const child = requirements.find((r) => r.name === 'Вход по паролю');
    expect(child?.links).toEqual([{ type: 'CHILD_OF', targetSlug: expect.any(String) }]);
  });

  it('warns and keeps the requirement when the parent cannot be resolved', async () => {
    const client = scriptedClient([
      JSON.stringify([record({ parentName: 'Несуществующий раздел' })]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Вход.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.createdFunctions).toBe(1);
    expect(view.result?.links).toBe(0);
    expect(view.log.some((l) => l.level === 'warn' && l.message.includes('не найден'))).toBe(true);
  });

  it('cancels at a chunk boundary: cancelled status + partial result, no further calls', async () => {
    let jobId = '';
    const client = scriptedClient([
      () => {
        // Cancel while the first chunk is being processed.
        service.cancel(jobId);
        return '[]';
      },
      '[]',
    ]);
    const service = makeService(client, { chunkChars: 40 });
    const archive = await writeZip({
      'big.md': Array.from({ length: 8 }, (_, i) => `строка ${i} ${'x'.repeat(20)}`).join('\n'),
    });

    ({ jobId } = await service.start(PROJECT, archive));
    await service.waitForCompletion(jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('cancelled');
    expect(view.result).toEqual({
      createdFunctions: 0,
      createdNfrs: 0,
      skippedExisting: 0,
      links: 0,
    });
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(1);
    expect(view.log.some((l) => l.message.includes('остановлена'))).toBe(true);
  });

  it('fails the unpack stage when the archive has no documentation files', async () => {
    const client = scriptedClient(['[]']);
    const service = makeService(client);
    const archive = await writeZip({ 'image.png': Buffer.from([1, 2, 3]) });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.stage).toBe('unpack');
    expect(view.error?.hint).toBe(AI_IMPORT_HINT_NO_DOCS);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).not.toHaveBeenCalled();
  });

  it('fails the unpack stage on a corrupt archive', async () => {
    const client = scriptedClient(['[]']);
    const service = makeService(client);
    const bogus = path.join(os.tmpdir(), `po-test-bogus-${randomBytes(6).toString('hex')}`);
    await fs.writeFile(bogus, 'not an archive at all');

    const jobId = await runToEnd(service, bogus);
    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.error?.hint).toContain('Проверьте формат архива');
  });

  it('fails analyze on an AI upstream error with a sanitized message', async () => {
    const client = scriptedClient([new Error(`hub down key=${SECRET}`)]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Вход.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.stage).toBe('analyze');
    expect(view.error?.hint).toBe(AI_IMPORT_HINT_UPSTREAM);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it('continues after one unparseable chunk (warn) but fails when ALL chunks are unparseable', async () => {
    // One valid + one prose chunk → succeeded with a warning.
    const mixed = scriptedClient(['Не могу извлечь.', JSON.stringify([record()])]);
    const service = makeService(mixed);
    const archive = await writeZip({ 'a.md': 'Вход.', 'b.md': 'Ещё вход.' });
    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.log.some((l) => l.level === 'warn' && l.message.includes('не распознан'))).toBe(
      true,
    );

    // All chunks unparseable → failed with the spec §4 hint.
    const jobs2 = new AiImportJobs(fixedNow);
    jobs = jobs2;
    const prose = scriptedClient(['Просто текст без JSON.']);
    const service2 = makeService(prose);
    const archive2 = await writeZip({ 'a.md': 'Вход.' });
    const jobId2 = await runToEnd(service2, archive2);
    const view2 = service2.getView(jobId2);
    expect(view2.status).toBe('failed');
    expect(view2.stage).toBe('analyze');
    expect(view2.error?.hint).toBe(AI_IMPORT_HINT_UNPARSEABLE);
  });

  it('drops a record without source (warn) and keeps the valid one', async () => {
    const noSource = record();
    delete (noSource as Record<string, unknown>).source;
    const client = scriptedClient([JSON.stringify([record({ name: 'С источником' }), noSource])]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Вход.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.result?.createdFunctions).toBe(1);
    expect(view.log.some((l) => l.level === 'warn' && l.message.includes('source'))).toBe(true);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    expect(requirements.map((r) => r.name)).toEqual(['С источником']);
  });

  it('accepts a tar.gz archive as well as zip (spec §5.9)', async () => {
    const tar = await import('tar');
    const srcDir = path.join(os.tmpdir(), `po-test-targz-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'auth.md'), 'Вход по паролю.', 'utf8');
    const archive = path.join(os.tmpdir(), `po-test-${randomBytes(6).toString('hex')}.tar.gz`);
    await tar.create({ gzip: true, cwd: srcDir, file: archive }, ['.']);
    await fs.rm(srcDir, { recursive: true, force: true });

    const service = makeService(scriptedClient([JSON.stringify([record()])]));
    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.createdFunctions).toBe(1);
  });

  it('start: 404 for an unknown project', async () => {
    const service = makeService(scriptedClient(['[]']));
    const archive = await writeZip({ 'a.md': 'x' });
    await expect(service.start('NoSuch', archive)).rejects.toThrow(NotFoundError);
  });

  it('start: 400 with the spec §4 text when no key or no model', async () => {
    await configRepo.update({ apiKey: null });
    const service = makeService(scriptedClient(['[]']));
    const archive = await writeZip({ 'a.md': 'x' });
    await expect(service.start(PROJECT, archive)).rejects.toThrow(AI_IMPORT_HINT_CONFIGURE);

    await configRepo.update({ apiKey: SECRET }); // key back, but strip the model
    const bare = new AiImportJobs(fixedNow);
    jobs = bare;
    const service2 = makeService(scriptedClient(['[]']));
    const cfg = await configRepo.read();
    delete cfg.modelByProject[PROJECT];
    await fs.writeFile(path.join(root, '.ai-config.json'), JSON.stringify(cfg));
    const archive2 = await writeZip({ 'a.md': 'x' });
    await expect(service2.start(PROJECT, archive2)).rejects.toThrow(BadRequestError);
  });

  it('start: model override wins over the per-project model', async () => {
    const client = scriptedClient(['[]']);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Вход.' });
    await runToEnd(service, archive, 'Override-Model');
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'Override-Model' }));
  });

  it('start: 409 when the project already has a running job', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client: AiClient = {
      models: { list: vi.fn(async () => ({ data: [] })) },
      chat: {
        completions: {
          create: vi.fn(async () => {
            await gate;
            return { choices: [{ message: { content: '[]' } }] };
          }),
        },
      },
    };
    const service = makeService(client);
    const first = await service.start(PROJECT, await writeZip({ 'a.md': 'Вход.' }));
    await expect(service.start(PROJECT, await writeZip({ 'b.md': 'x' }))).rejects.toThrow(
      ConflictError,
    );
    release();
    await service.waitForCompletion(first.jobId);
    expect(service.getView(first.jobId).status).toBe('succeeded');
  });

  it('cancel/getView: 404 for an unknown job; cancel after completion is a no-op', async () => {
    const service = makeService(scriptedClient(['[]']));
    expect(() => service.getView('nope')).toThrow(NotFoundError);
    expect(() => service.cancel('nope')).toThrow(NotFoundError);

    const archive = await writeZip({ 'a.md': 'Вход.' });
    const jobId = await runToEnd(service, archive);
    const done = service.getView(jobId);
    const after = service.cancel(jobId); // idempotent no-op
    expect(after.status).toBe(done.status);
    expect(after.status).toBe('succeeded');
  });
});

describe('T11 AiImportJobs (TTL + one running job per project)', () => {
  it('sweeps finished jobs after 30 minutes but keeps running ones', () => {
    let t = Date.parse('2026-06-29T10:00:00.000Z');
    const jobs = new AiImportJobs(() => new Date(t).toISOString());
    const done = jobs.create('P1');
    jobs.finish(done, 'succeeded');
    const running = jobs.create('P2');

    t += 29 * 60 * 1000;
    expect(jobs.get(done.jobId)).toBeDefined();

    t += 2 * 60 * 1000; // 31 minutes total
    expect(jobs.get(done.jobId)).toBeUndefined();
    expect(jobs.get(running.jobId)).toBe(running);
  });

  it('allows a new job for a project once the previous one finished', () => {
    const jobs = new AiImportJobs(fixedNow);
    const first = jobs.create('P1');
    expect(() => jobs.create('P1')).toThrow(ConflictError);
    jobs.finish(first, 'cancelled');
    expect(jobs.create('P1').jobId).not.toBe(first.jobId);
  });
});

describe('T11 nextQuarterOf', () => {
  it.each([
    ['2026-01-15T00:00:00.000Z', 'Q2', 2026],
    ['2026-06-29T10:00:00.000Z', 'Q3', 2026],
    ['2026-09-01T00:00:00.000Z', 'Q4', 2026],
    ['2026-11-30T00:00:00.000Z', 'Q1', 2027],
  ])('%s → %s %i', (iso, quarter, year) => {
    expect(nextQuarterOf(iso)).toEqual({ targetQuarter: quarter, targetYear: year });
  });
});
