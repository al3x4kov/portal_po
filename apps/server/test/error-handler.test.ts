import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { cleanup, makeTmpRoot } from './helpers.js';

describe('QA-6: unified error handler branches', () => {
  let app: FastifyInstance;
  let root: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    app = await buildApp({ projectsRoot: root, logger: false });
  });
  afterEach(async () => {
    await app.close();
    await cleanup(root);
  });

  it('an unhandled (non-domain) error → 500 INTERNAL with no internals leaked', async () => {
    app.get('/__boom', async () => {
      throw new Error('kaboom-secret-detail');
    });
    const res = await app.inject({ method: 'GET', url: '/__boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      code: 'INTERNAL',
      message: 'Internal Server Error',
      details: undefined,
    });
    // The raw error message must never reach the client.
    expect(res.payload).not.toContain('kaboom-secret-detail');
  });

  it('malformed JSON body → 4xx BAD_REQUEST in the unified format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'content-type': 'application/json' },
      payload: '{ this is not valid json',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('invalid multipart body → 4xx BAD_REQUEST in the unified format', async () => {
    // multipart/form-data without a boundary is unparseable by busboy.
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/import',
      headers: { 'content-type': 'multipart/form-data' },
      payload: 'not-a-valid-multipart-body',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });
});

describe('QA-6: notFoundHandler with a static SPA root', () => {
  let app: FastifyInstance;
  let root: string;
  let staticRoot: string;

  beforeEach(async () => {
    root = await makeTmpRoot();
    staticRoot = path.join(os.tmpdir(), `po-static-${randomBytes(8).toString('hex')}`);
    await fs.mkdir(staticRoot, { recursive: true });
    await fs.writeFile(path.join(staticRoot, 'index.html'), '<!doctype html><title>SPA</title>');
    app = await buildApp({ projectsRoot: root, logger: false, staticRoot });
  });
  afterEach(async () => {
    await app.close();
    await cleanup(root);
    await fs.rm(staticRoot, { recursive: true, force: true });
  });

  it('an unknown /api/* path → 404 JSON NOT_FOUND (never the SPA shell)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: 'NOT_FOUND', message: 'Not found', details: undefined });
  });

  it('an unknown non-API path → the SPA index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/some-client-route' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('<title>SPA</title>');
  });
});
