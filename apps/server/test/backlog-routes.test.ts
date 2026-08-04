import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AiImportJobView } from '@po/core';
import { buildApp } from '../src/app.js';
import type { AiClient } from '../src/services/AiHubService.js';
import { backlogXlsxBuffer } from './aiImportKit.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/** todo_22 · T-304: REST surface of the backlog import (integration, mock client). */

const SECRET = 'sk-backlog-secret';
const PROJECT = 'Demo';

function multipart(file: { filename: string; content: Buffer }): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----po${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const XLSX = backlogXlsxBuffer([
  ['Issue key', 'Summary'],
  ['AB-1', 'Печать сводного отчёта'],
  ['AB-2', 'Выгрузка данных в Excel'],
]);

const MATCH_ANSWER = JSON.stringify([
  {
    rowId: 'r2',
    businessName: 'Сводный отчёт',
    type: 'FUNCTION',
    parentExisting: null,
    parentNew: { name: 'Отчётность', parentName: null },
    duplicateOf: null,
  },
  {
    rowId: 'r3',
    businessName: 'Экспорт в Excel',
    type: 'FUNCTION',
    parentExisting: null,
    parentNew: { name: 'Отчётность', parentName: null },
    duplicateOf: null,
  },
]);

describe('T-304 · backlog import routes', () => {
  let root: string;
  let app: FastifyInstance;

  function okClient(): AiClient {
    return {
      models: { list: vi.fn(async () => ({ data: [] })) },
      chat: {
        completions: {
          create: vi.fn(async () => ({ choices: [{ message: { content: MATCH_ANSWER } }] })),
        },
      },
    };
  }

  async function poll(
    jobId: string,
    until: (v: AiImportJobView) => boolean,
  ): Promise<AiImportJobView> {
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: 'GET', url: `/api/ai-import/${jobId}` });
      expect(res.statusCode).toBe(200);
      const view = res.json() as AiImportJobView;
      if (until(view)) return view;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('job did not reach the expected state');
  }

  beforeEach(async () => {
    root = await makeTmpRoot();
    app = await buildApp({
      projectsRoot: root,
      now: fixedNow,
      logger: false,
      makeAiClient: () => okClient(),
    });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: PROJECT } });
    await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: SECRET, projectId: PROJECT, model: 'Qwen-Coder-Next' },
    });
  });
  afterEach(async () => {
    if (app) await app.close();
    await cleanup(root);
  });

  it('xlsx multipart → 202 → confirm{target} → review → apply → succeeded + report', async () => {
    const { body, contentType } = multipart({ filename: 'Книга2.xlsx', content: XLSX });
    const started = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/ai-backlog-import`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(started.statusCode).toBe(202);
    const { jobId } = started.json() as { jobId: string };

    const paused = await poll(jobId, (v) => v.status === 'awaiting-confirmation');
    expect(paused.kind).toBe('backlog');
    expect(paused.backlogPreview).toMatchObject({ totalRows: 2, fileName: 'Книга2.xlsx' });

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/ai-import/${jobId}/confirm`,
      payload: { targetQuarter: 'Q2', targetYear: 2027 },
    });
    expect(confirmed.statusCode).toBe(200);

    const reviewed = await poll(jobId, (v) => v.status === 'awaiting-review');
    expect(reviewed.backlogReview?.mappings).toHaveLength(2);
    expect(reviewed.backlogReview?.newNodes).toEqual([
      { name: 'Отчётность', parentName: null, rowCount: 2 },
    ]);

    const applied = await app.inject({
      method: 'POST',
      url: `/api/ai-import/${jobId}/apply`,
      payload: { rowIds: ['r2', 'r3'] },
    });
    expect(applied.statusCode).toBe(200);

    const done = await poll(jobId, (v) => v.status === 'succeeded');
    expect(done.backlogReport).toMatchObject({
      rowsTotal: 2,
      rowsSelected: 2,
      created: { functions: 2, newNodes: 1, links: 2 },
    });

    const reqs = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/requirements`,
    });
    const names = (reqs.json() as { requirements: Array<{ name: string }> }).requirements.map(
      (r) => r.name,
    );
    expect(names).toEqual(
      expect.arrayContaining(['Отчётность', 'Сводный отчёт', 'Экспорт в Excel']),
    );

    const history = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/ai-import/jobs`,
    });
    const jobs = (history.json() as { jobs: Array<{ jobId: string; kind?: string }> }).jobs;
    expect(jobs.find((j) => j.jobId === jobId)?.kind).toBe('backlog');
  });

  it('validates the bodies: bad apply body → 422, apply on a fresh job → 409', async () => {
    const { body, contentType } = multipart({ filename: 'b.xlsx', content: XLSX });
    const started = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/ai-backlog-import`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    const { jobId } = started.json() as { jobId: string };
    await poll(jobId, (v) => v.status === 'awaiting-confirmation');

    const badBody = await app.inject({
      method: 'POST',
      url: `/api/ai-import/${jobId}/apply`,
      payload: { rowIds: [] },
    });
    expect(badBody.statusCode).toBe(422); // parseInput → VALIDATION_FAILED

    const wrongState = await app.inject({
      method: 'POST',
      url: `/api/ai-import/${jobId}/apply`,
      payload: { rowIds: ['r2'] },
    });
    expect(wrongState.statusCode).toBe(409);

    const badConfirm = await app.inject({
      method: 'POST',
      url: `/api/ai-import/${jobId}/confirm`,
      payload: { targetQuarter: 'Q2' }, // lone quarter — must come with a year
    });
    expect(badConfirm.statusCode).toBe(422); // lone quarter fails the contract refine
  });

  it('task25: apply с overrides — правки доезжают; невалидные → 400 с текстом', async () => {
    const { body, contentType } = multipart({ filename: 'b.xlsx', content: XLSX });
    const started = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/ai-backlog-import`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    const { jobId } = started.json() as { jobId: string };
    await poll(jobId, (v) => v.status === 'awaiting-confirmation');
    await app.inject({
      method: 'POST',
      url: `/api/ai-import/${jobId}/confirm`,
      payload: { targetQuarter: 'Q2', targetYear: 2027 },
    });
    await poll(jobId, (v) => v.status === 'awaiting-review');

    // Правка для строки вне выбора → 400, шаг выверки жив.
    const outside = await app.inject({
      method: 'POST',
      url: `/api/ai-import/${jobId}/apply`,
      payload: { rowIds: ['r2'], overrides: { r3: { businessName: 'x' } } },
    });
    expect(outside.statusCode).toBe(400);
    expect((outside.json() as { message: string }).message).toMatch(/«r3»/);

    // Невалидное содержимое правки (год вне диапазона) → 400 с rowId.
    const badYear = await app.inject({
      method: 'POST',
      url: `/api/ai-import/${jobId}/apply`,
      payload: {
        rowIds: ['r2'],
        overrides: { r2: { targetQuarter: 'Q1', targetYear: 1999 } },
      },
    });
    expect(badYear.statusCode).toBe(400);
    expect((badYear.json() as { message: string }).message).toMatch(/«r2»/);

    // Валидные правки: имя + срок + свой новый корневой узел.
    const applied = await app.inject({
      method: 'POST',
      url: `/api/ai-import/${jobId}/apply`,
      payload: {
        rowIds: ['r2', 'r3'],
        overrides: {
          r2: {
            businessName: 'Импортированный отчёт',
            parent: { kind: 'new', name: 'Витрина отчётов' },
            targetQuarter: 'Q4',
            targetYear: 2028,
          },
        },
      },
    });
    expect(applied.statusCode).toBe(200);
    const done = await poll(jobId, (v) => v.status === 'succeeded');
    expect(done.backlogReview?.mappings.find((m) => m.rowId === 'r2')).toMatchObject({
      businessName: 'Импортированный отчёт',
      targetQuarter: 'Q4',
      targetYear: 2028,
    });

    const reqs = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/requirements`,
    });
    const requirements = (
      reqs.json() as {
        requirements: Array<{
          name: string;
          slug: string;
          targetQuarter?: string;
          targetYear?: number;
          links?: Array<{ type: string; targetSlug: string }>;
        }>;
      }
    ).requirements;
    const byName = new Map(requirements.map((r) => [r.name, r]));
    const created = byName.get('Импортированный отчёт');
    expect(created).toMatchObject({ targetQuarter: 'Q4', targetYear: 2028 });
    const node = byName.get('Витрина отчётов');
    expect(node).toBeDefined();
    expect(created?.links).toContainEqual({ type: 'CHILD_OF', targetSlug: node!.slug });
  });

  it('no file in the multipart → 400; unknown project → 404', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/ai-backlog-import`,
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      payload: Buffer.from('--x--\r\n'),
    });
    expect([400, 406]).toContain(empty.statusCode);

    const { body, contentType } = multipart({ filename: 'b.xlsx', content: XLSX });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/projects/НетТакого/ai-backlog-import',
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('OpenAPI document describes the backlog endpoints', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.paths['/api/projects/{id}/ai-backlog-import']).toBeDefined();
    expect(doc.paths['/api/ai-import/{jobId}/apply']).toBeDefined();
    expect(doc.components.schemas['AiBacklogApplyBody']).toBeDefined();
    expect(doc.components.schemas['AiImportConfirmBody']).toBeDefined();
  });
});
