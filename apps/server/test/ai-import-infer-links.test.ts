import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveModelPreset, type Requirement } from '@po/core';
import { AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { AiImportJobs } from '../src/services/AiImportJobs.js';
import { AiImportService } from '../src/services/AiImportService.js';
import type { AiChatCompletionParams, AiClient } from '../src/services/AiHubService.js';
import {
  AI_IMPORT_RELATE_DESC_CHARS,
  buildRelateMessages,
  parseRelateResponse,
} from '../src/services/aiImportPrompt.js';
import {
  createLinkService,
  createProjectRepo,
  createProjectService,
  createRequirementService,
  type ServiceContext,
} from '../src/factory.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

const SECRET = 'sk-import-secret';
const PROJECT = 'Demo';

/** Build a zip on disk from a name→content map; returns the archive path. */
async function writeZip(files: Record<string, string>): Promise<string> {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  const file = path.join(os.tmpdir(), `po-test-ai-zip-${randomBytes(8).toString('hex')}.zip`);
  await fs.writeFile(file, zip.toBuffer());
  return file;
}

const FN = {
  type: 'FUNCTION',
  name: 'Вход по паролю',
  description: 'Пользователь входит по email и паролю.',
  source: 'docs.md § Вход',
};
const NFR = {
  type: 'NFR',
  name: 'Время отклика',
  description: 'Отклик до 200 мс.',
  source: 'docs.md § SLA',
};
const EXTRACTION = JSON.stringify([FN, NFR]);
const STRUCTURE = JSON.stringify([
  { type: 'FUNCTION', name: FN.name, parentName: null },
  { type: 'NFR', name: NFR.name, parentName: null },
]);

/** One scripted call the responder sees: 0 = extraction, 1 = structure, 2 = relate. */
interface RespondedCall {
  index: number;
  user: string;
  params: AiChatCompletionParams;
}
type Responder = (call: RespondedCall) => string | Error;

/** AiClient whose chat answers are produced per call by `respond`. */
function respondingClient(respond: Responder): AiClient {
  let index = 0;
  return {
    models: { list: vi.fn(async () => ({ data: [] })) },
    chat: {
      completions: {
        create: vi.fn(async (params: AiChatCompletionParams) => {
          const user = params.messages.find((m) => m.role === 'user')?.content ?? '';
          const answer = respond({ index: index++, user, params });
          if (answer instanceof Error) throw answer;
          return { choices: [{ message: { content: answer } }] };
        }),
      },
    },
  };
}

/**
 * Extract the `id → …` mapping the relate step sends to the hub: every listed
 * requirement is one `id\tname\t…` line, so the map is keyed by NAME.
 */
function idsByName(user: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of user.split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 2 && parts[0] && parts[1]) map.set(parts[1], parts[0]);
  }
  return map;
}

describe('todo_16 B2: optional inferLinks step (relate ФТ↔НФТ, mock AI client)', () => {
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

  async function runImport(
    client: AiClient,
    opts: { inferLinks?: boolean } = {},
  ): Promise<{ service: AiImportService; jobId: string }> {
    const service = makeService(client);
    const archive = await writeZip({ 'docs.md': '# Вход\nВход по email.\n# SLA\nОтклик 200 мс.' });
    const { jobId } = await service.start(PROJECT, archive, undefined, opts.inferLinks);
    await service.waitForCompletion(jobId);
    return { service, jobId };
  }

  async function listRequirements(): Promise<Requirement[]> {
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    return requirements;
  }

  function relatesOf(req: Requirement | undefined): string[] {
    return (req?.links ?? []).filter((l) => l.type === 'RELATES_TO').map((l) => l.targetSlug);
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

  it('flag omitted (default false): pipeline unchanged — no relate call, no relate field', async () => {
    const client = respondingClient(({ index }) => {
      if (index === 0) return EXTRACTION;
      if (index === 1) return STRUCTURE;
      return new Error('unexpected extra AI call');
    });
    const { service, jobId } = await runImport(client);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.relate).toBeUndefined();
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
    const reqs = await listRequirements();
    expect(reqs).toHaveLength(2);
    expect(reqs.flatMap((r) => relatesOf(r))).toEqual([]);
  });

  it('flag on: valid pair → RELATES_TO created; step runs after populate and before done; no requirements added', async () => {
    const holder: { service?: AiImportService; jobId?: string } = {};
    let stageAtRelate = '';
    let statusAtRelate = '';
    let relateAtRelate: unknown;
    let relateMaxTokens = 0;
    const client = respondingClient(({ index, user, params }) => {
      if (index === 0) return EXTRACTION;
      if (index === 1) return STRUCTURE;
      // The relate call: prove the step runs BEFORE the last pipeline step
      // ('done') and AFTER populate — the created slugs are already listed.
      relateMaxTokens = params.max_tokens;
      const view = holder.service!.getView(holder.jobId!);
      stageAtRelate = view.stage;
      statusAtRelate = view.status;
      relateAtRelate = view.relate;
      const ids = idsByName(user);
      return JSON.stringify([{ nfr: ids.get(NFR.name), function: ids.get(FN.name) }]);
    });
    const service = makeService(client);
    holder.service = service;
    const archive = await writeZip({ 'docs.md': 'Документация.' });
    const { jobId } = await service.start(PROJECT, archive, undefined, true);
    holder.jobId = jobId;
    await service.waitForCompletion(jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.stage).toBe('done');
    expect(view.progress).toBe(100);
    // The step is visible in the job status while it runs (frontend contract).
    expect(statusAtRelate).toBe('running');
    expect(stageAtRelate).toBe('populate');
    expect(relateAtRelate).toEqual({ status: 'running', created: 0 });
    // todo_18: the relate call sends the model's full preset budget as
    // max_tokens ('Qwen-Coder-Next' has no dedicated preset → generic 4000).
    expect(relateMaxTokens).toBe(resolveModelPreset('Qwen-Coder-Next').maxOutputTokens);
    // Final step outcome.
    expect(view.relate).toEqual({ status: 'done', created: 1 });
    // The step never creates/changes requirements; existing counters untouched.
    expect(view.result).toEqual({
      extractedFunctions: 1,
      extractedNfrs: 1,
      createdFunctions: 1,
      createdNfrs: 1,
      skippedExisting: 0,
      links: 0,
      relatesLinks: 0,
    });
    const reqs = await listRequirements();
    expect(reqs).toHaveLength(2);
    const fn = reqs.find((r) => r.type === 'FUNCTION');
    const nfr = reqs.find((r) => r.type === 'NFR');
    expect(relatesOf(nfr)).toEqual([fn!.slug]);
    expect(relatesOf(fn)).toEqual([nfr!.slug]); // symmetric inverse half
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('todo_16 Ф3/Ф5: the pre-call log line AND relate.status=running are visible BEFORE the relate AI call completes', async () => {
    const holder: { service?: AiImportService; jobId?: string } = {};
    let preCallLineSeen = false;
    let relateStatusAtCall: string | undefined;
    const client = respondingClient(({ index, user }) => {
      if (index === 0) return EXTRACTION;
      if (index === 1) return STRUCTURE;
      // Inside the relate AI call: the poller must already see both signals.
      const view = holder.service!.getView(holder.jobId!);
      preCallLineSeen = view.log.some((l) => l.message === 'Связи ФТ↔НФТ: запрос к модели…');
      relateStatusAtCall = view.relate?.status;
      const ids = idsByName(user);
      return JSON.stringify([{ nfr: ids.get(NFR.name), function: ids.get(FN.name) }]);
    });
    const service = makeService(client);
    holder.service = service;
    const archive = await writeZip({ 'docs.md': 'Документация.' });
    const { jobId } = await service.start(PROJECT, archive, undefined, true);
    holder.jobId = jobId;
    await service.waitForCompletion(jobId);

    expect(service.getView(jobId).status).toBe('succeeded');
    expect(preCallLineSeen).toBe(true);
    expect(relateStatusAtCall).toBe('running');
  });

  it('fabricated ids and wrong-type (swapped) pairs are dropped', async () => {
    const client = respondingClient(({ index, user }) => {
      if (index === 0) return EXTRACTION;
      if (index === 1) return STRUCTURE;
      const ids = idsByName(user);
      const nfr = ids.get(NFR.name)!;
      const fn = ids.get(FN.name)!;
      return JSON.stringify([
        { nfr, function: fn }, // valid
        { nfr: 'no-such-id', function: fn }, // fabricated NFR id
        { nfr, function: 'ghost-id' }, // fabricated FUNCTION id
        { nfr: fn, function: nfr }, // swapped types → both ids unknown in their role
      ]);
    });
    const { service, jobId } = await runImport(client, { inferLinks: true });
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.relate).toEqual({ status: 'done', created: 1 });
    expect(view.log.some((l) => l.level === 'warn' && l.message.includes('выдуман'))).toBe(true);
    const reqs = await listRequirements();
    const nfr = reqs.find((r) => r.type === 'NFR');
    expect(relatesOf(nfr)).toHaveLength(1);
  });

  it('self-link pairs are dropped (core graph rule)', async () => {
    const client = respondingClient(({ index, user }) => {
      if (index === 0) return EXTRACTION;
      if (index === 1) return STRUCTURE;
      const ids = idsByName(user);
      const nfr = ids.get(NFR.name)!;
      const fn = ids.get(FN.name)!;
      return JSON.stringify([
        { nfr, function: nfr }, // self-link
        { nfr, function: fn }, // valid
      ]);
    });
    const { service, jobId } = await runImport(client, { inferLinks: true });
    const view = service.getView(jobId);
    expect(view.relate).toEqual({ status: 'done', created: 1 });
    const reqs = await listRequirements();
    const nfr = reqs.find((r) => r.type === 'NFR');
    expect(relatesOf(nfr)).toHaveLength(1);
    expect(relatesOf(nfr)).not.toContain(nfr!.slug);
  });

  it('duplicate pairs in the answer create exactly one link', async () => {
    const client = respondingClient(({ index, user }) => {
      if (index === 0) return EXTRACTION;
      if (index === 1) return STRUCTURE;
      const ids = idsByName(user);
      const pair = { nfr: ids.get(NFR.name)!, function: ids.get(FN.name)! };
      return JSON.stringify([pair, pair, { ...pair }]);
    });
    const { service, jobId } = await runImport(client, { inferLinks: true });
    const view = service.getView(jobId);
    expect(view.relate).toEqual({ status: 'done', created: 1 });
    const reqs = await listRequirements();
    expect(relatesOf(reqs.find((r) => r.type === 'NFR'))).toHaveLength(1);
  });

  it('existing RELATES_TO from explicit mentions (feature 6b3327e) is not duplicated', async () => {
    // Extraction carries relatedFunctions → populate itself creates the link.
    const extraction = JSON.stringify([FN, { ...NFR, relatedFunctions: [FN.name] }]);
    const client = respondingClient(({ index, user }) => {
      if (index === 0) return extraction;
      if (index === 1) return STRUCTURE;
      const ids = idsByName(user);
      return JSON.stringify([{ nfr: ids.get(NFR.name), function: ids.get(FN.name) }]);
    });
    const { service, jobId } = await runImport(client, { inferLinks: true });
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    // The explicit-mention link is counted by the OLD step, not the new one.
    expect(view.result?.relatesLinks).toBe(1);
    expect(view.relate).toEqual({ status: 'done', created: 0 });
    const reqs = await listRequirements();
    expect(relatesOf(reqs.find((r) => r.type === 'NFR'))).toHaveLength(1);
  });

  it('AI error in the relate step does NOT fail the import — step is skipped, key never leaks', async () => {
    const client = respondingClient(({ index }) => {
      if (index === 0) return EXTRACTION;
      if (index === 1) return STRUCTURE;
      return new Error(`boom ${SECRET}`);
    });
    const { service, jobId } = await runImport(client, { inferLinks: true });
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.stage).toBe('done');
    expect(view.progress).toBe(100);
    expect(view.relate).toEqual({ status: 'skipped', created: 0 });
    const warn = view.log.find((l) => l.level === 'warn' && l.message.includes('boom'));
    expect(warn).toBeDefined();
    expect(warn!.message).not.toContain(SECRET);
    expect(warn!.message).toContain('***');
    // Requirements from the main pipeline are intact.
    expect(await listRequirements()).toHaveLength(2);
  });

  it('unparsable relate answer after all attempts → step skipped, import succeeds', async () => {
    const client = respondingClient(({ index }) => {
      if (index === 0) return EXTRACTION;
      if (index === 1) return STRUCTURE;
      return 'это не json';
    });
    const { service, jobId } = await runImport(client, { inferLinks: true });
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.relate).toEqual({ status: 'skipped', created: 0 });
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(5); // extraction + structure + 3 relate attempts
  });

  it('nothing to relate (no NFRs in the project) → no AI call, step done with 0', async () => {
    const client = respondingClient(({ index }) => {
      if (index === 0) return JSON.stringify([FN]);
      if (index === 1)
        return JSON.stringify([{ type: 'FUNCTION', name: FN.name, parentName: null }]);
      return new Error('relate must not call the hub when a side is empty');
    });
    const { service, jobId } = await runImport(client, { inferLinks: true });
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.relate).toEqual({ status: 'done', created: 0 });
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('cancel during the relate step is honoured before links are written', async () => {
    const holder: { service?: AiImportService; jobId?: string } = {};
    const client = respondingClient(({ index, user }) => {
      if (index === 0) return EXTRACTION;
      if (index === 1) return STRUCTURE;
      holder.service!.cancel(holder.jobId!);
      const ids = idsByName(user);
      return JSON.stringify([{ nfr: ids.get(NFR.name), function: ids.get(FN.name) }]);
    });
    const service = makeService(client);
    holder.service = service;
    const archive = await writeZip({ 'docs.md': 'Документация.' });
    const { jobId } = await service.start(PROJECT, archive, undefined, true);
    holder.jobId = jobId;
    await service.waitForCompletion(jobId);

    const view = service.getView(jobId);
    expect(view.status).toBe('cancelled');
    expect(view.relate).toEqual({ status: 'skipped', created: 0 });
    const reqs = await listRequirements();
    expect(reqs.flatMap((r) => relatesOf(r))).toEqual([]);
  });
});

describe('todo_16 B2: relate prompt building and parsing (pure)', () => {
  it('buildRelateMessages lists id/name/short description per line, split by type', () => {
    const long = 'о'.repeat(AI_IMPORT_RELATE_DESC_CHARS + 50);
    const messages = buildRelateMessages(
      [{ slug: 'fn-1', name: 'Поиск', description: long }],
      [{ slug: 'nfr-1', name: 'Отклик поиска' }],
    );
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('JSON');
    expect(messages[0]!.content.toLowerCase()).toContain('не выдумывай');
    const user = messages[1]!.content;
    expect(user).toContain('fn-1\tПоиск\t');
    expect(user).toContain('nfr-1\tОтклик поиска');
    // Description is truncated to the budget (plus a possible ellipsis char).
    const line = user.split('\n').find((l) => l.startsWith('fn-1\t'))!;
    expect(line.split('\t')[2]!.length).toBeLessThanOrEqual(AI_IMPORT_RELATE_DESC_CHARS + 1);
    expect(line).not.toContain('\n');
  });

  it('parseRelateResponse: bare and fenced arrays parse; junk → null', () => {
    const pairs = [{ nfr: 'a', function: 'b' }];
    expect(parseRelateResponse(JSON.stringify(pairs))?.pairs).toEqual(pairs);
    expect(parseRelateResponse('```json\n' + JSON.stringify(pairs) + '\n```')?.pairs).toEqual(
      pairs,
    );
    expect(parseRelateResponse('нет тут массива')).toBeNull();
  });

  it('parseRelateResponse: strict rejects an answer with an invalid record, lenient drops it', () => {
    const mixed = JSON.stringify([{ nfr: 'a', function: 'b' }, { nfr: 42 }]);
    expect(parseRelateResponse(mixed)).toBeNull();
    const lenient = parseRelateResponse(mixed, 'lenient');
    expect(lenient?.pairs).toEqual([{ nfr: 'a', function: 'b' }]);
    expect(lenient?.droppedInvalid).toBe(1);
    expect(lenient?.total).toBe(2);
  });
});
