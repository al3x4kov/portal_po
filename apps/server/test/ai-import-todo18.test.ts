import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Requirement } from '@po/core';
import { AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { AiImportJobs } from '../src/services/AiImportJobs.js';
import { AiImportService } from '../src/services/AiImportService.js';
import type { AiChatCompletionParams, AiClient } from '../src/services/AiHubService.js';
import {
  createLinkService,
  createProjectRepo,
  createProjectService,
  createRequirementService,
  type ServiceContext,
} from '../src/factory.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

const SECRET = 'sk-todo18-secret';
const PROJECT = 'Demo';

async function writeZip(files: Record<string, string>): Promise<string> {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  const file = path.join(os.tmpdir(), `po-test-todo18-${randomBytes(8).toString('hex')}.zip`);
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

interface RespondedCall {
  index: number;
  user: string;
  params: AiChatCompletionParams;
}
type Responder = (call: RespondedCall) => string | Error;

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

/** Map NAME → id from the relate list the hub receives (`id\tname\t…` per line). */
function idsByName(user: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of user.split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 2 && parts[0] && parts[1]) map.set(parts[1], parts[0]);
  }
  return map;
}

/** Wrap a payload in a `<think>…</think>` reasoning block a thinking model would emit. */
function thinking(payload: string): string {
  return `<think>\nПроанализирую требования. НФТ ограничивает ФТ [возможно].\nВыдам массив пар.\n</think>\n${payload}`;
}

describe('todo_18: reasoning-strip + смысловые связи в импорте', () => {
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
    // A «thinking» model whose default preset has reasoning: 'strip'.
    await configRepo.update({ apiKey: SECRET, projectId: PROJECT, model: 'Qwen/Qwen3.6-27B' });
    jobs = new AiImportJobs(fixedNow);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('thinking model wrapping JSON in <think>…</think>: extraction/structure/relate all parse, RELATES_TO created (>0)', async () => {
    const client = respondingClient(({ index, user }) => {
      if (index === 0) return thinking(EXTRACTION);
      if (index === 1) return thinking(STRUCTURE);
      const ids = idsByName(user);
      return thinking(JSON.stringify([{ nfr: ids.get(NFR.name), function: ids.get(FN.name) }]));
    });
    const { service, jobId } = await runImport(client, { inferLinks: true });
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    // Without reasoning-strip the brackets inside <think> defeat the parser and
    // the step silently yields 0 — here the pair is parsed and the link created.
    expect(view.relate).toEqual({ status: 'done', created: 1 });
    const reqs = await listRequirements();
    expect(reqs).toHaveLength(2);
    const nfr = reqs.find((r) => r.type === 'NFR');
    const fn = reqs.find((r) => r.type === 'FUNCTION');
    expect(relatesOf(nfr)).toEqual([fn!.slug]);
  });

  it('reasoning preset drives request params: temperature/max_tokens from the model preset', async () => {
    const seen: AiChatCompletionParams[] = [];
    const client = respondingClient(({ index, params }) => {
      seen.push(params);
      if (index === 0) return thinking(EXTRACTION);
      return thinking(STRUCTURE);
    });
    const { service, jobId } = await runImport(client);
    expect(service.getView(jobId).status).toBe('succeeded');
    // Qwen/Qwen3.6-27B preset: temperature 0.2, maxOutputTokens 6000.
    // extraction desired 2000 → min(2000,6000)=2000; structure desired 4000 → 4000.
    expect(seen[0]!.temperature).toBe(0.2);
    expect(seen[0]!.max_tokens).toBe(2000);
    expect(seen[1]!.max_tokens).toBe(4000);
  });

  it('relate returns a VALID empty array → status done + explicit «не нашла пар» log line (not silent)', async () => {
    const client = respondingClient(({ index }) => {
      if (index === 0) return EXTRACTION;
      if (index === 1) return STRUCTURE;
      return '[]';
    });
    const { service, jobId } = await runImport(client, { inferLinks: true });
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.relate).toEqual({ status: 'done', created: 0 });
    expect(
      view.log.some((l) => l.message === 'Модель не нашла уверенных смысловых пар ФТ↔НФТ.'),
    ).toBe(true);
    expect(relatesOf((await listRequirements()).find((r) => r.type === 'NFR'))).toEqual([]);
  });

  it('gap-fill only: an EXISTING child that already has a CHILD_OF parent is NEVER reparented', async () => {
    const reqService = createRequirementService(ctx, PROJECT);
    const parentA = await reqService.create({
      type: 'FUNCTION',
      name: 'Аутентификация',
      criticality: 'MEDIUM',
      implemented: true,
    });
    const altParent = await reqService.create({
      type: 'FUNCTION',
      name: 'Модуль входа',
      criticality: 'MEDIUM',
      implemented: true,
    });
    const child = await reqService.create({
      type: 'FUNCTION',
      name: FN.name,
      criticality: 'MEDIUM',
      implemented: true,
    });
    // Manual, pre-existing hierarchy: child → parentA.
    await createLinkService(ctx, PROJECT).create({
      sourceSlug: child.slug,
      type: 'CHILD_OF',
      targetSlug: parentA.slug,
    });

    // Import tries to reparent the existing child under a DIFFERENT existing node.
    const extraction = JSON.stringify([FN]);
    const structure = JSON.stringify([
      { type: 'FUNCTION', name: FN.name, parentName: 'Модуль входа' },
    ]);
    const client = respondingClient(({ index }) => {
      if (index === 0) return extraction;
      if (index === 1) return structure;
      return new Error('no more calls expected');
    });
    const { service, jobId } = await runImport(client);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.result?.skippedExisting).toBe(1);
    // No CHILD_OF was added; the existing parent link is untouched.
    expect(view.result?.links).toBe(0);
    const after = (await listRequirements()).find((r) => r.slug === child.slug);
    expect(after?.links).toEqual([{ type: 'CHILD_OF', targetSlug: parentA.slug }]);
    expect(after?.links).not.toContainEqual({ type: 'CHILD_OF', targetSlug: altParent.slug });
    // No failed-link warning either — the reparent is skipped before any attempt.
    expect(
      view.log.some((l) => l.message.includes('CHILD_OF') && l.message.includes('не создана')),
    ).toBe(false);
  });
});
