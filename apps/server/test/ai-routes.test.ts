import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { AiClient, AiClientFactory } from '../src/services/AiHubService.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

const SECRET = 'sk-secret-key';

/** A mock client factory whose behaviour tests can reconfigure per case. */
function makeFactory(client: AiClient): AiClientFactory & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const factory = ((apiKey: string, baseURL: string) => {
    calls.push([apiKey, baseURL]);
    return client;
  }) as AiClientFactory & { calls: Array<[string, string]> };
  factory.calls = calls;
  return factory;
}

function okClient(): AiClient {
  return {
    models: { list: vi.fn(async () => ({ data: [{ id: 'GigaChat-2-Pro' }, { id: 'GigaChat' }] })) },
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: 'Сгенерированное описание.' } }],
        })),
      },
    },
  };
}

describe('T-802 AI routes (integration, mock client)', () => {
  let root: string;
  let app: FastifyInstance;
  let factory: ReturnType<typeof makeFactory>;

  async function boot(client: AiClient): Promise<void> {
    factory = makeFactory(client);
    app = await buildApp({
      projectsRoot: root,
      now: fixedNow,
      logger: false,
      makeAiClient: factory,
    });
  }

  beforeEach(async () => {
    root = await makeTmpRoot();
  });
  afterEach(async () => {
    if (app) await app.close();
    await cleanup(root);
  });

  it('GET /api/ai/config returns defaults and never the key', async () => {
    await boot(okClient());
    const res = await app.inject({ method: 'GET', url: '/api/ai/config?projectId=Demo' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ baseURL: 'https://api.ai.sbt/openai/v1', hasApiKey: false });
  });

  it('PUT /api/ai/config round-trips and never leaks the key', async () => {
    await boot(okClient());
    const put = await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: {
        baseURL: 'https://stub.test/v1',
        apiKey: SECRET,
        projectId: 'Demo',
        model: 'GigaChat-2-Pro',
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(SECRET);
    expect(put.json()).toEqual({
      baseURL: 'https://stub.test/v1',
      hasApiKey: true,
      model: 'GigaChat-2-Pro',
    });

    const get = await app.inject({ method: 'GET', url: '/api/ai/config?projectId=Demo' });
    expect(get.json()).toMatchObject({ hasApiKey: true, model: 'GigaChat-2-Pro' });
    expect(get.body).not.toContain(SECRET);
  });

  it('PUT /api/ai/config rejects an invalid baseURL with 400', async () => {
    await boot(okClient());
    const res = await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { baseURL: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/ai/models lists sorted models via the stored config', async () => {
    await boot(okClient());
    await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: SECRET, baseURL: 'https://stub.test/v1' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/ai/models' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ models: ['GigaChat', 'GigaChat-2-Pro'] });
    // baseURL for the client comes from the saved config (e2e-stub contract).
    expect(factory.calls[0]).toEqual([SECRET, 'https://stub.test/v1']);
  });

  it('GET /api/ai/models returns 400 when no key is configured', async () => {
    await boot(okClient());
    const res = await app.inject({ method: 'GET', url: '/api/ai/models' });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/ai/generate-description happy path', async () => {
    await boot(okClient());
    await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: SECRET, projectId: 'Demo', model: 'GigaChat-2-Pro' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-description',
      payload: {
        projectId: 'Demo',
        requirement: { name: 'Login', type: 'FUNCTION', criticality: 'HIGH' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ description: 'Сгенерированное описание.' });
  });

  it('POST /api/ai/generate-description returns 400 when no config (no key/model)', async () => {
    await boot(okClient());
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-description',
      payload: {
        projectId: 'Demo',
        requirement: { name: 'Login', type: 'FUNCTION', criticality: 'HIGH' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/ai/generate-description returns 400 for an invalid body', async () => {
    await boot(okClient());
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-description',
      payload: {
        projectId: 'Demo',
        requirement: { name: '', type: 'FUNCTION', criticality: 'HIGH' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/ai/chat happy path returns an assistant message', async () => {
    const client = okClient();
    (client.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      choices: [{ message: { content: '  Ответ ассистента.  ' } }],
    });
    await boot(client);
    await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: SECRET, projectId: 'Demo', model: 'GigaChat-2-Pro' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      payload: {
        projectId: 'Demo',
        messages: [{ role: 'user', content: 'Помоги сформулировать требование' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      message: { role: 'assistant', content: 'Ответ ассистента.' },
    });
    const createMock = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'GigaChat-2-Pro', temperature: 0.7, max_tokens: 1000 }),
    );
  });

  it('POST /api/ai/chat prefers the model override from the body', async () => {
    const client = okClient();
    await boot(client);
    await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: SECRET, projectId: 'Demo', model: 'ProjectModel' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      payload: {
        projectId: 'Demo',
        model: 'OverrideModel',
        messages: [{ role: 'user', content: 'Привет' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const createMock = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ model: 'OverrideModel' }));
  });

  it('POST /api/ai/chat returns 400 for an invalid body (bad role / empty history)', async () => {
    await boot(okClient());
    const badRole = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      payload: { messages: [{ role: 'system', content: 'x' }] },
    });
    expect(badRole.statusCode).toBe(400);
    const empty = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      payload: { messages: [] },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('POST /api/ai/chat returns 400 when no key or no model is configured', async () => {
    await boot(okClient());
    const noKey = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      payload: { messages: [{ role: 'user', content: 'Привет' }] },
    });
    expect(noKey.statusCode).toBe(400);

    await app.inject({ method: 'PUT', url: '/api/ai/config', payload: { apiKey: SECRET } });
    const noModel = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      payload: { messages: [{ role: 'user', content: 'Привет' }] },
    });
    expect(noModel.statusCode).toBe(400);
    expect(noModel.json().message).toContain('No AI model is selected');
  });

  it('PUT /api/ai/config with apiKey: null deletes the stored key (T-1001)', async () => {
    await boot(okClient());
    await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: SECRET, projectId: 'Demo', model: 'GigaChat-2-Pro' },
    });

    const del = await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: null },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ baseURL: 'https://api.ai.sbt/openai/v1', hasApiKey: false });

    // The per-project model survives key deletion (PO decision §3).
    const get = await app.inject({ method: 'GET', url: '/api/ai/config?projectId=Demo' });
    expect(get.json()).toEqual({
      baseURL: 'https://api.ai.sbt/openai/v1',
      hasApiKey: false,
      model: 'GigaChat-2-Pro',
    });

    // Without a key, models/chat report "not configured" (400).
    const models = await app.inject({ method: 'GET', url: '/api/ai/models' });
    expect(models.statusCode).toBe(400);
    const chat = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      payload: { projectId: 'Demo', messages: [{ role: 'user', content: 'Привет' }] },
    });
    expect(chat.statusCode).toBe(400);
  });

  it("PUT /api/ai/config with apiKey: '' still keeps the stored key (T-1001)", async () => {
    await boot(okClient());
    await app.inject({ method: 'PUT', url: '/api/ai/config', payload: { apiKey: SECRET } });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasApiKey: true });
  });

  it('PUT /api/ai/config with apiKey: null on an empty config does not fail (T-1001)', async () => {
    await boot(okClient());
    const res = await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ baseURL: 'https://api.ai.sbt/openai/v1', hasApiKey: false });
  });

  it('POST /api/ai/chat maps upstream failure to 502 without the key', async () => {
    const boom = okClient();
    (boom.chat.completions.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(`chat upstream down key=${SECRET}`),
    );
    await boot(boom);
    await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: SECRET, projectId: 'Demo', model: 'GigaChat-2-Pro' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      payload: { projectId: 'Demo', messages: [{ role: 'user', content: 'Привет' }] },
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(SECRET);
  });

  it('POST /api/ai/generate-description maps upstream failure to 502 without the key', async () => {
    const boom = okClient();
    (boom.chat.completions.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(`upstream down key=${SECRET}`),
    );
    await boot(boom);
    await app.inject({
      method: 'PUT',
      url: '/api/ai/config',
      payload: { apiKey: SECRET, projectId: 'Demo', model: 'GigaChat-2-Pro' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-description',
      payload: {
        projectId: 'Demo',
        requirement: { name: 'Login', type: 'FUNCTION', criticality: 'HIGH' },
      },
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(SECRET);
  });
});
