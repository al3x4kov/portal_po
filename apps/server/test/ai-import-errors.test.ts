import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { AiImportJobs } from '../src/services/AiImportJobs.js';
import { AI_IMPORT_HINT_ARCHIVE, AiImportService } from '../src/services/AiImportService.js';
import type { AiClient } from '../src/services/AiHubService.js';
import {
  createProjectRepo,
  createProjectService,
  createRequirementService,
  createLinkService,
  type ServiceContext,
} from '../src/factory.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';
import { approveDocsReview } from './aiImportKit.js';

const SECRET = 'sk-import-secret';
const PROJECT = 'Demo';

/** Build a zip on disk from a name→content map; returns the archive path. */
async function writeZip(files: Record<string, string | Buffer>): Promise<string> {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  }
  const file = path.join(os.tmpdir(), `po-test-ai-err-${randomBytes(8).toString('hex')}.zip`);
  await fs.writeFile(file, zip.toBuffer());
  return file;
}

/** An AiClient that always answers with the given content. */
function fixedClient(content: string): AiClient {
  return {
    models: { list: vi.fn(async () => ({ data: [] })) },
    chat: {
      completions: {
        create: vi.fn(async () => ({ choices: [{ message: { content } }] })),
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

describe('ARC-T2 · AiImportService error branches (populate/link/unpack)', () => {
  let root: string;
  let ctx: ServiceContext;
  let configRepo: AiConfigRepo;
  let jobs: AiImportJobs;

  function makeService(client: AiClient): AiImportService {
    const projectRepo = createProjectRepo(ctx);
    return new AiImportService({
      now: fixedNow,
      jobs,
      configRepo,
      makeAiClient: () => client,
      makeRequirementService: (pid) => createRequirementService(ctx, pid),
      makeLinkService: (pid) => createLinkService(ctx, pid),
      projectExists: (pid) => projectRepo.exists(pid),
    });
  }

  async function runToEnd(service: AiImportService, archive: string): Promise<string> {
    const { jobId } = await service.start(PROJECT, archive);
    await service.waitForCompletion(jobId);
    // Двухзонная выверка: approve both review gates keeping every item (no-op
    // when the job failed before the gate) — reproduces the pre-review outcome.
    await approveDocsReview(service, jobId);
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

  it('a record with a targetYear outside the create contract is dropped at parsing with a warn; job still reaches done', async () => {
    // The AI extraction schema reuses the create-contract bound (min 2020), so
    // targetYear=2019 is dropped during parsing (schema-invalid record) and
    // never reaches populate/create at all.
    const client = fixedClient(
      JSON.stringify([
        record({ name: 'Валидное', source: 'a.md § 1' }),
        record({
          name: 'Просроченное',
          source: 'a.md § 2',
          implemented: false,
          targetQuarter: 'Q1',
          targetYear: 2019,
        }),
      ]),
    );
    const service = makeService(client);
    const jobId = await runToEnd(service, await writeZip({ 'a.md': 'Документация.' }));

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.stage).toBe('done');
    expect(view.progress).toBe(100);
    // Counters: only the valid record was created; nothing was double-counted.
    expect(view.result).toEqual({
      createdFunctions: 1,
      createdNfrs: 0,
      skippedExisting: 0,
      links: 0,
      relatesLinks: 0,
      extractedFunctions: 1,
      extractedNfrs: 0,
    });
    const warn = view.log.find(
      (l) => l.level === 'warn' && l.message.includes('не соответствующих схеме'),
    );
    expect(warn?.message).toContain('отброшено записей, не соответствующих схеме: 1');
    // The invalid record produced no create() attempt → no populate warn.
    expect(view.log.some((l) => l.message.includes('не создано'))).toBe(false);

    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    expect(requirements.map((r) => r.name)).toEqual(['Валидное']);
  });

  it('mutual parents (cycle) are broken BEFORE populate with a warn, import does not fail', async () => {
    // fixedClient answers the structure stage with the same JSON: the records
    // carry type/name/parentName, so they parse as structure nodes А→Б, Б→А.
    const client = fixedClient(
      JSON.stringify([
        record({ name: 'А', parentName: 'Б', source: 'a.md § А' }),
        record({ name: 'Б', parentName: 'А', source: 'a.md § Б' }),
      ]),
    );
    const service = makeService(client);
    const jobId = await runToEnd(service, await writeZip({ 'a.md': 'Иерархия.' }));

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    // Task 14 B6: the cycle is broken deterministically before populate —
    // no CYCLE error ever reaches the link layer; the surviving edge is created.
    expect(view.result).toEqual({
      createdFunctions: 2,
      createdNfrs: 0,
      skippedExisting: 0,
      links: 1,
      relatesLinks: 0,
      extractedFunctions: 2,
      extractedNfrs: 0,
    });
    expect(
      view.log.some(
        (l) => l.level === 'warn' && l.message.includes('Цикл разорван: «Б» становится корневым'),
      ),
    ).toBe(true);
    expect(view.log.some((l) => l.message.includes('CYCLE'))).toBe(false);

    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    expect(requirements).toHaveLength(2);
    const totalLinks = requirements.reduce((n, r) => n + r.links.length, 0);
    expect(totalLinks).toBe(2); // one relationship stored as a mutually-inverse pair
  });

  it('an archive with more doc files than the limit fails the job with the archive hint', async () => {
    // todo_20: the text-file limit rose to 2000 (Н1) — exceed the NEW limit.
    const files: Record<string, string> = {};
    for (let i = 0; i < 2001; i += 1) files[`doc-${String(i).padStart(4, '0')}.md`] = `Файл ${i}.`;
    const client = fixedClient('[]');
    const service = makeService(client);
    const jobId = await runToEnd(service, await writeZip(files));

    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.stage).toBe('unpack');
    expect(view.error?.message).toContain('Не удалось распаковать архив');
    expect(view.error?.message).toContain('too many documentation files');
    expect(view.error?.hint).toBe(AI_IMPORT_HINT_ARCHIVE);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).not.toHaveBeenCalled();
    // 2001 files + распаковка/уборка под полным прогоном сюиты — дольше 5с.
  }, 20000);

  it('doc files that are all empty fail analyze with «извлекать нечего»', async () => {
    const client = fixedClient('[]');
    const service = makeService(client);
    const jobId = await runToEnd(service, await writeZip({ 'empty.md': '', 'blank.txt': '' }));

    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.error?.message).toContain('пусты');
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).not.toHaveBeenCalled();
  });

  it('records violating the extraction schema are dropped with a warn (droppedInvalid)', async () => {
    // description missing → fails aiExtractedRequirementSchema, the rest is kept.
    const invalid = record({ name: 'Без описания', source: 'a.md § X' });
    delete (invalid as Record<string, unknown>).description;
    const client = fixedClient(
      JSON.stringify([record({ name: 'Годное', source: 'a.md § 1' }), invalid]),
    );
    const service = makeService(client);
    const jobId = await runToEnd(service, await writeZip({ 'a.md': 'Текст.' }));

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.createdFunctions).toBe(1);
    expect(
      view.log.some((l) => l.level === 'warn' && l.message.includes('не соответствующих схеме')),
    ).toBe(true);
  });

  it('an archive without doc files reports totalEntries and the extension breakdown', async () => {
    const service = makeService(fixedClient('[]'));
    const archive = await writeZip({
      'site/a.html': '<html>a</html>',
      'site/b.html': '<html>b</html>',
      'img/logo.png': Buffer.from([1, 2, 3]),
    });
    const jobId = await runToEnd(service, archive);

    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.stage).toBe('unpack');
    // todo_20: the doc-extension list now includes structured sources.
    expect(view.error?.message).toContain(
      'В архиве нет файлов документации (.md/.markdown/.txt/.json/.yaml/.yml)',
    );
    expect(view.error?.message).toContain('В архиве 3 файлов');
    expect(view.error?.message).toContain('.html — 2');
    expect(view.error?.message).toContain('.png — 1');
  });

  it('an empty archive fails with «Архив пуст»', async () => {
    const service = makeService(fixedClient('[]'));
    const file = path.join(os.tmpdir(), `po-test-empty-${randomBytes(6).toString('hex')}.zip`);
    await fs.writeFile(file, new AdmZip().toBuffer());
    const jobId = await runToEnd(service, file);

    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.stage).toBe('unpack');
    expect(view.error?.message).toContain('Архив пуст');
  });

  it('unsafe (zip-slip) entries are counted in the no-docs diagnostic', async () => {
    // adm-zip sanitizes '../' in addFile(): patch a same-length placeholder
    // in the raw bytes (same trick as the unpack zip-slip test).
    const hex = randomBytes(4).toString('hex');
    const placeholder = `AA/po-un-${hex}.md`;
    const zip = new AdmZip();
    zip.addFile('page.html', Buffer.from('<html>', 'utf8'));
    zip.addFile(placeholder, Buffer.from('evil', 'utf8'));
    const raw = zip.toBuffer();
    const from = Buffer.from(placeholder);
    const to = Buffer.from(`../po-un-${hex}.md`);
    for (let idx = raw.indexOf(from); idx !== -1; idx = raw.indexOf(from)) to.copy(raw, idx);
    const file = path.join(os.tmpdir(), `po-test-unsafe-${randomBytes(6).toString('hex')}.zip`);
    await fs.writeFile(file, raw);

    const service = makeService(fixedClient('[]'));
    const jobId = await runToEnd(service, file);
    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.error?.message).toContain('В архиве нет файлов документации');
    expect(view.error?.message).toContain(
      'Пропущено небезопасных записей: 1 (пути вне каталога распаковки)',
    );
  });

  // ── Разбор NET-02: технические детали запроса/ответа в скачиваемом логе ────

  it('NET-02: лог содержит «что отправлялось» и «какой вернулся ответ», без API-ключа', async () => {
    // «Connection error.» SDK прячет реальную причину в cause — как в проде.
    const cause = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:443 key=${SECRET}`), {
      code: 'ECONNREFUSED',
    });
    const transport = Object.assign(new Error('Connection error.'), { cause });
    const client: AiClient = {
      models: { list: vi.fn(async () => ({ data: [] })) },
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw transport;
          }),
        },
      },
    };
    const projectRepo = createProjectRepo(ctx);
    const service = new AiImportService({
      now: fixedNow,
      jobs,
      configRepo,
      makeAiClient: () => client,
      makeRequirementService: (pid) => createRequirementService(ctx, pid),
      makeLinkService: (pid) => createLinkService(ctx, pid),
      projectExists: (pid) => projectRepo.exists(pid),
      sleep: async () => {}, // сетевые ретраи мгновенны в тесте
      random: () => 0,
    });
    const jobId = await runToEnd(service, await writeZip({ 'a.md': 'Документация о входе.' }));

    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.error?.code).toBe('NET-02');

    // «Что отправлялось»: endpoint, модель, параметры и превью сообщений.
    const reqLine = view.log.find((l) => l.message.includes('Технические детали запроса'));
    expect(reqLine?.level).toBe('error');
    expect(reqLine?.message).toContain('/chat/completions');
    expect(reqLine?.message).toContain('модель: Qwen-Coder-Next');
    expect(reqLine?.message).toContain('max_tokens');
    expect(reqLine?.message).toContain('последнее сообщение');

    // «Какой вернулся ответ»: цепочка причин до транспортного кода.
    const resLine = view.log.find((l) => l.message.includes('Технические детали ответа'));
    expect(resLine?.level).toBe('error');
    expect(resLine?.message).toContain('ECONNREFUSED');
    expect(resLine?.message).toContain('Connection error.');

    // Ключ не утекает ни в одну строку скачиваемого лога.
    const logText = await service.getLogText(jobId);
    expect(logText).not.toContain(SECRET);
    expect(logText).toContain('Технические детали запроса');
  });

  it('«Задержка при отправке запросов»: пауза выдерживается после каждого вызова хаба', async () => {
    await configRepo.update({ requestDelaySec: 9 });
    const sleeps: number[] = [];
    const client = fixedClient('[]');
    const projectRepo = createProjectRepo(ctx);
    const service = new AiImportService({
      now: fixedNow,
      jobs,
      configRepo,
      makeAiClient: () => client,
      makeRequirementService: (pid) => createRequirementService(ctx, pid),
      makeLinkService: (pid) => createLinkService(ctx, pid),
      projectExists: (pid) => projectRepo.exists(pid),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
    });
    const jobId = await runToEnd(service, await writeZip({ 'a.md': 'Текст.' }));

    // Каждый фактический запрос к хабу закончился принудительной паузой 9 с.
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create.mock.calls.length).toBeGreaterThan(0);
    expect(sleeps.filter((ms) => ms === 9000).length).toBeGreaterThanOrEqual(
      create.mock.calls.length,
    );
    // Прогон при этом завершился (задержка не ломает pipeline).
    expect(['succeeded', 'failed']).toContain(service.getView(jobId).status);
  });

  it('a corrupt tar.gz (gzip magic + garbage) fails the unpack stage with a readable message', async () => {
    const file = path.join(os.tmpdir(), `po-test-corrupt-${randomBytes(6).toString('hex')}.tar.gz`);
    await fs.writeFile(file, Buffer.concat([Buffer.from([0x1f, 0x8b]), randomBytes(128)]));
    const service = makeService(fixedClient('[]'));
    const jobId = await runToEnd(service, file);

    const view = service.getView(jobId);
    expect(view.status).toBe('failed');
    expect(view.stage).toBe('unpack');
    expect(view.error?.message).toContain('Corrupt tar.gz');
    expect(view.error?.hint).toBe(AI_IMPORT_HINT_ARCHIVE);
  });
});
