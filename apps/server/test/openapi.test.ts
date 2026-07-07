import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/** E14: OpenAPI/Swagger documentation for the REST API. */
describe('E14 OpenAPI / Swagger docs', () => {
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

  it('GET /openapi.json → 200 with an OpenAPI 3.x document', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(String(doc.openapi)).toMatch(/^3\./);
    expect(doc.info?.title).toBeTruthy();
    expect(doc.info?.version).toBeTruthy();
    expect(Array.isArray(doc.servers)).toBe(true);
    expect(doc.servers.map((s: { url: string }) => s.url)).toContain('http://localhost:3000');
  });

  it('documents every REST path', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const paths = Object.keys(doc.paths);
    expect(paths).toContain('/api/projects');
    expect(paths).toContain('/api/projects/{id}');
    expect(paths).toContain('/api/projects/{id}/requirements');
    expect(paths).toContain('/api/projects/{id}/requirements/{slug}');
    expect(paths).toContain('/api/projects/{id}/requirements/check-name');
    expect(paths).toContain('/api/projects/{id}/links');
    expect(paths).toContain('/api/projects/{id}/export');
    expect(paths).toContain('/api/projects/import');
  });

  it('documents the `format` query on the requirements list (json|openspec)', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const op = doc.paths['/api/projects/{id}/requirements'].get;
    const formatParam = op.parameters.find(
      (p: { name: string; in: string }) => p.name === 'format' && p.in === 'query',
    );
    expect(formatParam).toBeTruthy();
    expect(formatParam.schema.enum).toEqual(['json', 'openspec']);
  });

  it('documents the `format` query on export (zip|targz)', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const op = doc.paths['/api/projects/{id}/export'].get;
    const formatParam = op.parameters.find(
      (p: { name: string; in: string }) => p.name === 'format' && p.in === 'query',
    );
    expect(formatParam).toBeTruthy();
    expect(formatParam.schema.enum).toEqual(['zip', 'targz']);
  });

  it('describes the {id} and {slug} path parameters', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const reqOp = doc.paths['/api/projects/{id}/requirements/{slug}'].put;
    const idParam = reqOp.parameters.find((p: { name: string }) => p.name === 'id');
    const slugParam = reqOp.parameters.find((p: { name: string }) => p.name === 'slug');
    expect(idParam.in).toBe('path');
    expect(idParam.required).toBe(true);
    expect(typeof idParam.description).toBe('string');
    expect(idParam.description.length).toBeGreaterThan(0);
    expect(slugParam.in).toBe('path');
    expect(slugParam.required).toBe(true);
    expect(typeof slugParam.description).toBe('string');
    expect(slugParam.description.length).toBeGreaterThan(0);
  });

  it('exposes the request/response component schemas', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const schemas = doc.components?.schemas ?? {};
    for (const name of [
      'Requirement',
      'Link',
      'Project',
      'CreateRequirement',
      'UpdateRequirement',
      'CreateLink',
      'CheckNameResult',
      'Error',
    ]) {
      expect(schemas[name], `component ${name}`).toBeTruthy();
    }
  });

  it('wires POST /api/projects/{id}/requirements to the CreateRequirement body schema', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const op = doc.paths['/api/projects/{id}/requirements'].post;
    const ref = op.requestBody.content['application/json'].schema.$ref;
    expect(ref).toBe('#/components/schemas/CreateRequirement');
  });

  it('GET /docs → 200 and serves Swagger UI HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');
  });

  it('documents every AI path (config, models, chat, generate-description, import)', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const paths = Object.keys(doc.paths);
    expect(paths).toContain('/api/ai/config');
    expect(paths).toContain('/api/ai/models');
    expect(paths).toContain('/api/ai/chat');
    expect(paths).toContain('/api/ai/generate-description');
    expect(paths).toContain('/api/projects/{id}/ai-import');
    expect(paths).toContain('/api/ai-import/{jobId}');
    expect(paths).toContain('/api/ai-import/{jobId}/cancel');
    // GET /api/ai/config carries both read (GET) and write (PUT) operations.
    expect(doc.paths['/api/ai/config'].get).toBeTruthy();
    expect(doc.paths['/api/ai/config'].put).toBeTruthy();
  });

  it('declares the `ai` tag', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const tagNames = (doc.tags as { name: string }[]).map((t) => t.name);
    expect(tagNames).toContain('ai');
    for (const op of [
      doc.paths['/api/ai/config'].get,
      doc.paths['/api/ai/models'].get,
      doc.paths['/api/ai/chat'].post,
      doc.paths['/api/projects/{id}/ai-import'].post,
    ]) {
      expect(op.tags).toContain('ai');
    }
  });

  it('exposes the AI request/response component schemas', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const schemas = doc.components?.schemas ?? {};
    for (const name of [
      'AiConfigView',
      'AiConfigUpdate',
      'AiModelsView',
      'GenerateDescriptionRequest',
      'GenerateDescriptionResponse',
      'AiChatRequest',
      'AiChatResponse',
      'AiImportJobView',
      'AiImportStartResponse',
    ]) {
      expect(schemas[name], `component ${name}`).toBeTruthy();
    }
  });

  it('never exposes apiKey in the AiConfigView response schema', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const view = doc.components.schemas.AiConfigView;
    expect(view.properties.apiKey).toBeUndefined();
    expect(Object.keys(view.properties)).toEqual(expect.arrayContaining(['baseURL', 'hasApiKey']));
    // The read endpoint returns exactly this key-less view.
    const getOp = doc.paths['/api/ai/config'].get;
    expect(getOp.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/AiConfigView',
    );
  });

  it('wires the AI bodies and the 202 import start response', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const putBody =
      doc.paths['/api/ai/config'].put.requestBody.content['application/json'].schema.$ref;
    expect(putBody).toBe('#/components/schemas/AiConfigUpdate');
    const chatBody =
      doc.paths['/api/ai/chat'].post.requestBody.content['application/json'].schema.$ref;
    expect(chatBody).toBe('#/components/schemas/AiChatRequest');
    const genBody =
      doc.paths['/api/ai/generate-description'].post.requestBody.content['application/json'].schema
        .$ref;
    expect(genBody).toBe('#/components/schemas/GenerateDescriptionRequest');
    // Import start is multipart and answers 202 with a jobId.
    const importOp = doc.paths['/api/projects/{id}/ai-import'].post;
    expect(importOp.requestBody.content['multipart/form-data']).toBeTruthy();
    expect(importOp.responses['202'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/AiImportStartResponse',
    );
    // Job poll returns the job view.
    const jobOp = doc.paths['/api/ai-import/{jobId}'].get;
    expect(jobOp.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/AiImportJobView',
    );
    expect(jobOp.responses['404']).toBeTruthy();
  });

  it('does not break the existing project lifecycle', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Doc' },
    });
    expect(created.statusCode).toBe(201);
    const req = await app.inject({
      method: 'POST',
      url: '/api/projects/Doc/requirements',
      payload: { type: 'FUNCTION', name: 'Login', criticality: 'HIGH', implemented: true },
    });
    expect(req.statusCode).toBe(201);
    expect(req.json().slug).toBe('login');
  });
});
