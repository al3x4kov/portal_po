import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

describe('T-112 dictionaries routes', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = await makeTmpRoot();
    app = await buildApp({ projectsRoot: root, now: fixedNow });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P' } });
  });
  afterEach(async () => {
    await app.close();
    await cleanup(root);
  });

  it('GET returns the seeded default dictionary', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/P/dictionaries' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.priorities).toHaveLength(1);
    expect(body.priorities[0].name).toBe('Квартальная цель');
    expect(body.sources).toEqual([]);
  });

  it('GET on unknown project → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/ghost/dictionaries' });
    expect(res.statusCode).toBe(404);
  });

  it('POST creates a priority (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/P/dictionaries/priorities',
      payload: { name: 'Критично', color: 'red' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Критично', color: 'red', order: 1 });
  });

  it('POST duplicate priority name → 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/P/dictionaries/priorities',
      payload: { name: 'Квартальная цель', color: 'red' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST invalid color → 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/P/dictionaries/priorities',
      payload: { name: 'X', color: 'chartreuse' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('PUT renames a priority', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/projects/P/dictionaries/priorities',
        payload: { name: 'Mid', color: 'blue' },
      })
    ).json();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/P/dictionaries/priorities/${created.id}`,
      payload: { name: 'Middle' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Middle');
  });

  it('DELETE a used priority without reassignTo → 409, with reassignTo → 204', async () => {
    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/projects/P/dictionaries/priorities',
        payload: { name: 'InUse', color: 'purple' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: '/api/projects/P/requirements',
      payload: {
        type: 'FUNCTION',
        name: 'R',
        criticality: 'MEDIUM',
        implemented: true,
        sources: [{ type: 'CLIENT', name: 'Acme', priorityId: p.id }],
      },
    });
    const conflict = await app.inject({
      method: 'DELETE',
      url: `/api/projects/P/dictionaries/priorities/${p.id}`,
    });
    expect(conflict.statusCode).toBe(409);

    const dict = (await app.inject({ method: 'GET', url: '/api/projects/P/dictionaries' })).json();
    const other = dict.priorities.find((x: { id: string }) => x.id !== p.id).id;
    const ok = await app.inject({
      method: 'DELETE',
      url: `/api/projects/P/dictionaries/priorities/${p.id}?reassignTo=${other}`,
    });
    expect(ok.statusCode).toBe(204);
  });

  it('sources CRUD via routes', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects/P/dictionaries/sources',
      payload: { name: 'Acme', type: 'CLIENT' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const dup = await app.inject({
      method: 'POST',
      url: '/api/projects/P/dictionaries/sources',
      payload: { name: 'acme', type: 'TEXT' },
    });
    expect(dup.statusCode).toBe(409);

    const renamed = await app.inject({
      method: 'PUT',
      url: `/api/projects/P/dictionaries/sources/${id}`,
      payload: { name: 'Acme Corp' },
    });
    expect(renamed.json().name).toBe('Acme Corp');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/P/dictionaries/sources/${id}`,
    });
    expect(del.statusCode).toBe(204);
  });
});
