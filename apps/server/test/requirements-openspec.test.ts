import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/** T-1001: GET /api/projects/:id/requirements?format=openspec. */
describe('T-1001 requirements list format=openspec', () => {
  let app: FastifyInstance;
  let root: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    app = await buildApp({ projectsRoot: root, now: fixedNow, logger: false });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P' } });
  });
  afterEach(async () => {
    await app.close();
    await cleanup(root);
  });

  it('returns text/markdown OpenSpec with ### Requirement: headers and folder sections', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects/P/requirements',
      payload: { type: 'FUNCTION', name: 'User Login', criticality: 'HIGH', implemented: true },
    });
    await app.inject({
      method: 'POST',
      url: '/api/projects/P/requirements',
      payload: {
        type: 'NFR',
        name: 'Fast Response',
        criticality: 'MEDIUM',
        implemented: false,
        targetQuarter: 'Q3',
        targetYear: 2026,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/P/requirements?format=openspec',
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/markdown');
    const body = res.body;
    expect(body).toContain('# OpenSpec: P');
    expect(body).toContain('## functions');
    expect(body).toContain('## nfr');
    expect(body).toContain('### Requirement: User Login');
    expect(body).toContain('### Requirement: Fast Response');
    // Two requirements → two OpenSpec headers.
    expect(body.match(/### Requirement:/g)).toHaveLength(2);
  });

  it('empty project yields the heading only, no requirement sections', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/P/requirements?format=openspec',
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/markdown');
    expect(res.body.trim()).toBe('# OpenSpec: P');
  });

  it('without format returns the prior JSON shape ({ requirements, broken })', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects/P/requirements',
      payload: { type: 'FUNCTION', name: 'Feature', criticality: 'LOW', implemented: true },
    });
    const res = await app.inject({ method: 'GET', url: '/api/projects/P/requirements' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/json');
    const json = res.json();
    expect(Array.isArray(json.requirements)).toBe(true);
    expect(json.requirements).toHaveLength(1);
    expect(Array.isArray(json.broken)).toBe(true);
    expect(json.requirements[0].slug).toBe('feature');
  });

  it('format=json is equivalent to the default JSON response', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/P/requirements?format=json',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ requirements: [], broken: [] });
  });
});
