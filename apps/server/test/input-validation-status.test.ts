import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/**
 * BE-4: input validation must map to ONE status across every route family.
 * Invalid request bodies/queries — regardless of which family they hit
 * (projects / requirements / links vs ai / ai-import) — go through the single
 * `parseInput` helper and therefore resolve to HTTP 422 with `code: VALIDATION`.
 */
describe('BE-4 unified input-validation status (422) across route families', () => {
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

  const cases: Array<{ name: string; method: 'POST' | 'PUT'; url: string; payload: unknown }> = [
    { name: 'projects: create (empty name)', method: 'POST', url: '/api/projects', payload: {} },
    {
      name: 'requirements: create (invalid body)',
      method: 'POST',
      url: '/api/projects/Demo/requirements',
      payload: { name: '' },
    },
    {
      name: 'links: create (missing fields)',
      method: 'POST',
      url: '/api/projects/Demo/links',
      payload: {},
    },
    {
      name: 'ai: config (invalid baseURL)',
      method: 'PUT',
      url: '/api/ai/config',
      payload: { baseURL: 'not-a-url' },
    },
    {
      name: 'ai: chat (empty history)',
      method: 'POST',
      url: '/api/ai/chat',
      payload: { messages: [] },
    },
  ];

  for (const c of cases) {
    it(`${c.name} → 422 VALIDATION`, async () => {
      const res = await app.inject({ method: c.method, url: c.url, payload: c.payload });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'VALIDATION' });
    });
  }
});
