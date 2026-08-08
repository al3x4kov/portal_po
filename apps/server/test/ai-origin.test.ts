import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isAiPendingReview, type Requirement } from '@po/core';
import { buildApp } from '../src/app.js';
import { createProjectService, createRequirementService } from '../src/factory.js';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import type { ExportResult } from '../src/repositories/ArchiveRepo.js';
import {
  approveDocsReview,
  backlogXlsxBuffer,
  makeImportHarness,
  scriptedClient,
  writeZipArchive,
  KIT_PROJECT,
} from './aiImportKit.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

/**
 * task26 — «создано ИИ, не проверено» (backend contract).
 *
 * Covers: provenance written by BOTH AI imports through RequirementService
 * (never patched onto the file afterwards), the review toggle over
 * `PUT /api/projects/:id/requirements/:slug`, the immutability of `origin` for
 * every public client, and the survival of both fields through the archive
 * export/import round-trip.
 */

const FUNCTIONS_DIR = path.join('openspec', 'specs', 'functions');

describe('task26 · RequirementService provenance', () => {
  let root: string;
  let repo: FsRequirementRepo;
  let service: RequirementService;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    repo = new FsRequirementRepo(root, 'P');
    service = new RequirementService(repo, fixedNow);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('stores origin on creation and persists it in the .md file', async () => {
    const created = await service.create(reqInput({ name: 'AI Req', origin: 'AI_DOCS' }));
    expect(created.origin).toBe('AI_DOCS');
    expect(created.aiValidated).toBeUndefined();
    expect(isAiPendingReview(created)).toBe(true);

    const md = await fs.readFile(path.join(root, 'P', FUNCTIONS_DIR, `${created.slug}.md`), 'utf8');
    expect(md).toContain('- origin: AI_DOCS');
    expect(md).not.toContain('- aiValidated:');

    const { requirements, broken } = await repo.loadAll();
    expect(broken).toEqual([]);
    expect(requirements[0]!.origin).toBe('AI_DOCS');
  });

  it('creates a human requirement without provenance', async () => {
    const created = await service.create(reqInput({ name: 'Human Req' }));
    expect(created.origin).toBeUndefined();
    expect(isAiPendingReview(created)).toBe(false);
  });

  it('toggles aiValidated in both directions and keeps origin immutable', async () => {
    const created = await service.create(reqInput({ name: 'AI Req', origin: 'AI_BACKLOG' }));

    const checked = await service.update(created.slug, {
      name: 'AI Req',
      criticality: 'MEDIUM',
      implemented: true,
      aiValidated: true,
    });
    expect(checked.aiValidated).toBe(true);
    expect(checked.origin).toBe('AI_BACKLOG');
    expect(isAiPendingReview(checked)).toBe(false);

    const unchecked = await service.update(created.slug, {
      name: 'AI Req',
      criticality: 'MEDIUM',
      implemented: true,
      aiValidated: false,
    });
    expect(unchecked.aiValidated).toBe(false);
    expect(isAiPendingReview(unchecked)).toBe(true);
  });

  it('preserves origin and aiValidated across an update that does not mention them', async () => {
    const created = await service.create(reqInput({ name: 'AI Req', origin: 'AI_DOCS' }));
    await service.update(created.slug, {
      name: 'AI Req',
      criticality: 'MEDIUM',
      implemented: true,
      aiValidated: true,
    });
    const renamed = await service.update(created.slug, {
      name: 'AI Req renamed',
      criticality: 'HIGH',
      implemented: true,
    });
    expect(renamed.origin).toBe('AI_DOCS');
    expect(renamed.aiValidated).toBe(true);
  });

  it('ignores an origin smuggled into an update payload', async () => {
    const created = await service.create(reqInput({ name: 'Human Req' }));
    const updated = await service.update(created.slug, {
      name: 'Human Req',
      criticality: 'MEDIUM',
      implemented: true,
      // A caller bypassing the типизированный contract must not gain provenance.
      origin: 'AI_DOCS',
    } as never);
    expect(updated.origin).toBeUndefined();
  });
});

describe('task26 · REST contract', () => {
  let app: FastifyInstance;
  let root: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    app = await buildApp({ projectsRoot: root, now: fixedNow, logger: false });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Demo' } });
  });
  afterEach(async () => {
    await app.close();
    await cleanup(root);
  });

  const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'FUNCTION',
    name: 'Req',
    criticality: 'MEDIUM',
    implemented: true,
    ...over,
  });

  it('ignores origin sent to POST /requirements (provenance is server-only)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/Demo/requirements',
      payload: body({ origin: 'AI_DOCS', aiValidated: true }),
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<Requirement>();
    expect(created.origin).toBeUndefined();
    expect(created.aiValidated).toBeUndefined();
  });

  it('accepts aiValidated on PUT and flips it back and forth', async () => {
    // Provenance can only come from the server side (an AI import) — seed it there.
    const seeded = await createRequirementService(
      { projectsRoot: root, now: fixedNow },
      'Demo',
    ).create(reqInput({ name: 'AI Req', origin: 'AI_DOCS' }));

    const on = await app.inject({
      method: 'PUT',
      url: `/api/projects/Demo/requirements/${seeded.slug}`,
      payload: body({ name: 'AI Req', aiValidated: true }),
    });
    expect(on.statusCode).toBe(200);
    expect(on.json<Requirement>()).toMatchObject({ origin: 'AI_DOCS', aiValidated: true });

    const off = await app.inject({
      method: 'PUT',
      url: `/api/projects/Demo/requirements/${seeded.slug}`,
      payload: body({ name: 'AI Req', aiValidated: false }),
    });
    expect(off.statusCode).toBe(200);
    const result = off.json<Requirement>();
    expect(result).toMatchObject({ origin: 'AI_DOCS', aiValidated: false });
    expect(isAiPendingReview(result)).toBe(true);
  });

  it('rejects a non-boolean aiValidated with 422', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects/Demo/requirements',
      payload: body({ name: 'Plain' }),
    });
    const slug = created.json<Requirement>().slug;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/Demo/requirements/${slug}`,
      payload: body({ name: 'Plain', aiValidated: 'yes' }),
    });
    expect(res.statusCode).toBe(422);
  });

  it('cannot inject or change origin through PUT', async () => {
    const seeded = await createRequirementService(
      { projectsRoot: root, now: fixedNow },
      'Demo',
    ).create(reqInput({ name: 'AI Req', origin: 'AI_DOCS' }));

    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/Demo/requirements/${seeded.slug}`,
      payload: body({ name: 'AI Req', origin: 'AI_BACKLOG' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Requirement>().origin).toBe('AI_DOCS');
  });

  it('keeps check-name working for an AI requirement', async () => {
    const seeded = await createRequirementService(
      { projectsRoot: root, now: fixedNow },
      'Demo',
    ).create(reqInput({ name: 'AI Req', origin: 'AI_DOCS' }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/Demo/requirements/check-name?type=FUNCTION&name=AI Req&excludeSlug=${seeded.slug}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ available: boolean }>().available).toBe(true);
  });

  it('documents aiValidated in the OpenAPI update body', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{ components: { schemas: Record<string, { properties?: object }> } }>();
    const update = doc.components.schemas.UpdateRequirement;
    expect(update?.properties).toHaveProperty('aiValidated');
    const create = doc.components.schemas.CreateRequirement;
    expect(create?.properties).not.toHaveProperty('origin');
    // The response schema advertises both provenance fields to clients.
    const requirement = doc.components.schemas.Requirement;
    expect(requirement?.properties).toHaveProperty('origin');
    expect(requirement?.properties).toHaveProperty('aiValidated');
  });
});

describe('task26 · archive round-trip', () => {
  let root: string;
  let scratch: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'po-task26-'));
  });
  afterEach(async () => {
    await cleanup(root);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it('carries origin/aiValidated through export → import', async () => {
    const ctx = { projectsRoot: root, now: fixedNow };
    const projects = createProjectService(ctx);
    await projects.create('Source');
    const reqs = createRequirementService(ctx, 'Source');
    const pending = await reqs.create(reqInput({ name: 'Pending', origin: 'AI_DOCS' }));
    const done = await reqs.create(reqInput({ name: 'Done', origin: 'AI_BACKLOG' }));
    await reqs.update(done.slug, {
      name: 'Done',
      criticality: 'MEDIUM',
      implemented: true,
      aiValidated: true,
    });

    const exported: ExportResult = await projects.export('Source', 'zip');
    const file = path.join(scratch, 'export.zip');
    if (Buffer.isBuffer(exported.body)) await fs.writeFile(file, exported.body);
    else await pipeline(exported.body as Readable, createWriteStream(file));

    const imported = await projects.import(file, `Copy ${randomBytes(3).toString('hex')}`);
    const { requirements, broken } = await new FsRequirementRepo(root, imported.id).loadAll();
    expect(broken).toEqual([]);
    const byName = new Map(requirements.map((r) => [r.name, r]));
    expect(byName.get('Pending')!.origin).toBe('AI_DOCS');
    expect(byName.get('Pending')!.aiValidated).toBeUndefined();
    expect(byName.get('Done')).toMatchObject({ origin: 'AI_BACKLOG', aiValidated: true });
    expect(byName.get('Pending')!.slug).toBe(pending.slug);
  });
});

describe('task26 · documentation import stamps AI_DOCS', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('marks every requirement created by the docs import as AI_DOCS / not reviewed', async () => {
    const harness = await makeImportHarness(root);
    const client = scriptedClient([
      JSON.stringify([
        {
          type: 'FUNCTION',
          name: 'Вход по паролю',
          description: 'Пользователь входит по email и паролю.',
          source: 'auth.md § Вход',
        },
        {
          type: 'NFR',
          name: 'Время отклика',
          description: 'Отклик до 200 мс.',
          source: 'perf.md § SLA',
        },
      ]),
      JSON.stringify([
        { type: 'FUNCTION', name: 'Вход по паролю', parentName: null },
        { type: 'NFR', name: 'Время отклика', parentName: null },
      ]),
    ]);
    const service = harness.makeService(client);
    const archive = await writeZipArchive({
      'auth.md': '# Вход\nПользователь входит по email и паролю.',
      'perf.md': '# SLA\nОтклик до 200 мс.',
    });

    const { jobId } = await service.start(KIT_PROJECT, archive);
    // Двухзонная выверка: the run pauses at the review gate before any write.
    await service.waitForCompletion(jobId);
    expect(service.getView(jobId).docsReview?.phase).toBe('self');
    await approveDocsReview(service, jobId);
    expect(service.getView(jobId).status).toBe('succeeded');

    const { requirements } = await createRequirementService(
      { projectsRoot: root, now: fixedNow },
      KIT_PROJECT,
    ).list();
    expect(requirements.length).toBeGreaterThan(0);
    for (const req of requirements) {
      expect(req.origin).toBe('AI_DOCS');
      expect(req.aiValidated).toBeUndefined();
      expect(isAiPendingReview(req)).toBe(true);
    }
  });
});

describe('task26 · backlog import stamps AI_BACKLOG', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('marks rows AND the nodes the import creates itself as AI_BACKLOG', async () => {
    const harness = await makeImportHarness(root);
    const ctx = { projectsRoot: root, now: () => new Date().toISOString() };
    // A pre-existing, human-made requirement must stay untouched by the import.
    await createRequirementService(ctx, KIT_PROJECT).create(reqInput({ name: 'Печать отчётов' }));

    const matchAnswer = JSON.stringify([
      {
        rowId: 'r2',
        businessName: 'Сводный отчёт по продажам',
        type: 'FUNCTION',
        parentExisting: 'Печать отчётов',
        parentNew: null,
        duplicateOf: null,
      },
      {
        rowId: 'r3',
        businessName: 'Экспорт в Excel',
        type: 'FUNCTION',
        parentExisting: null,
        parentNew: { name: 'Обмен данными', parentName: null },
        duplicateOf: null,
      },
    ]);
    const service = harness.makeService(scriptedClient([matchAnswer]));
    const upload = path.join(os.tmpdir(), `po-task26-${randomBytes(8).toString('hex')}.xlsx`);
    await fs.writeFile(
      upload,
      backlogXlsxBuffer([
        ['Issue key', 'Summary'],
        ['AB-1', 'Печать сводного отчёта по продажам'],
        ['AB-2', 'Выгрузка данных в Excel'],
      ]),
    );

    const { jobId } = await service.startBacklog(KIT_PROJECT, upload, 'backlog.xlsx');
    await service.waitForCompletion(jobId);
    await service.confirm(jobId, { targetQuarter: 'Q1', targetYear: 2027 });
    await service.waitForCompletion(jobId);
    await service.apply(jobId, ['r2', 'r3']);
    await service.waitForCompletion(jobId);
    expect(service.getView(jobId).status).toBe('succeeded');

    const { requirements } = await createRequirementService(ctx, KIT_PROJECT).list();
    const byName = new Map(requirements.map((r) => [r.name, r]));
    expect(byName.get('Сводный отчёт по продажам')).toMatchObject({ origin: 'AI_BACKLOG' });
    expect(byName.get('Экспорт в Excel')).toMatchObject({ origin: 'AI_BACKLOG' });
    // The node the import created on its own carries the mark too.
    expect(byName.get('Обмен данными')).toMatchObject({ origin: 'AI_BACKLOG' });
    expect(byName.get('Обмен данными')!.aiValidated).toBeUndefined();
    // The human requirement stays human.
    expect(byName.get('Печать отчётов')!.origin).toBeUndefined();
    expect(isAiPendingReview(byName.get('Печать отчётов')!)).toBe(false);
  });
});
