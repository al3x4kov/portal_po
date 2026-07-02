import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/** Build a multipart/form-data payload for inject. */
function multipart(
  fields: Record<string, string>,
  file: { field: string; filename: string; content: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----po${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  chunks.push(file.content, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('T-301/T-304/T-403/T-503 HTTP integration', () => {
  let app: FastifyInstance;
  let root: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    app = await buildApp({ projectsRoot: root, now: fixedNow, logger: false });
  });
  afterEach(async () => {
    await app.close();
    await cleanup(root);
  });

  it('GET /healthz → 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('project lifecycle: create (201) → list → get → duplicate (409) → missing (404)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Demo' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'Demo', name: 'Demo' });

    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json()).toHaveLength(1);

    const get = await app.inject({ method: 'GET', url: '/api/projects/Demo' });
    expect(get.statusCode).toBe(200);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Demo' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('CONFLICT');

    const missing = await app.inject({ method: 'GET', url: '/api/projects/ghost' });
    expect(missing.statusCode).toBe(404);
  });

  it('requirement CRUD + check-name + validation mapping', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P' } });

    const create = await app.inject({
      method: 'POST',
      url: '/api/projects/P/requirements',
      payload: { type: 'FUNCTION', name: 'Login', criticality: 'HIGH', implemented: true },
    });
    expect(create.statusCode).toBe(201);
    const slug = create.json().slug as string;
    expect(slug).toBe('login');

    const check = await app.inject({
      method: 'GET',
      url: '/api/projects/P/requirements/check-name?type=FUNCTION&name=Login',
    });
    expect(check.json()).toEqual({ available: false, slug: 'login-2' });

    const checkFree = await app.inject({
      method: 'GET',
      url: `/api/projects/P/requirements/check-name?type=FUNCTION&name=Login&excludeSlug=${slug}`,
    });
    expect(checkFree.json()).toEqual({ available: true, slug: 'login' });

    const update = await app.inject({
      method: 'PUT',
      url: `/api/projects/P/requirements/${slug}`,
      payload: { name: 'Login v2', criticality: 'LOW', implemented: true },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().name).toBe('Login v2');
    // slug is immutable on rename (ADR-001).
    expect(update.json().slug).toBe('login');

    // implemented=false without quarter/year → 422
    const bad = await app.inject({
      method: 'POST',
      url: '/api/projects/P/requirements',
      payload: { type: 'NFR', name: 'Perf', criticality: 'LOW', implemented: false },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('VALIDATION');

    const del = await app.inject({ method: 'DELETE', url: `/api/projects/P/requirements/${slug}` });
    expect(del.statusCode).toBe(204);
  });

  it('requirement on a missing project → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/ghost/requirements',
      payload: { type: 'FUNCTION', name: 'X', criticality: 'LOW', implemented: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('links endpoints create a pair and a cycle returns 409 with the path', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'L' } });
    const mk = async (name: string): Promise<string> => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/projects/L/requirements',
        payload: { type: 'FUNCTION', name, criticality: 'LOW', implemented: true },
      });
      return r.json().slug as string;
    };
    const a = await mk('A');
    const b = await mk('B');

    const link = await app.inject({
      method: 'POST',
      url: '/api/projects/L/links',
      payload: { sourceSlug: a, type: 'PARENT_OF', targetSlug: b },
    });
    expect(link.statusCode).toBe(201);

    const cycle = await app.inject({
      method: 'POST',
      url: '/api/projects/L/links',
      payload: { sourceSlug: b, type: 'PARENT_OF', targetSlug: a },
    });
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json().code).toBe('CYCLE');
    expect(Array.isArray(cycle.json().details.path)).toBe(true);

    const unlink = await app.inject({
      method: 'DELETE',
      url: '/api/projects/L/links',
      payload: { sourceSlug: a, type: 'PARENT_OF', targetSlug: b },
    });
    expect(unlink.statusCode).toBe(200);
  });

  it('export returns an archive; multipart import recreates the project (round-trip over HTTP)', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Exp' } });
    await app.inject({
      method: 'POST',
      url: '/api/projects/Exp/requirements',
      payload: { type: 'FUNCTION', name: 'Feature', criticality: 'LOW', implemented: true },
    });

    const exp = await app.inject({ method: 'GET', url: '/api/projects/Exp/export?format=zip' });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-type']).toBe('application/zip');
    expect(String(exp.headers['content-disposition'])).toContain('Exp.zip');
    const archive = exp.rawPayload;
    expect(archive.length).toBeGreaterThan(0);

    const { body, contentType } = multipart(
      { name: 'Imported' },
      { field: 'file', filename: 'Exp.zip', content: archive },
    );
    const imp = await app.inject({
      method: 'POST',
      url: '/api/projects/import',
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(imp.statusCode).toBe(201);
    expect(imp.json().id).toBe('Imported');

    const reqs = await app.inject({ method: 'GET', url: '/api/projects/Imported/requirements' });
    expect(reqs.json().requirements).toHaveLength(1);
    expect(reqs.json().requirements[0].name).toBe('Feature');
  });

  it('exports a project as .xlsx (T-902, S18): 200, xlsx headers, PK signature', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Xl' } });
    await app.inject({
      method: 'POST',
      url: '/api/projects/Xl/requirements',
      payload: { type: 'FUNCTION', name: 'Feature', criticality: 'LOW', implemented: true },
    });

    const res = await app.inject({ method: 'GET', url: '/api/projects/Xl/export.xlsx' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    expect(String(res.headers['content-disposition'])).toContain('Xl.xlsx');
    // Valid xlsx = zip container → starts with "PK\x03\x04".
    expect(res.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it('xlsx export of a missing project → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/ghost/export.xlsx' });
    expect(res.statusCode).toBe(404);
  });
});
