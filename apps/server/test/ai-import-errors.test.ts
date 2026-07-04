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

  it('an invalid CHILD_OF (mutual parents → cycle) is logged as warn, import does not fail', async () => {
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
    // Both requirements exist; only the first CHILD_OF was created, the second
    // would close a cycle and is rejected by the shared core rules.
    expect(view.result).toEqual({
      createdFunctions: 2,
      createdNfrs: 0,
      skippedExisting: 0,
      links: 1,
    });
    const warn = view.log.find((l) => l.level === 'warn' && l.message.includes('не создана'));
    expect(warn?.message).toContain('CYCLE');

    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    expect(requirements).toHaveLength(2);
    const totalLinks = requirements.reduce((n, r) => n + r.links.length, 0);
    expect(totalLinks).toBe(2); // one relationship stored as a mutually-inverse pair
  });

  it('an archive with more doc files than the limit fails the job with the archive hint', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 501; i += 1) files[`doc-${String(i).padStart(3, '0')}.md`] = `Файл ${i}.`;
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
  });

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
