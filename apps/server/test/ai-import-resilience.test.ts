import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Requirement } from '@po/core';
import { buildApp } from '../src/app.js';
import { AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { AiImportJobs } from '../src/services/AiImportJobs.js';
import { AiImportService } from '../src/services/AiImportService.js';
import type { AiClient } from '../src/services/AiHubService.js';
import type { LinkService } from '../src/services/LinkService.js';
import type { RequirementService } from '../src/services/RequirementService.js';
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

/**
 * PO-T2 · resilience of the AI import writing into a live user project: an
 * injected crash mid-pipeline must not leave the project half-written
 * "silently" (job → failed with a readable message, no dangling links) and a
 * re-run of the same archive must complete the missing parts without dupes.
 */

/** Extraction: parent section + child (hierarchy now comes from structure). */
const EXTRACTION = JSON.stringify([
  {
    type: 'FUNCTION',
    name: 'Аутентификация',
    description: 'Раздел аутентификации.',
    source: 'auth.md § Аутентификация',
  },
  {
    type: 'FUNCTION',
    name: 'Вход по паролю',
    description: 'Пользователь входит по email и паролю.',
    source: 'auth.md § Вход',
    parentName: 'Аутентификация',
  },
]);

/** Structure-stage answer (Task 13 B2): the tree the AI hub assembles. */
const STRUCTURE = JSON.stringify([
  { type: 'FUNCTION', name: 'Аутентификация', parentName: null },
  { type: 'FUNCTION', name: 'Вход по паролю', parentName: 'Аутентификация' },
]);

async function writeZip(files: Record<string, string>): Promise<string> {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  const file = path.join(os.tmpdir(), `po-test-ai-res-${randomBytes(8).toString('hex')}.zip`);
  await fs.writeFile(file, zip.toBuffer());
  return file;
}

function fixedClient(answers: string[] = [EXTRACTION, STRUCTURE]): AiClient {
  let call = 0;
  return {
    models: { list: vi.fn(async () => ({ data: [] })) },
    chat: {
      completions: {
        create: vi.fn(async () => {
          const content = answers[Math.min(call, answers.length - 1)] ?? '[]';
          call += 1;
          return { choices: [{ message: { content } }] };
        }),
      },
    },
  };
}

/** Assert the project is internally consistent: parseable + no dangling links. */
async function assertProjectValid(root: string): Promise<Requirement[]> {
  const repo = new FsRequirementRepo(root, PROJECT);
  const { requirements, broken } = await repo.loadAll();
  expect(broken).toEqual([]);
  const slugs = new Set(requirements.map((r) => r.slug));
  for (const req of requirements) {
    for (const link of req.links) {
      expect(slugs.has(link.targetSlug), `dangling link ${req.slug} → ${link.targetSlug}`).toBe(
        true,
      );
    }
  }
  return requirements;
}

describe('PO-T2 · AI import survives an injected mid-pipeline crash', () => {
  let root: string;
  let ctx: ServiceContext;
  let configRepo: AiConfigRepo;
  let jobs: AiImportJobs;

  interface Overrides {
    makeRequirementService?: (pid: string) => RequirementService;
    makeLinkService?: (pid: string) => LinkService;
  }

  function makeService(client: AiClient, overrides: Overrides = {}): AiImportService {
    const projectRepo = createProjectRepo(ctx);
    return new AiImportService({
      now: fixedNow,
      jobs,
      configRepo,
      makeAiClient: () => client,
      makeRequirementService:
        overrides.makeRequirementService ?? ((pid) => createRequirementService(ctx, pid)),
      makeLinkService: overrides.makeLinkService ?? ((pid) => createLinkService(ctx, pid)),
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

  it('crash between requirement creation and link creation → job failed with a readable message, project stays valid', async () => {
    const failingLinks = (pid: string): LinkService => {
      const real = createLinkService(ctx, pid);
      real.create = () => Promise.reject(new Error('EIO: injected write failure'));
      return real;
    };
    const service = makeService(fixedClient(), { makeLinkService: failingLinks });
    const jobId = await runToEnd(service, await writeZip({ 'auth.md': 'Документация.' }));

    const view = service.getView(jobId);
    // Not "silently succeeded": failed with a message a user can read and act on.
    expect(view.status).toBe('failed');
    expect(view.error?.message).toContain('EIO: injected write failure');
    expect(view.error?.hint).toBeTruthy();
    expect(
      view.log.some((l) => l.level === 'error' && l.message.includes('Внутренняя ошибка')),
    ).toBe(true);

    // The half-written project is still valid: both requirements parse, and the
    // aborted link step left no dangling one-sided references.
    const requirements = await assertProjectValid(root);
    expect(requirements.map((r) => r.name).sort()).toEqual(['Аутентификация', 'Вход по паролю']);
    expect(requirements.every((r) => r.links.length === 0)).toBe(true);

    // Re-run of the same archive with healthy dependencies (PO decision):
    // both requirements already exist → skipped (no rewrite, no duplicates),
    // but their extracted CHILD_OF link is missing → it IS created.
    const second = makeService(fixedClient());
    const secondJob = await runToEnd(second, await writeZip({ 'auth.md': 'Документация.' }));
    const secondView = second.getView(secondJob);
    expect(secondView.status).toBe('succeeded');
    expect(secondView.result).toEqual({
      createdFunctions: 0,
      createdNfrs: 0,
      skippedExisting: 2,
      links: 1,
      relatesLinks: 0,
    });

    const repaired = await assertProjectValid(root);
    expect(repaired.map((r) => r.name).sort()).toEqual(['Аутентификация', 'Вход по паролю']);
    const child = repaired.find((r) => r.name === 'Вход по паролю');
    const parent = repaired.find((r) => r.name === 'Аутентификация');
    expect(child?.links).toEqual([{ type: 'CHILD_OF', targetSlug: parent?.slug }]);
    expect(parent?.links).toEqual([{ type: 'PARENT_OF', targetSlug: child?.slug }]);
  });

  it('crash mid-populate → re-running the same archive completes the missing parts without duplicates', async () => {
    // First run: creating the child requirement fails with a non-domain error.
    const failingChild = (pid: string): RequirementService => {
      const real = createRequirementService(ctx, pid);
      const orig = real.create.bind(real);
      real.create = (input) =>
        input.name === 'Вход по паролю'
          ? Promise.reject(new Error('ENOSPC: injected disk failure'))
          : orig(input);
      return real;
    };
    const first = makeService(fixedClient(), { makeRequirementService: failingChild });
    const firstJob = await runToEnd(first, await writeZip({ 'auth.md': 'Документация.' }));
    expect(first.getView(firstJob).status).toBe('failed');
    expect(first.getView(firstJob).error?.message).toContain('ENOSPC');

    const afterCrash = await assertProjectValid(root);
    expect(afterCrash.map((r) => r.name)).toEqual(['Аутентификация']);

    // Second run of the SAME archive content with healthy dependencies.
    const second = makeService(fixedClient());
    const secondJob = await runToEnd(second, await writeZip({ 'auth.md': 'Документация.' }));

    const view = second.getView(secondJob);
    expect(view.status).toBe('succeeded');
    // The parent already exists → skipped; only the missing child + its link are added.
    expect(view.result).toEqual({
      createdFunctions: 1,
      createdNfrs: 0,
      skippedExisting: 1,
      links: 1,
      relatesLinks: 0,
    });

    const requirements = await assertProjectValid(root);
    expect(requirements.map((r) => r.name).sort()).toEqual(['Аутентификация', 'Вход по паролю']);
    const child = requirements.find((r) => r.name === 'Вход по паролю');
    const parent = requirements.find((r) => r.name === 'Аутентификация');
    expect(child?.links).toEqual([{ type: 'CHILD_OF', targetSlug: parent?.slug }]);

    // Third run is a no-op: everything is skipped, and the extracted CHILD_OF
    // already exists on the skipped child → it is NOT touched or duplicated
    // (links stays 0 on a fully populated project).
    const third = makeService(fixedClient());
    const thirdJob = await runToEnd(third, await writeZip({ 'auth.md': 'Документация.' }));
    expect(third.getView(thirdJob).result).toEqual({
      createdFunctions: 0,
      createdNfrs: 0,
      skippedExisting: 2,
      links: 0,
      relatesLinks: 0,
    });
    const settled = await assertProjectValid(root);
    expect(settled).toHaveLength(2);
    // Exactly one pair, unchanged after the no-op run.
    expect(settled.flatMap((r) => r.links)).toHaveLength(2);
  });

  it('re-run adds only the missing CHILD_OF of a skipped requirement and never touches its other links', async () => {
    // Project pre-populated by hand: both extracted requirements exist WITHOUT
    // their CHILD_OF link, and the child carries a "foreign" link to a third
    // requirement the extraction knows nothing about.
    const reqService = createRequirementService(ctx, PROJECT);
    const parent = await reqService.create({
      type: 'FUNCTION',
      name: 'Аутентификация',
      criticality: 'MEDIUM',
      implemented: true,
    });
    const child = await reqService.create({
      type: 'FUNCTION',
      name: 'Вход по паролю',
      criticality: 'MEDIUM',
      implemented: true,
    });
    const foreign = await reqService.create({
      type: 'FUNCTION',
      name: 'Журналирование',
      criticality: 'LOW',
      implemented: true,
    });
    const linkService = createLinkService(ctx, PROJECT);
    await linkService.create({
      sourceSlug: child.slug,
      type: 'RELATES_TO',
      targetSlug: foreign.slug,
    });

    const service = makeService(fixedClient());
    const jobId = await runToEnd(service, await writeZip({ 'auth.md': 'Документация.' }));

    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    // No rewrite: requirements skipped, only the missing link is added.
    expect(view.result).toEqual({
      createdFunctions: 0,
      createdNfrs: 0,
      skippedExisting: 2,
      links: 1,
      relatesLinks: 0,
    });

    const requirements = await assertProjectValid(root);
    expect(requirements).toHaveLength(3);
    const childAfter = requirements.find((r) => r.slug === child.slug);
    const foreignAfter = requirements.find((r) => r.slug === foreign.slug);
    // The pre-existing "foreign" link survives untouched; CHILD_OF is added.
    expect(childAfter?.links).toEqual(
      expect.arrayContaining([
        { type: 'RELATES_TO', targetSlug: foreign.slug },
        { type: 'CHILD_OF', targetSlug: parent.slug },
      ]),
    );
    expect(childAfter?.links).toHaveLength(2);
    expect(foreignAfter?.links).toEqual([{ type: 'RELATES_TO', targetSlug: child.slug }]);
  });
});

describe('PO-T2 · lost job (server restart, in-memory registry)', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = await makeTmpRoot();
    app = await buildApp({ projectsRoot: root, now: fixedNow, logger: false });
  });
  afterEach(async () => {
    await app.close();
    await cleanup(root);
  });

  it('GET /api/ai-import/:jobId for an unknown job → 404 in the unified error format', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ai-import/lost-after-restart' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { code: string; message: string };
    // The client recognizes the shape ({code, message}) and the NOT_FOUND code —
    // the UI switches the modal to its error state instead of polling forever.
    expect(body.code).toBe('NOT_FOUND');
    expect(body.message).toContain('lost-after-restart');
  });

  it('POST /api/ai-import/:jobId/cancel for an unknown job → the same recognizable 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ai-import/gone/cancel' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('NOT_FOUND');
  });
});
