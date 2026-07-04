import { describe, expect, it } from 'vitest';
import {
  AI_CHAT_HISTORY_LIMIT,
  AI_CHAT_MAX_TOKENS,
  AI_CHAT_TEMPERATURE,
  AI_DEFAULT_BASE_URL,
  AI_GEN_MAX_TOKENS,
  AI_GEN_TEMPERATURE,
  aiChatMessageSchema,
  aiChatRequestSchema,
  aiChatResponseSchema,
  aiConfigUpdateSchema,
  aiConfigViewSchema,
  aiModelsViewSchema,
  generateDescriptionRequestSchema,
  generateDescriptionResponseSchema,
} from './ai.js';

describe('T-801 AI contract constants', () => {
  it('exposes the PO-decided defaults', () => {
    expect(AI_DEFAULT_BASE_URL).toBe('https://api.ai.sbt/openai/v1');
    expect(AI_GEN_TEMPERATURE).toBe(0.4);
    expect(AI_GEN_MAX_TOKENS).toBe(700);
  });
});

describe('T-801 aiConfigViewSchema', () => {
  it('accepts a view without a key (only hasApiKey)', () => {
    const v = aiConfigViewSchema.parse({ baseURL: AI_DEFAULT_BASE_URL, hasApiKey: true });
    expect(v).toEqual({ baseURL: AI_DEFAULT_BASE_URL, hasApiKey: true });
  });

  it('never carries an apiKey field through the schema', () => {
    const parsed = aiConfigViewSchema.parse({
      baseURL: AI_DEFAULT_BASE_URL,
      hasApiKey: true,
      model: 'GigaChat-2-Pro',
      // extra secret field must be stripped by the object schema
      apiKey: 'sk-secret',
    } as unknown as Record<string, unknown>);
    expect(parsed).not.toHaveProperty('apiKey');
    expect(parsed.model).toBe('GigaChat-2-Pro');
  });

  it('rejects a non-boolean hasApiKey', () => {
    expect(aiConfigViewSchema.safeParse({ baseURL: 'x', hasApiKey: 'yes' }).success).toBe(false);
  });
});

describe('T-801 aiConfigUpdateSchema', () => {
  it('accepts an empty patch (all optional)', () => {
    expect(aiConfigUpdateSchema.parse({})).toEqual({});
  });

  it('accepts a full patch', () => {
    const patch = aiConfigUpdateSchema.parse({
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-1',
      projectId: 'Demo',
      model: 'GigaChat-2-Pro',
    });
    expect(patch.projectId).toBe('Demo');
  });

  it('rejects a baseURL that is not a URL', () => {
    const res = aiConfigUpdateSchema.safeParse({ baseURL: 'not a url' });
    expect(res.success).toBe(false);
  });

  it('rejects an empty projectId', () => {
    expect(aiConfigUpdateSchema.safeParse({ projectId: '' }).success).toBe(false);
  });
});

describe('T-1001 aiConfigUpdateSchema apiKey deletion contract', () => {
  it('accepts apiKey: null (delete the stored key)', () => {
    const parsed = aiConfigUpdateSchema.parse({ apiKey: null });
    expect(parsed.apiKey).toBeNull();
  });

  it('still accepts an omitted apiKey (undefined — key untouched)', () => {
    const parsed = aiConfigUpdateSchema.parse({});
    expect(parsed.apiKey).toBeUndefined();
    expect('apiKey' in parsed).toBe(false);
  });

  it('still accepts an empty-string apiKey (key untouched, task 8 semantics)', () => {
    const parsed = aiConfigUpdateSchema.parse({ apiKey: '' });
    expect(parsed.apiKey).toBe('');
  });

  it('still accepts a non-empty string apiKey', () => {
    expect(aiConfigUpdateSchema.parse({ apiKey: 'sk-new' }).apiKey).toBe('sk-new');
  });

  it('rejects non-string, non-null apiKey values', () => {
    expect(aiConfigUpdateSchema.safeParse({ apiKey: 42 }).success).toBe(false);
    expect(aiConfigUpdateSchema.safeParse({ apiKey: { k: 'v' } }).success).toBe(false);
    expect(aiConfigUpdateSchema.safeParse({ apiKey: false }).success).toBe(false);
  });

  it('accepts apiKey: null alongside other fields (partial update)', () => {
    const parsed = aiConfigUpdateSchema.parse({
      apiKey: null,
      baseURL: 'https://example.test/v1',
      projectId: 'Demo',
      model: 'GigaChat-2-Pro',
    });
    expect(parsed).toEqual({
      apiKey: null,
      baseURL: 'https://example.test/v1',
      projectId: 'Demo',
      model: 'GigaChat-2-Pro',
    });
  });
});

describe('T-801 aiModelsViewSchema', () => {
  it('accepts a list of model ids', () => {
    expect(aiModelsViewSchema.parse({ models: ['a', 'b'] }).models).toEqual(['a', 'b']);
  });

  it('rejects non-string entries', () => {
    expect(aiModelsViewSchema.safeParse({ models: [1] }).success).toBe(false);
  });
});

describe('T-801 generateDescriptionRequestSchema', () => {
  const base = {
    projectId: 'Demo',
    requirement: { name: 'Login', type: 'FUNCTION', criticality: 'HIGH' },
  };

  it('accepts a minimal valid request', () => {
    const parsed = generateDescriptionRequestSchema.parse(base);
    expect(parsed.requirement.type).toBe('FUNCTION');
  });

  it('accepts optional context fields', () => {
    const parsed = generateDescriptionRequestSchema.parse({
      ...base,
      projectName: 'Demo project',
      projectDescription: 'desc',
      userHint: 'focus on security',
      requirement: { ...base.requirement, description: 'existing' },
    });
    expect(parsed.userHint).toBe('focus on security');
  });

  it('rejects a missing projectId', () => {
    expect(
      generateDescriptionRequestSchema.safeParse({ requirement: base.requirement }).success,
    ).toBe(false);
  });

  it('rejects an unknown requirement type', () => {
    const res = generateDescriptionRequestSchema.safeParse({
      ...base,
      requirement: { ...base.requirement, type: 'BUG' },
    });
    expect(res.success).toBe(false);
  });

  it('rejects an empty requirement name', () => {
    const res = generateDescriptionRequestSchema.safeParse({
      ...base,
      requirement: { ...base.requirement, name: '' },
    });
    expect(res.success).toBe(false);
  });
});

describe('T-801 generateDescriptionResponseSchema', () => {
  it('accepts a description string', () => {
    expect(generateDescriptionResponseSchema.parse({ description: 'text' }).description).toBe(
      'text',
    );
  });
});

describe('T-901 AI chat contract constants', () => {
  it('exposes the PO-decided chat parameters', () => {
    expect(AI_CHAT_TEMPERATURE).toBe(0.7);
    expect(AI_CHAT_MAX_TOKENS).toBe(1000);
    expect(AI_CHAT_HISTORY_LIMIT).toBe(20);
  });
});

describe('T-901 aiChatMessageSchema', () => {
  it('accepts user and assistant messages', () => {
    expect(aiChatMessageSchema.parse({ role: 'user', content: 'Привет' })).toEqual({
      role: 'user',
      content: 'Привет',
    });
    expect(aiChatMessageSchema.safeParse({ role: 'assistant', content: 'Ответ' }).success).toBe(
      true,
    );
  });

  it('rejects an empty content', () => {
    expect(aiChatMessageSchema.safeParse({ role: 'user', content: '' }).success).toBe(false);
  });

  it('rejects a content over 8000 characters', () => {
    const content = 'x'.repeat(8001);
    expect(aiChatMessageSchema.safeParse({ role: 'user', content }).success).toBe(false);
    expect(aiChatMessageSchema.safeParse({ role: 'user', content: content.slice(1) }).success).toBe(
      true,
    );
  });

  it('rejects unknown roles (system is server-side only)', () => {
    expect(aiChatMessageSchema.safeParse({ role: 'system', content: 'x' }).success).toBe(false);
    expect(aiChatMessageSchema.safeParse({ role: 'bot', content: 'x' }).success).toBe(false);
  });
});

describe('T-901 aiChatRequestSchema', () => {
  const msg = { role: 'user', content: 'Сформулируй критерии приёмки' };

  it('accepts a minimal request (messages only)', () => {
    const parsed = aiChatRequestSchema.parse({ messages: [msg] });
    expect(parsed.projectId).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.messages).toHaveLength(1);
  });

  it('accepts optional projectId and model override', () => {
    const parsed = aiChatRequestSchema.parse({
      projectId: 'Demo',
      model: 'GigaChat-2-Pro',
      messages: [msg],
    });
    expect(parsed.model).toBe('GigaChat-2-Pro');
  });

  it('rejects an empty projectId or model', () => {
    expect(aiChatRequestSchema.safeParse({ projectId: '', messages: [msg] }).success).toBe(false);
    expect(aiChatRequestSchema.safeParse({ model: '', messages: [msg] }).success).toBe(false);
  });

  it('rejects an empty messages array', () => {
    expect(aiChatRequestSchema.safeParse({ messages: [] }).success).toBe(false);
  });

  it('rejects more than AI_CHAT_HISTORY_LIMIT messages', () => {
    const many = Array.from({ length: AI_CHAT_HISTORY_LIMIT + 1 }, () => msg);
    expect(aiChatRequestSchema.safeParse({ messages: many }).success).toBe(false);
    expect(aiChatRequestSchema.safeParse({ messages: many.slice(1) }).success).toBe(true);
  });

  it('rejects an invalid message inside the array', () => {
    const res = aiChatRequestSchema.safeParse({ messages: [{ role: 'system', content: 'x' }] });
    expect(res.success).toBe(false);
  });
});

describe('T-901 aiChatResponseSchema', () => {
  it('accepts an assistant message', () => {
    const parsed = aiChatResponseSchema.parse({ message: { role: 'assistant', content: 'Ок' } });
    expect(parsed.message.role).toBe('assistant');
  });

  it('rejects a response without a message', () => {
    expect(aiChatResponseSchema.safeParse({}).success).toBe(false);
  });
});
