import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { AiImportJobs } from '../src/services/AiImportJobs.js';
import { resolveModelPreset } from '@po/core';
import {
  AI_IMPORT_HINT_CONFIGURE,
  AI_IMPORT_HINT_NO_DOCS,
  AI_IMPORT_HINT_UNPARSEABLE,
  AI_IMPORT_HINT_UPSTREAM,
  AiImportService,
  breakParentCycles,
  nextQuarterOf,
  type AiImportServiceDeps,
} from '../src/services/AiImportService.js';
import { CycleError } from '@po/core';
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

/** One scripted answer: plain content, thrown error, lazy content, or content + finish_reason. */
type ScriptedAnswer = string | Error | (() => string) | { content: string; finishReason: string };

/** An AiClient whose chat answers are scripted per call (in order). */
function scriptedClient(answers: ScriptedAnswer[]): AiClient {
  let call = 0;
  return {
    models: { list: vi.fn(async () => ({ data: [] })) },
    chat: {
      completions: {
        create: vi.fn(async () => {
          const answer = answers[Math.min(call, answers.length - 1)];
          call += 1;
          if (answer instanceof Error) throw answer;
          if (typeof answer === 'object' && answer !== null) {
            return {
              choices: [
                { message: { content: answer.content }, finish_reason: answer.finishReason },
              ],
            };
          }
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

/** Structure-stage answer: [{type, name, parentName|null}] (Task 13 B2). */
function structure(
  nodes: Array<{ type?: string; name: string; parentName?: string | null }>,
): string {
  return JSON.stringify(
    nodes.map((n) => ({
      type: n.type ?? 'FUNCTION',
      name: n.name,
      parentName: n.parentName ?? null,
    })),
  );
}

describe('T11 AiImportService (unit, mock AI client)', () => {
  let root: string;
  let ctx: ServiceContext;
  let configRepo: AiConfigRepo;
  let jobs: AiImportJobs;

  function makeService(
    client: AiClient,
    opts: { chunkChars?: number; structureBatch?: number } = {},
    overrides: Partial<AiImportServiceDeps> = {},
  ): AiImportService {
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
      structureBatch: opts.structureBatch,
      ...overrides,
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

  it('happy path: two md files → requirements created, source empty, implemented forced (Task 13 A1/A2)', async () => {
    const client = scriptedClient([
      JSON.stringify([record()]),
      JSON.stringify([record({ type: 'NFR', name: 'Время отклика', source: 'perf.md § SLA' })]),
      structure([{ name: 'Вход по паролю' }, { type: 'NFR', name: 'Время отклика' }]),
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
      relatesLinks: 0,
    });

    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    expect(requirements).toHaveLength(2);
    const fn = requirements.find((r) => r.type === 'FUNCTION');
    // A1: `source` is a business field (who asked for the requirement) — the
    // file provenance stays in the log only, the field is left empty.
    expect(fn?.source).toBeUndefined();
    // A2: everything imported is created as already implemented; no target
    // quarter/year (rules.ts: those exist only when implemented=false).
    expect(fn?.criticality).toBe('MEDIUM');
    expect(fn?.implemented).toBe(true);
    expect(fn?.targetQuarter).toBeUndefined();
    expect(fn?.targetYear).toBeUndefined();
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
      structure([{ name: 'Аутентификация' }]),
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
    // 3 extraction calls + 1 structure call (Task 13 B2).
    expect(create).toHaveBeenCalledTimes(4);
    type Call = { messages: Array<{ role: string; content: string }> };
    const userOf = (i: number): string =>
      (create.mock.calls[i]?.[0] as Call).messages.find((m) => m.role === 'user')?.content ?? '';
    const expectedMap = 'docs/api/auth.md\ndocs/nfr/perf.md\nreadme.md';
    // The archive map goes into every call — extraction AND structure.
    for (let i = 0; i < 4; i++) {
      expect(userOf(i)).toContain('Структура архива (файлы документации):\n' + expectedMap);
    }
    expect(userOf(0)).toContain('Файл: docs/api/auth.md (фрагмент 1 из 1)');
    expect(userOf(0)).toContain('Директория текущего файла: docs/api');
    expect(userOf(2)).toContain('Директория текущего файла: корень архива');
    // The structure call lists the extracted requirements (type + name).
    expect(userOf(3)).toContain('Аутентификация');
    expect(userOf(3)).toContain('FUNCTION');

    // The requirement was created; provenance is NOT copied into `source` (A1).
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const created = requirements.find((r) => r.name === 'Аутентификация');
    expect(created).toBeDefined();
    expect(created?.source).toBeUndefined();
  });

  it('respects explicit criticality but forces implemented=true even when the model says false (A2)', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ criticality: 'HIGH', implemented: false, targetQuarter: 'Q4', targetYear: 2027 }),
      ]),
      structure([{ name: 'Вход по паролю' }]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Вход по паролю.' });

    await runToEnd(service, archive);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    expect(requirements[0]?.criticality).toBe('HIGH');
    // A2: implemented is forced to true, so the model's quarter/year are dropped.
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
      structure([{ name: 'Вход по паролю' }]),
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
    const client = scriptedClient([
      JSON.stringify(records),
      JSON.stringify(records),
      structure([{ name: 'Вход по паролю' }, { type: 'NFR', name: 'Время отклика' }]),
    ]);
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
      relatesLinks: 0,
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

    const client = scriptedClient([
      JSON.stringify([record()]),
      structure([{ name: 'Вход по паролю' }]),
    ]);
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
      relatesLinks: 0,
    });
    expect(view.log.some((l) => l.level === 'warn' && l.message.includes('пропущено'))).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('creates CHILD_OF hierarchy from the structure-stage answer (B2)', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Аутентификация', source: 'auth.md § Аутентификация' }),
        record(),
      ]),
      structure([
        { name: 'Аутентификация' },
        { name: 'Вход по паролю', parentName: 'Аутентификация' },
      ]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Раздел.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.result?.links).toBe(1);
    expect(
      view.log.some((l) => l.message.includes('Построение древовидной структуры ФТ/НФТ')),
    ).toBe(true);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const child = requirements.find((r) => r.name === 'Вход по паролю');
    expect(child?.links).toEqual([{ type: 'CHILD_OF', targetSlug: expect.any(String) }]);
  });

  it('B2: structure parentName OVERRIDES extraction parentName; missing in answer → root', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Раздел А', source: 'a.md § А' }),
        record({ name: 'Раздел Б', source: 'a.md § Б' }),
        // extraction claims Б is the parent; structure will say А instead.
        record({ name: 'Вход по паролю', parentName: 'Раздел Б' }),
        // extraction claims a parent; the record is absent from the structure
        // answer → it becomes a root.
        record({ name: 'Сирота', parentName: 'Раздел А', source: 'a.md § С' }),
      ]),
      structure([
        { name: 'Раздел А' },
        { name: 'Раздел Б' },
        { name: 'Вход по паролю', parentName: 'Раздел А' },
      ]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Иерархия.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.links).toBe(1);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const child = requirements.find((r) => r.name === 'Вход по паролю');
    const parentA = requirements.find((r) => r.name === 'Раздел А');
    expect(child?.links).toEqual([{ type: 'CHILD_OF', targetSlug: parentA?.slug }]);
    const orphan = requirements.find((r) => r.name === 'Сирота');
    expect(orphan?.links).toEqual([]);
  });

  it('warns and keeps the requirement when the structure parent cannot be resolved', async () => {
    const client = scriptedClient([
      JSON.stringify([record()]),
      structure([{ name: 'Вход по паролю', parentName: 'Несуществующий раздел' }]),
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

  it('B2: batches the structure calls and merges parents across batches', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Раздел', source: 'a.md § Раздел' }),
        record({ name: 'Вход', source: 'a.md § Вход' }),
        record({ name: 'Выход', source: 'a.md § Выход' }),
      ]),
      structure([{ name: 'Раздел' }, { name: 'Вход', parentName: 'Раздел' }]),
      structure([{ name: 'Выход', parentName: 'Раздел' }]),
    ]);
    const service = makeService(client, { structureBatch: 2 });
    const archive = await writeZip({ 'a.md': 'Дерево.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.links).toBe(2);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    // 1 extraction + 2 structure batches.
    expect(create).toHaveBeenCalledTimes(3);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const parent = requirements.find((r) => r.name === 'Раздел');
    for (const name of ['Вход', 'Выход']) {
      const child = requirements.find((r) => r.name === name);
      expect(child?.links).toEqual([{ type: 'CHILD_OF', targetSlug: parent?.slug }]);
    }
  });

  it('B2: after 3 invalid structure answers the batch degrades to a flat list with a warn, job succeeds', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Аутентификация', source: 'auth.md § Аутентификация' }),
        record({ parentName: 'Аутентификация' }),
      ]),
      'Не могу построить дерево.', // structure attempt 1
      'Всё ещё проза.', // attempt 2
      '{"не":"массив"}', // attempt 3
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Раздел.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    // The job is NOT failed: requirements matter more than the tree.
    expect(view.status).toBe('succeeded');
    expect(view.result?.createdFunctions).toBe(2);
    expect(view.result?.links).toBe(0);
    expect(
      view.log.some(
        (l) =>
          l.level === 'warn' &&
          l.message.includes('Структура для батча не получена — записи останутся корневыми'),
      ),
    ).toBe(true);
    // Every failed attempt is logged with its number.
    expect(view.log.some((l) => l.message.includes('попытка 1 из 3'))).toBe(true);
    expect(view.log.some((l) => l.message.includes('попытка 3 из 3'))).toBe(true);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(4); // 1 extraction + 3 structure attempts
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    expect(requirements.every((r) => r.links.length === 0)).toBe(true);
  });

  it('B2: cancel is honoured between structure batches', async () => {
    let jobId = '';
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'А', source: 'a.md § А' }),
        record({ name: 'Б', source: 'a.md § Б' }),
      ]),
      () => {
        // Cancel while the FIRST structure batch is in flight.
        service.cancel(jobId);
        return structure([{ name: 'А' }]);
      },
      structure([{ name: 'Б' }]),
    ]);
    const service = makeService(client, { structureBatch: 1 });
    const archive = await writeZip({ 'a.md': 'Дерево.' });

    ({ jobId } = await service.start(PROJECT, archive));
    await service.waitForCompletion(jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('cancelled');
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2); // extraction + first batch only
  });

  it('A3: a non-JSON extraction answer is retried and succeeds on the second attempt', async () => {
    const client = scriptedClient([
      'Не могу извлечь.', // attempt 1 → warn «попытка 1 из 3»
      JSON.stringify([record()]), // attempt 2 → parsed
      structure([{ name: 'Вход по паролю' }]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Вход.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.createdFunctions).toBe(1);
    expect(view.log.some((l) => l.level === 'warn' && l.message.includes('попытка 1 из 3'))).toBe(
      true,
    );
    // No «фрагмент пропущен» — the retry recovered the chunk.
    expect(view.log.some((l) => l.message.includes('фрагмент пропущен'))).toBe(false);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('A3: upstream errors are NOT retried — the job fails immediately (current behaviour)', async () => {
    const client = scriptedClient(['Проза без JSON.', new Error('hub down')]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Вход.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    // Attempt 1: non-JSON → retry; attempt 2: upstream error → fail, no attempt 3.
    expect(view.status).toBe('failed');
    expect(view.error?.hint).toBe(AI_IMPORT_HINT_UPSTREAM);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('A3: cancel between retry attempts stops the job', async () => {
    let jobId = '';
    const client = scriptedClient([
      () => {
        service.cancel(jobId);
        return 'Проза без JSON.';
      },
      JSON.stringify([record()]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Вход.' });

    ({ jobId } = await service.start(PROJECT, archive));
    await service.waitForCompletion(jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('cancelled');
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(1); // no second attempt after cancel
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
      relatesLinks: 0,
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

  it('skips a chunk after 3 non-JSON attempts (warn) but fails when ALL chunks are unparseable', async () => {
    // Chunk of a.md: 3 prose attempts → skipped; chunk of b.md parses → succeeded.
    const mixed = scriptedClient([
      'Не могу извлечь.',
      'Всё ещё не могу.',
      'Сдаюсь.',
      JSON.stringify([record()]),
      structure([{ name: 'Вход по паролю' }]),
    ]);
    const service = makeService(mixed);
    const archive = await writeZip({ 'a.md': 'Вход.', 'b.md': 'Ещё вход.' });
    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.log.some((l) => l.level === 'warn' && l.message.includes('попытка 3 из 3'))).toBe(
      true,
    );
    expect(
      view.log.some((l) => l.level === 'warn' && l.message.includes('фрагмент пропущен')),
    ).toBe(true);
    const createMixed = mixed.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(createMixed).toHaveBeenCalledTimes(5); // 3 + 1 extraction, 1 structure

    // All chunks unparseable (after retries) → failed with the spec §4 hint.
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
    const createProse = prose.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(createProse).toHaveBeenCalledTimes(3); // 3 attempts for the single chunk
  });

  it('drops a record without source (warn) and keeps the valid one', async () => {
    const noSource = record();
    delete (noSource as Record<string, unknown>).source;
    const client = scriptedClient([
      JSON.stringify([record({ name: 'С источником' }), noSource]),
      structure([{ name: 'С источником' }]),
    ]);
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

    const service = makeService(
      scriptedClient([JSON.stringify([record()]), structure([{ name: 'Вход по паролю' }])]),
    );
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

  // ── Task 14: tree validity of the AI import ───────────────────────────────

  it('todo_18: every import call sends the model preset budget as max_tokens', async () => {
    const client = scriptedClient([
      JSON.stringify([record()]),
      structure([{ name: 'Вход по паролю' }]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Вход.' });

    await runToEnd(service, archive);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    const budgets = create.mock.calls.map((c) => (c[0] as { max_tokens: number }).max_tokens);
    // Model 'Qwen-Coder-Next' has no dedicated preset → generic budget 4000,
    // sent verbatim (no per-call Math.min cap) for extraction AND structure.
    const budget = resolveModelPreset('Qwen-Coder-Next').maxOutputTokens;
    expect(budget).toBe(4000);
    expect(budgets).toEqual([budget, budget]);
  });

  it('T14 B2: finish_reason=length → truncation warn, salvaged array still used', async () => {
    const two = JSON.stringify([
      record(),
      record({ name: 'Обрезанное', source: 'auth.md § Хвост' }),
    ]);
    const truncated = two.slice(0, two.indexOf('Обрезанное')); // cut inside record 2
    const client = scriptedClient([
      { content: truncated, finishReason: 'length' },
      structure([{ name: 'Вход по паролю' }]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Вход.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    // The salvage recovered the first (complete) record on the FIRST attempt.
    expect(view.result?.createdFunctions).toBe(1);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
    expect(
      view.log.some((l) => l.level === 'warn' && l.message.includes('обрезан по лимиту токенов')),
    ).toBe(true);
  });

  it('T14 B5: foreign structure nodes are ignored with a warn and never become parents', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'А', source: 'a.md § А' }),
        record({ name: 'Б', source: 'a.md § Б' }),
      ]),
      structure([
        { name: 'А' },
        { name: 'Б', parentName: 'А' },
        { name: 'Выдуманный узел', parentName: 'А' }, // not in the extracted set
      ]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Дерево.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result).toEqual({
      createdFunctions: 2,
      createdNfrs: 0,
      skippedExisting: 0,
      links: 1,
      relatesLinks: 0,
    });
    expect(
      view.log.some(
        (l) => l.level === 'warn' && l.message.includes('посторонних узлов проигнорировано: 1'),
      ),
    ).toBe(true);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    expect(requirements.map((r) => r.name).sort()).toEqual(['А', 'Б']);
  });

  it('T14 B5: batch items missing from the answer produce a coverage warn', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'А', source: 'a.md § А' }),
        record({ name: 'Б', source: 'a.md § Б' }),
      ]),
      structure([{ name: 'А' }]), // Б is missing from the answer
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Дерево.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(
      view.log.some(
        (l) =>
          l.level === 'warn' && l.message.includes('без узла в ответе: 1 (останутся корневыми)'),
      ),
    ).toBe(true);
  });

  it('T14 B5: conflicting parents for one (type, name) → first wins with a warn', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'А', source: 'a.md § А' }),
        record({ name: 'Б', source: 'a.md § Б' }),
        record({ name: 'В', source: 'a.md § В' }),
      ]),
      structure([
        { name: 'А' },
        { name: 'Б' },
        { name: 'В', parentName: 'А' },
        { name: 'В', parentName: 'Б' }, // conflict — the first one wins
      ]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Дерево.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.links).toBe(1);
    expect(
      view.log.some((l) => l.level === 'warn' && l.message.includes('используется первый')),
    ).toBe(true);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const child = requirements.find((r) => r.name === 'В');
    const parentA = requirements.find((r) => r.name === 'А');
    expect(child?.links).toEqual([{ type: 'CHILD_OF', targetSlug: parentA?.slug }]);
  });

  it('T14 B6: a parent cycle in the structure answer is broken before populate', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'А', source: 'a.md § А' }),
        record({ name: 'Б', source: 'a.md § Б' }),
      ]),
      structure([
        { name: 'А', parentName: 'Б' },
        { name: 'Б', parentName: 'А' },
      ]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Цикл.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    // Deterministic: walking from «А», the edge Б→А closes the cycle → «Б» roots.
    expect(
      view.log.some(
        (l) => l.level === 'warn' && l.message.includes('Цикл разорван: «Б» становится корневым'),
      ),
    ).toBe(true);
    // No CYCLE error reaches the link layer; the surviving edge is created.
    expect(view.log.some((l) => l.message.includes('CYCLE'))).toBe(false);
    expect(view.result?.links).toBe(1);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const a = requirements.find((r) => r.name === 'А');
    const b = requirements.find((r) => r.name === 'Б');
    expect(a?.links).toEqual([{ type: 'CHILD_OF', targetSlug: b?.slug }]);
  });

  it('T14 B6: a parent of the OTHER type gets a dedicated warn and is skipped', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Раздел', source: 'a.md § Р' }),
        record({ type: 'NFR', name: 'Отклик', source: 'a.md § О' }),
      ]),
      structure([
        { name: 'Раздел' },
        { type: 'NFR', name: 'Отклик', parentName: 'Раздел' }, // FUNCTION parent for an NFR
      ]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Типы.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.links).toBe(0);
    expect(
      view.log.some(
        (l) =>
          l.level === 'warn' &&
          l.message.includes(
            'родитель «Раздел» имеет другой тип — иерархия допустима только внутри одного типа; пропущена',
          ),
      ),
    ).toBe(true);
  });

  it('T14 B6: logs the tree summary (roots/children per type + max depth)', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Аутентификация', source: 'auth.md § Обзор' }),
        record(),
        record({ type: 'NFR', name: 'Время отклика', source: 'perf.md § SLA' }),
      ]),
      structure([
        { name: 'Аутентификация' },
        { name: 'Вход по паролю', parentName: 'Аутентификация' },
        { type: 'NFR', name: 'Время отклика' },
      ]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Дерево.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(
      view.log.some(
        (l) =>
          l.level === 'info' &&
          l.message.includes(
            'Дерево: ФТ — 1 корней, 1 с родителем; НФТ — 1 корней, 0 с родителем; максимальная глубина 2.',
          ),
      ),
    ).toBe(true);
  });

  it('T14 B7: the 3rd structure attempt salvages valid nodes from a partially invalid answer', async () => {
    const lastAnswer = JSON.stringify([
      { type: 'FUNCTION', name: 'А', parentName: null },
      { type: 'FUNCTION', name: 'Б', parentName: 'А' },
      { type: 'FUNCTION', name: 'Сломанный' }, // no parentName → invalid node
    ]);
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'А', source: 'a.md § А' }),
        record({ name: 'Б', source: 'a.md § Б' }),
      ]),
      JSON.stringify([{ ерунда: true }]), // attempt 1: array, all nodes invalid → strict null
      JSON.stringify([{ ерунда: true }]), // attempt 2: same
      lastAnswer, // attempt 3: lenient accepts the 2 valid nodes
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Дерево.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.links).toBe(1);
    expect(
      view.log.some(
        (l) =>
          l.level === 'warn' && l.message.includes('принято 2 из 3 узлов, невалидных отброшено 1'),
      ),
    ).toBe(true);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(4); // 1 extraction + 3 structure attempts
  });

  it('T14 B8: an extraction array whose records are ALL invalid is retried like non-JSON', async () => {
    const client = scriptedClient([
      JSON.stringify([{ type: 'FUNCTION', name: 'Без описания и источника' }]), // all invalid
      JSON.stringify([record()]), // attempt 2 succeeds
      structure([{ name: 'Вход по паролю' }]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'auth.md': 'Вход.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.createdFunctions).toBe(1);
    expect(view.log.some((l) => l.level === 'warn' && l.message.includes('попытка 1 из 3'))).toBe(
      true,
    );
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('T14 B9: logs model and volume before the first AI call; a truly empty [] is NOT retried', async () => {
    const client = scriptedClient(['[]']);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Текст.', 'b.md': 'Ещё текст.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(
      view.log.some(
        (l) =>
          l.level === 'info' &&
          l.message.includes('Модель: Qwen-Coder-Next. Файлов: 2, фрагментов: 2.'),
      ),
    ).toBe(true);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2); // one per chunk, no retries, no structure call
  });

  it('T14 B9: zero extracted requirements → structure stage skipped without hub calls', async () => {
    const client = scriptedClient(['[]']);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Текст.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(
      view.log.some((l) => l.message.includes('Структурировать нечего — требования не извлечены')),
    ).toBe(true);
    expect(view.log.some((l) => l.message.includes('Построение древовидной структуры'))).toBe(
      false,
    );
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(1); // extraction only
  });

  // ── Task 15: НФТ → ФТ через RELATES_TO ────────────────────────────────────

  it('T15: NFR with relatedFunctions → RELATES_TO pair on both endpoints, counter and log line', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Поиск', source: 'search.md § Поиск' }),
        record({
          type: 'NFR',
          name: 'Время отклика поиска',
          source: 'search.md § SLA',
          relatedFunctions: ['Поиск'],
        }),
      ]),
      structure([{ name: 'Поиск' }, { type: 'NFR', name: 'Время отклика поиска' }]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'search.md': 'Поиск отвечает за 200 мс.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result).toEqual({
      createdFunctions: 1,
      createdNfrs: 1,
      skippedExisting: 0,
      links: 0,
      relatesLinks: 1,
    });
    expect(
      view.log.some(
        (l) =>
          l.level === 'info' &&
          l.message === 'Связано: НФТ «Время отклика поиска» → ФТ «Поиск» (RELATES_TO).',
      ),
    ).toBe(true);
    // Done summary carries the dedicated counter next to the CHILD_OF one.
    expect(
      view.log.some((l) => l.level === 'info' && l.message.includes('связей 0, связей НФТ→ФТ: 1.')),
    ).toBe(true);
    // Link parity: RELATES_TO is symmetric, both endpoints carry the pair.
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const fn = requirements.find((r) => r.name === 'Поиск');
    const nfr = requirements.find((r) => r.name === 'Время отклика поиска');
    expect(nfr?.links).toEqual([{ type: 'RELATES_TO', targetSlug: fn?.slug }]);
    expect(fn?.links).toEqual([{ type: 'RELATES_TO', targetSlug: nfr?.slug }]);
  });

  it('T15: resolves the related function name case-insensitively (nameKey)', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Поиск', source: 'search.md § Поиск' }),
        record({
          type: 'NFR',
          name: 'SLA поиска',
          source: 'search.md § SLA',
          relatedFunctions: ['  ПОИСК '],
        }),
      ]),
      structure([{ name: 'Поиск' }, { type: 'NFR', name: 'SLA поиска' }]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'search.md': 'Поиск.' });

    const jobId = await runToEnd(service, archive);
    expect(service.getView(jobId).result?.relatesLinks).toBe(1);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const nfr = requirements.find((r) => r.name === 'SLA поиска');
    expect(nfr?.links).toHaveLength(1);
    expect(nfr?.links[0]?.type).toBe('RELATES_TO');
  });

  it('T15: links an NFR to a function that ALREADY existed in the project before the import', async () => {
    const existingFn = await createRequirementService(ctx, PROJECT).create({
      type: 'FUNCTION',
      name: 'Поиск',
      criticality: 'HIGH',
      implemented: true,
    });
    const client = scriptedClient([
      JSON.stringify([
        record({
          type: 'NFR',
          name: 'SLA поиска',
          source: 'search.md § SLA',
          relatedFunctions: ['Поиск'],
        }),
      ]),
      structure([{ type: 'NFR', name: 'SLA поиска' }]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'search.md': 'Поиск отвечает за 200 мс.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.relatesLinks).toBe(1);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const nfr = requirements.find((r) => r.name === 'SLA поиска');
    expect(nfr?.links).toEqual([{ type: 'RELATES_TO', targetSlug: existingFn.slug }]);
  });

  it('T15: unknown related function → warn, link skipped, job still succeeds', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({
          type: 'NFR',
          name: 'SLA поиска',
          source: 'search.md § SLA',
          relatedFunctions: ['Несуществующий поиск'],
        }),
      ]),
      structure([{ type: 'NFR', name: 'SLA поиска' }]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'search.md': 'SLA.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.relatesLinks).toBe(0);
    expect(
      view.log.some(
        (l) =>
          l.level === 'warn' &&
          l.message ===
            'НФТ «SLA поиска»: связанная ФТ «Несуществующий поиск» не найдена — связь пропущена.',
      ),
    ).toBe(true);
  });

  it('T15: duplicates of one NFR union their relatedFunctions by case-insensitive name', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Поиск', source: 'a.md § Поиск' }),
        record({
          type: 'NFR',
          name: 'Производительность',
          source: 'a.md § SLA',
          relatedFunctions: ['Поиск'],
        }),
      ]),
      JSON.stringify([
        record({ name: 'Экспорт', source: 'b.md § Экспорт' }),
        record({
          type: 'NFR',
          name: 'ПРОИЗВОДИТЕЛЬНОСТЬ',
          source: 'b.md § SLA',
          relatedFunctions: ['Экспорт', 'поиск'],
        }),
      ]),
      structure([
        { name: 'Поиск' },
        { name: 'Экспорт' },
        { type: 'NFR', name: 'Производительность' },
      ]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Поиск.', 'b.md': 'Экспорт.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    // One NFR survives dedupe, but carries the UNION of related functions.
    expect(view.result?.createdNfrs).toBe(1);
    expect(view.result?.relatesLinks).toBe(2);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const nfr = requirements.find((r) => r.type === 'NFR');
    expect(nfr?.links.filter((l) => l.type === 'RELATES_TO')).toHaveLength(2);
  });

  it('T15: FUNCTION with relatedFunctions → field ignored with a warn, no links', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Экспорт', source: 'a.md § Экспорт' }),
        record({ relatedFunctions: ['Экспорт'] }), // FUNCTION «Вход по паролю»
      ]),
      structure([{ name: 'Экспорт' }, { name: 'Вход по паролю' }]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({ 'a.md': 'Текст.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.relatesLinks).toBe(0);
    expect(
      view.log.some(
        (l) =>
          l.level === 'warn' &&
          l.message ===
            '«Вход по паролю» (FUNCTION): relatedFunctions игнорируется — привязка допустима только от НФТ.',
      ),
    ).toBe(true);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    for (const req of requirements) {
      expect(req.links.filter((l) => l.type === 'RELATES_TO')).toHaveLength(0);
    }
  });

  it('T15: re-run is idempotent — existing RELATES_TO is not duplicated, missing one is completed', async () => {
    const answers = [
      JSON.stringify([
        record({ name: 'Поиск', source: 'search.md § Поиск' }),
        record({
          type: 'NFR',
          name: 'SLA поиска',
          source: 'search.md § SLA',
          relatedFunctions: ['Поиск'],
        }),
      ]),
      structure([{ name: 'Поиск' }, { type: 'NFR', name: 'SLA поиска' }]),
    ];
    // First run creates both requirements and the link.
    const service1 = makeService(scriptedClient(answers));
    const jobId1 = await runToEnd(service1, await writeZip({ 'search.md': 'Поиск.' }));
    expect(service1.getView(jobId1).result?.relatesLinks).toBe(1);

    // Second run: both requirements are skipped, the link already exists on
    // both endpoints → nothing created, nothing duplicated.
    const service2 = makeService(scriptedClient(answers));
    const jobId2 = await runToEnd(service2, await writeZip({ 'search.md': 'Поиск.' }));
    const view2 = service2.getView(jobId2);
    expect(view2.status).toBe('succeeded');
    expect(view2.result).toEqual({
      createdFunctions: 0,
      createdNfrs: 0,
      skippedExisting: 2,
      links: 0,
      relatesLinks: 0,
    });
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const nfr = requirements.find((r) => r.type === 'NFR');
    const fn = requirements.find((r) => r.type === 'FUNCTION');
    expect(nfr?.links.filter((l) => l.type === 'RELATES_TO')).toHaveLength(1);
    expect(fn?.links.filter((l) => l.type === 'RELATES_TO')).toHaveLength(1);
  });

  it('T15: re-run completes a MISSING RELATES_TO for a skipped existing NFR', async () => {
    // Both requirements pre-exist WITHOUT the link (e.g. a crash between
    // requirements and links on a previous run).
    const reqService = createRequirementService(ctx, PROJECT);
    const fn = await reqService.create({
      type: 'FUNCTION',
      name: 'Поиск',
      criticality: 'MEDIUM',
      implemented: true,
    });
    await reqService.create({
      type: 'NFR',
      name: 'SLA поиска',
      criticality: 'MEDIUM',
      implemented: true,
    });
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Поиск', source: 'search.md § Поиск' }),
        record({
          type: 'NFR',
          name: 'SLA поиска',
          source: 'search.md § SLA',
          relatedFunctions: ['Поиск'],
        }),
      ]),
      structure([{ name: 'Поиск' }, { type: 'NFR', name: 'SLA поиска' }]),
    ]);
    const service = makeService(client);
    const jobId = await runToEnd(service, await writeZip({ 'search.md': 'Поиск.' }));
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.skippedExisting).toBe(2);
    expect(view.result?.relatesLinks).toBe(1);
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    const nfr = requirements.find((r) => r.type === 'NFR');
    expect(nfr?.links).toEqual([{ type: 'RELATES_TO', targetSlug: fn.slug }]);
  });

  it('T15 hypothesis: cross RELATES_TO over CHILD_OF hierarchies never trips the cycle check', async () => {
    // assertNoCycle (LinkService.ts:76) runs for ALL link types, but core
    // integrity.ts returns early for RELATES_TO (symmetric association, no
    // ordering). This test pins that: 2 FTs under a common root + 2 NFRs each
    // related to BOTH FTs (cross) → 4 RELATES_TO links, zero CYCLE warns.
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Корень', source: 'a.md § Корень' }),
        record({ name: 'Поиск', source: 'a.md § Поиск' }),
        record({ name: 'Экспорт', source: 'a.md § Экспорт' }),
        record({
          type: 'NFR',
          name: 'Н1',
          source: 'a.md § Н1',
          relatedFunctions: ['Поиск', 'Экспорт'],
        }),
        record({
          type: 'NFR',
          name: 'Н2',
          source: 'a.md § Н2',
          relatedFunctions: ['Поиск', 'Экспорт'],
        }),
      ]),
      structure([
        { name: 'Корень' },
        { name: 'Поиск', parentName: 'Корень' },
        { name: 'Экспорт', parentName: 'Корень' },
        { type: 'NFR', name: 'Н1' },
        { type: 'NFR', name: 'Н2' },
      ]),
    ]);
    const service = makeService(client);
    const jobId = await runToEnd(service, await writeZip({ 'a.md': 'Документ.' }));
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.links).toBe(2); // CHILD_OF
    expect(view.result?.relatesLinks).toBe(4); // full cross NFR→FT
    expect(view.log.some((l) => l.message.includes('CYCLE'))).toBe(false);
    expect(view.log.some((l) => l.message.includes('не создана'))).toBe(false);
  });

  it('T15: a DomainError from RELATES_TO create → warn, job not failed', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Поиск', source: 'a.md § Поиск' }),
        record({
          type: 'NFR',
          name: 'Н1',
          source: 'a.md § Н1',
          relatedFunctions: ['Поиск'],
        }),
      ]),
      structure([{ name: 'Поиск' }, { type: 'NFR', name: 'Н1' }]),
    ]);
    const service = makeService(
      client,
      {},
      {
        makeLinkService: (pid) => {
          const real = createLinkService(ctx, pid);
          return {
            create: (input: { sourceSlug: string; type: string; targetSlug: string }) => {
              if (input.type === 'RELATES_TO') throw new CycleError(['a', 'b', 'a']);
              return real.create(input as Parameters<typeof real.create>[0]);
            },
            remove: real.remove.bind(real),
          } as unknown as ReturnType<typeof createLinkService>;
        },
      },
    );
    const jobId = await runToEnd(service, await writeZip({ 'a.md': 'Документ.' }));
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.relatesLinks).toBe(0);
    expect(
      view.log.some(
        (l) =>
          l.level === 'warn' &&
          l.message.startsWith('Связь RELATES_TO «Н1» → «Поиск» не создана (CYCLE):'),
      ),
    ).toBe(true);
  });

  it('T15: cancel between RELATES_TO links → cancelled with partial relatesLinks in the summary', async () => {
    const cancelTarget: { service?: AiImportService; jobId?: string } = {};
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'Ф1', source: 'a.md § Ф1' }),
        record({ name: 'Ф2', source: 'a.md § Ф2' }),
        record({
          type: 'NFR',
          name: 'Н1',
          source: 'a.md § Н1',
          relatedFunctions: ['Ф1', 'Ф2'],
        }),
      ]),
      structure([{ name: 'Ф1' }, { name: 'Ф2' }, { type: 'NFR', name: 'Н1' }]),
    ]);
    const service = makeService(
      client,
      {},
      {
        makeLinkService: (pid) => {
          const real = createLinkService(ctx, pid);
          return {
            create: async (input: { sourceSlug: string; type: string; targetSlug: string }) => {
              await real.create(input as Parameters<typeof real.create>[0]);
              // Request cancellation right after the FIRST RELATES_TO succeeds.
              if (input.type === 'RELATES_TO' && cancelTarget.service && cancelTarget.jobId) {
                cancelTarget.service.cancel(cancelTarget.jobId);
              }
            },
            remove: real.remove.bind(real),
          } as unknown as ReturnType<typeof createLinkService>;
        },
      },
    );
    cancelTarget.service = service;
    const { jobId } = await service.start(PROJECT, await writeZip({ 'a.md': 'Документ.' }));
    cancelTarget.jobId = jobId;
    await service.waitForCompletion(jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('cancelled');
    expect(view.result?.relatesLinks).toBe(1);
    expect(
      view.log.some(
        (l) =>
          l.level === 'warn' &&
          l.message ===
            'Автоматизация остановлена пользователем. Создано к моменту остановки: ' +
              'ФТ 2, НФТ 1, связей 0, связей НФТ→ФТ: 1.',
      ),
    ).toBe(true);
  });

  it('todo_16 Ф1–Ф3: logs archive size, file preparation and a pre-call line before EVERY AI request', async () => {
    const client = scriptedClient([
      JSON.stringify([record()]),
      JSON.stringify([record({ type: 'NFR', name: 'Время отклика', source: 'perf.md § SLA' })]),
      structure([{ name: 'Вход по паролю' }, { type: 'NFR', name: 'Время отклика' }]),
    ]);
    const service = makeService(client);
    const archive = await writeZip({
      'auth.md': '# Вход\nПользователь входит по email и паролю.',
      'perf.md': '# SLA\nОтклик до 200 мс.',
    });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    const messages = view.log.map((l) => l.message);
    // Ф1: размер архива виден перед распаковкой.
    expect(messages.some((m) => /^Распаковка архива \(.+ МБ\)…$/.test(m))).toBe(true);
    // Ф2: чтение/нарезка файлов не «немая».
    expect(messages).toContain('Чтение и подготовка файлов документации…');
    // Ф3: pre-call строка для каждого фрагмента analyze…
    expect(messages).toContain('Файл auth.md (фрагмент 1/1): запрос к модели…');
    expect(messages).toContain('Файл perf.md (фрагмент 1/1): запрос к модели…');
    // …и для каждого батча structure.
    expect(messages).toContain('Структура: батч 1/1 — запрос к модели…');
    // The pre-call line precedes the per-chunk result line (user sees «going», then «done»).
    const preIdx = messages.indexOf('Файл auth.md (фрагмент 1/1): запрос к модели…');
    const resIdx = messages.findIndex((m) =>
      m.startsWith('Файл auth.md (фрагмент 1/1): извлечено'),
    );
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(resIdx).toBeGreaterThan(preIdx);
    // And the reading line precedes the first pre-call line.
    expect(messages.indexOf('Чтение и подготовка файлов документации…')).toBeLessThan(preIdx);
  });

  it('todo_16 Ф3: every structure batch gets its own pre-call line', async () => {
    const client = scriptedClient([
      JSON.stringify([
        record({ name: 'А', source: 'a.md § А' }),
        record({ name: 'Б', source: 'a.md § Б' }),
      ]),
      structure([{ name: 'А' }]),
      structure([{ name: 'Б' }]),
    ]);
    const service = makeService(client, { structureBatch: 1 });
    const archive = await writeZip({ 'a.md': 'Два требования.' });

    const jobId = await runToEnd(service, archive);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    const messages = view.log.map((l) => l.message);
    expect(messages).toContain('Структура: батч 1/2 — запрос к модели…');
    expect(messages).toContain('Структура: батч 2/2 — запрос к модели…');
  });

  it('todo_16 Ф1: progress reaches 2 during unpack — a corrupt archive fails at progress=2 with the size line logged', async () => {
    const client = scriptedClient(['[]']);
    const service = makeService(client);
    const bogus = path.join(os.tmpdir(), `po-test-obs-${randomBytes(6).toString('hex')}.zip`);
    await fs.writeFile(bogus, 'совсем не архив');

    const jobId = await runToEnd(service, bogus);
    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.stage).toBe('unpack');
    expect(view.progress).toBe(2);
    expect(view.log.some((l) => /^Распаковка архива \(.+ МБ\)…$/.test(l.message))).toBe(true);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).not.toHaveBeenCalled();
  });
});

describe('T14 B6 breakParentCycles (pure, deterministic)', () => {
  it('breaks a 2-cycle at the node whose edge closes the cycle; input is not mutated', () => {
    const parents = new Map([
      ['FUNCTION:а', 'FUNCTION:б'],
      ['FUNCTION:б', 'FUNCTION:а'],
    ]);
    expect(breakParentCycles(parents)).toEqual(['FUNCTION:б']);
    expect(parents.size).toBe(2); // pure: the caller's map is untouched
  });

  it('breaks a longer cycle reached through a chain', () => {
    const parents = new Map([
      ['FUNCTION:x', 'FUNCTION:a'],
      ['FUNCTION:a', 'FUNCTION:b'],
      ['FUNCTION:b', 'FUNCTION:c'],
      ['FUNCTION:c', 'FUNCTION:a'],
    ]);
    // Walk from x: x→a→b→c→a — the edge c→a closes the cycle.
    expect(breakParentCycles(parents)).toEqual(['FUNCTION:c']);
  });

  it('removes a self-parent edge', () => {
    expect(breakParentCycles(new Map([['NFR:x', 'NFR:x']]))).toEqual(['NFR:x']);
  });

  it('returns [] for an acyclic forest', () => {
    const parents = new Map([
      ['FUNCTION:b', 'FUNCTION:a'],
      ['FUNCTION:c', 'FUNCTION:b'],
      ['FUNCTION:d', 'FUNCTION:a'],
    ]);
    expect(breakParentCycles(parents)).toEqual([]);
  });

  it('breaks several independent cycles in insertion order', () => {
    const parents = new Map([
      ['FUNCTION:а', 'FUNCTION:б'],
      ['FUNCTION:б', 'FUNCTION:а'],
      ['NFR:x', 'NFR:y'],
      ['NFR:y', 'NFR:x'],
    ]);
    expect(breakParentCycles(parents)).toEqual(['FUNCTION:б', 'NFR:y']);
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
