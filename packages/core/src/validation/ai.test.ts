import { describe, expect, it } from 'vitest';
import {
  AI_DEFAULT_BASE_URL,
  AI_GEN_MAX_TOKENS,
  AI_GEN_TEMPERATURE,
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
