import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiChatRequest, GenerateDescriptionRequest } from '@po/core';
import { AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { AiHubService, type AiClient, type AiClientFactory } from '../src/services/AiHubService.js';
import { cleanup, makeTmpRoot } from './helpers.js';

const SECRET = 'sk-super-secret';

function mockClient(overrides: Partial<AiClient> = {}): AiClient {
  return {
    models: { list: vi.fn(async () => ({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] })) },
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: '  Готовое описание.  ' } }],
        })),
      },
    },
    ...overrides,
  };
}

const genInput: GenerateDescriptionRequest = {
  projectId: 'Demo',
  requirement: { name: 'Login', type: 'FUNCTION', criticality: 'HIGH' },
};

describe('T-802 AiHubService', () => {
  let root: string;
  let repo: AiConfigRepo;

  beforeEach(async () => {
    root = await makeTmpRoot();
    repo = new AiConfigRepo(root);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  function service(make: AiClientFactory): AiHubService {
    return new AiHubService({ repo, makeClient: make });
  }

  describe('listModels', () => {
    it('returns sorted, de-duplicated model ids using the stored key + baseURL', async () => {
      await repo.update({ apiKey: SECRET, baseURL: 'https://stub.test/v1' });
      const make = vi.fn(() => mockClient());
      const models = await service(make).listModels();
      expect(models).toEqual(['a', 'b']);
      expect(make).toHaveBeenCalledWith(SECRET, 'https://stub.test/v1');
    });

    it('throws 400 when no key is configured', async () => {
      await expect(service(() => mockClient()).listModels()).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('maps an upstream failure to AI_UPSTREAM (502) without leaking the key', async () => {
      await repo.update({ apiKey: SECRET });
      const boom = mockClient({
        models: {
          list: vi.fn(async () => {
            throw new Error(`network error for key ${SECRET}`);
          }),
        },
      });
      const err = await service(() => boom)
        .listModels()
        .catch((e) => e as Error & { code: string });
      expect(err.code).toBe('AI_UPSTREAM');
      expect(err.message).not.toContain(SECRET);
      expect(err.message).toContain('***');
    });
  });

  describe('generateDescription', () => {
    it('returns the trimmed content and passes temperature/max_tokens', async () => {
      await repo.update({ apiKey: SECRET, projectId: 'Demo', model: 'GigaChat-2-Pro' });
      const client = mockClient();
      const out = await service(() => client).generateDescription(genInput);
      expect(out).toBe('Готовое описание.');
      const createMock = client.chat.completions.create as ReturnType<typeof vi.fn>;
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'GigaChat-2-Pro',
          temperature: 0.4,
          max_tokens: 700,
        }),
      );
    });

    it('throws 400 when no key is configured', async () => {
      await expect(service(() => mockClient()).generateDescription(genInput)).rejects.toMatchObject(
        {
          code: 'BAD_REQUEST',
        },
      );
    });

    it('throws 400 when no model is selected for the project', async () => {
      await repo.update({ apiKey: SECRET });
      await expect(service(() => mockClient()).generateDescription(genInput)).rejects.toMatchObject(
        {
          code: 'BAD_REQUEST',
        },
      );
    });

    it('maps upstream errors to AI_UPSTREAM (502) without leaking the key', async () => {
      await repo.update({ apiKey: SECRET, projectId: 'Demo', model: 'M' });
      const boom = mockClient({
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw new Error(`429 too many, key=${SECRET}`);
            }),
          },
        },
      });
      const err = await service(() => boom)
        .generateDescription(genInput)
        .catch((e) => e as Error & { code: string });
      expect(err.code).toBe('AI_UPSTREAM');
      expect(err.message).not.toContain(SECRET);
    });

    it('treats an empty completion as an upstream error', async () => {
      await repo.update({ apiKey: SECRET, projectId: 'Demo', model: 'M' });
      const empty = mockClient({
        chat: {
          completions: {
            create: vi.fn(async () => ({ choices: [{ message: { content: '   ' } }] })),
          },
        },
      });
      await expect(service(() => empty).generateDescription(genInput)).rejects.toMatchObject({
        code: 'AI_UPSTREAM',
      });
    });
  });

  describe('chat (T-901)', () => {
    const chatInput: AiChatRequest = {
      projectId: 'Demo',
      messages: [{ role: 'user', content: 'Как сформулировать критерии приёмки?' }],
    };

    it('returns the trimmed reply and sends system prompt + history with chat params', async () => {
      await repo.update({ apiKey: SECRET, projectId: 'Demo', model: 'GigaChat-2-Pro' });
      const client = mockClient({
        chat: {
          completions: {
            create: vi.fn(async () => ({ choices: [{ message: { content: '  Ответ бота.  ' } }] })),
          },
        },
      });
      const out = await service(() => client).chat(chatInput);
      expect(out).toBe('Ответ бота.');
      const createMock = client.chat.completions.create as ReturnType<typeof vi.fn>;
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'GigaChat-2-Pro',
          temperature: 0.7,
          max_tokens: 1000,
        }),
      );
      const params = createMock.mock.calls[0][0] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(params.messages[0].role).toBe('system');
      expect(params.messages.slice(1)).toEqual(chatInput.messages);
    });

    it('prefers the model override from the request over the project model', async () => {
      await repo.update({ apiKey: SECRET, projectId: 'Demo', model: 'ProjectModel' });
      const client = mockClient();
      await service(() => client).chat({ ...chatInput, model: 'OverrideModel' });
      const createMock = client.chat.completions.create as ReturnType<typeof vi.fn>;
      expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ model: 'OverrideModel' }));
    });

    it('uses the override even without a projectId', async () => {
      await repo.update({ apiKey: SECRET });
      const client = mockClient();
      await service(() => client).chat({ messages: chatInput.messages, model: 'OverrideModel' });
      const createMock = client.chat.completions.create as ReturnType<typeof vi.fn>;
      expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ model: 'OverrideModel' }));
    });

    it('throws 400 when no key is configured', async () => {
      await expect(service(() => mockClient()).chat(chatInput)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'AI Hub API key is not configured.',
      });
    });

    it('throws 400 when no model can be resolved (no override, no project model)', async () => {
      await repo.update({ apiKey: SECRET });
      await expect(
        service(() => mockClient()).chat({ messages: chatInput.messages }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'No AI model is selected. Choose a model in the chat or configure the project.',
      });
      // Same when a projectId is given but has no configured model.
      await expect(service(() => mockClient()).chat(chatInput)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('maps upstream errors to AI_UPSTREAM (502) without leaking the key', async () => {
      await repo.update({ apiKey: SECRET, projectId: 'Demo', model: 'M' });
      const boom = mockClient({
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw new Error(`503 unavailable, key=${SECRET}`);
            }),
          },
        },
      });
      const err = await service(() => boom)
        .chat(chatInput)
        .catch((e) => e as Error & { code: string });
      expect(err.code).toBe('AI_UPSTREAM');
      expect(err.message).not.toContain(SECRET);
      expect(err.message).toContain('***');
    });

    it('treats an empty completion as an upstream error', async () => {
      await repo.update({ apiKey: SECRET, projectId: 'Demo', model: 'M' });
      const empty = mockClient({
        chat: {
          completions: {
            create: vi.fn(async () => ({ choices: [{ message: { content: '' } }] })),
          },
        },
      });
      await expect(service(() => empty).chat(chatInput)).rejects.toMatchObject({
        code: 'AI_UPSTREAM',
        message: 'AI Hub returned an empty chat response.',
      });
    });
  });
});
