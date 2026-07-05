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

// ── Task 11: AI import contract ─────────────────────────────────────────────
import {
  AI_IMPORT_CHUNK_CHARS,
  AI_IMPORT_MAX_ARCHIVE_BYTES,
  AI_IMPORT_MAX_DOC_FILES,
  AI_IMPORT_MAX_TOKENS,
  AI_IMPORT_STAGES,
  AI_IMPORT_STATUSES,
  AI_IMPORT_STRUCTURE_BATCH,
  AI_IMPORT_STRUCTURE_MAX_TOKENS,
  AI_IMPORT_TEMPERATURE,
  aiExtractedRequirementSchema,
  aiImportJobViewSchema,
  aiImportLogEntrySchema,
  aiImportResultSchema,
  aiImportStartResponseSchema,
  aiStructureNodeSchema,
} from './ai.js';
import { requirementCreateShape } from './contracts.js';

describe('T11 AI import contract constants', () => {
  it('exposes the PO-decided extraction parameters', () => {
    expect(AI_IMPORT_TEMPERATURE).toBe(0.2);
    expect(AI_IMPORT_MAX_TOKENS).toBe(2000);
    expect(AI_IMPORT_CHUNK_CHARS).toBe(12_000);
    expect(AI_IMPORT_MAX_ARCHIVE_BYTES).toBe(50 * 1024 * 1024);
    expect(AI_IMPORT_MAX_DOC_FILES).toBe(500);
  });

  it('T14 B1: structure stage gets its own token budget and a smaller batch', () => {
    // A 100-node batch serialises to ~3000–5000 tokens (Cyrillic JSON), which
    // the shared 2000-token budget always truncated → flat trees. 50 nodes fit
    // comfortably into 4000 tokens.
    expect(AI_IMPORT_STRUCTURE_MAX_TOKENS).toBe(4000);
    expect(AI_IMPORT_STRUCTURE_BATCH).toBe(50);
    expect(AI_IMPORT_STRUCTURE_MAX_TOKENS).toBeGreaterThan(AI_IMPORT_MAX_TOKENS);
  });

  it('exposes the stage and status unions (Task 13: structure between analyze and aggregate)', () => {
    expect(AI_IMPORT_STAGES).toEqual([
      'unpack',
      'analyze',
      'structure',
      'aggregate',
      'populate',
      'done',
    ]);
    expect(AI_IMPORT_STATUSES).toEqual(['running', 'succeeded', 'failed', 'cancelled']);
  });
});

describe('T13 aiStructureNodeSchema (structure-stage answer contract)', () => {
  it('accepts a child node with a string parentName', () => {
    const node = aiStructureNodeSchema.parse({
      type: 'FUNCTION',
      name: 'Вход по паролю',
      parentName: 'Аутентификация',
    });
    expect(node.parentName).toBe('Аутентификация');
  });

  it('accepts a root node with an explicit null parentName', () => {
    const node = aiStructureNodeSchema.parse({
      type: 'NFR',
      name: 'Время отклика',
      parentName: null,
    });
    expect(node.parentName).toBeNull();
  });

  it('rejects a node without parentName (roots must say null explicitly)', () => {
    expect(aiStructureNodeSchema.safeParse({ type: 'FUNCTION', name: 'X' }).success).toBe(false);
  });

  it('rejects an unknown type and an empty or overlong name', () => {
    expect(
      aiStructureNodeSchema.safeParse({ type: 'EPIC', name: 'X', parentName: null }).success,
    ).toBe(false);
    expect(
      aiStructureNodeSchema.safeParse({ type: 'FUNCTION', name: '', parentName: null }).success,
    ).toBe(false);
    expect(
      aiStructureNodeSchema.safeParse({
        type: 'FUNCTION',
        name: 'x'.repeat(201),
        parentName: null,
      }).success,
    ).toBe(false);
  });

  it('strips unknown keys (extraction-style extras are ignored, not fatal)', () => {
    const node = aiStructureNodeSchema.parse({
      type: 'FUNCTION',
      name: 'Вход',
      parentName: null,
      description: 'лишнее',
      source: 'a.md § 1',
    });
    expect(node).toEqual({ type: 'FUNCTION', name: 'Вход', parentName: null });
  });
});

describe('T11 aiImportLogEntrySchema', () => {
  it('accepts a valid entry', () => {
    const e = aiImportLogEntrySchema.parse({
      ts: '2026-06-29T10:00:00.000Z',
      level: 'info',
      message: 'распаковка завершена',
    });
    expect(e.level).toBe('info');
  });

  it('rejects an unknown level', () => {
    expect(
      aiImportLogEntrySchema.safeParse({ ts: 't', level: 'debug', message: 'x' }).success,
    ).toBe(false);
  });
});

describe('T11 aiImportResultSchema', () => {
  it('accepts non-negative integer counters', () => {
    const r = aiImportResultSchema.parse({
      createdFunctions: 2,
      createdNfrs: 1,
      skippedExisting: 0,
      links: 1,
    });
    expect(r.createdFunctions).toBe(2);
  });

  it('rejects negative or fractional counters', () => {
    expect(
      aiImportResultSchema.safeParse({
        createdFunctions: -1,
        createdNfrs: 0,
        skippedExisting: 0,
        links: 0,
      }).success,
    ).toBe(false);
    expect(
      aiImportResultSchema.safeParse({
        createdFunctions: 0.5,
        createdNfrs: 0,
        skippedExisting: 0,
        links: 0,
      }).success,
    ).toBe(false);
  });
});

describe('T11 aiImportJobViewSchema', () => {
  const base = {
    jobId: 'j1',
    projectId: 'Demo',
    status: 'running',
    stage: 'analyze',
    progress: 42,
    log: [{ ts: 't', level: 'warn', message: 'm' }],
  };

  it('accepts a running job without result/error', () => {
    const v = aiImportJobViewSchema.parse(base);
    expect(v.result).toBeUndefined();
    expect(v.error).toBeUndefined();
  });

  it('accepts a succeeded job with a result', () => {
    const v = aiImportJobViewSchema.parse({
      ...base,
      status: 'succeeded',
      stage: 'done',
      progress: 100,
      result: { createdFunctions: 1, createdNfrs: 0, skippedExisting: 2, links: 0 },
    });
    expect(v.result?.skippedExisting).toBe(2);
  });

  it('accepts a failed job with message + hint', () => {
    const v = aiImportJobViewSchema.parse({
      ...base,
      status: 'failed',
      error: { message: 'boom', hint: 'что делать' },
    });
    expect(v.error?.hint).toBe('что делать');
  });

  it('rejects progress outside 0..100 and unknown stage/status', () => {
    expect(aiImportJobViewSchema.safeParse({ ...base, progress: 101 }).success).toBe(false);
    expect(aiImportJobViewSchema.safeParse({ ...base, progress: -1 }).success).toBe(false);
    expect(aiImportJobViewSchema.safeParse({ ...base, stage: 'zip' }).success).toBe(false);
    expect(aiImportJobViewSchema.safeParse({ ...base, status: 'paused' }).success).toBe(false);
  });
});

describe('T11 aiImportStartResponseSchema', () => {
  it('accepts a jobId and rejects a missing one', () => {
    expect(aiImportStartResponseSchema.parse({ jobId: 'j1' }).jobId).toBe('j1');
    expect(aiImportStartResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('T11 aiExtractedRequirementSchema', () => {
  const minimal = {
    type: 'FUNCTION',
    name: 'Вход по паролю',
    description: 'Пользователь входит по email и паролю.',
    source: 'auth.md § Вход',
  };

  it('accepts a minimal record (source is mandatory)', () => {
    const r = aiExtractedRequirementSchema.parse(minimal);
    expect(r.source).toBe('auth.md § Вход');
    expect(r.criticality).toBeUndefined();
  });

  it('accepts all optional fields', () => {
    const r = aiExtractedRequirementSchema.parse({
      ...minimal,
      criticality: 'HIGH',
      implemented: false,
      targetQuarter: 'Q3',
      targetYear: 2026,
      parentName: 'Аутентификация',
    });
    expect(r.targetQuarter).toBe('Q3');
    expect(r.parentName).toBe('Аутентификация');
  });

  it('rejects a record without source or with an empty source', () => {
    const { source: _source, ...noSource } = minimal;
    expect(aiExtractedRequirementSchema.safeParse(noSource).success).toBe(false);
    expect(aiExtractedRequirementSchema.safeParse({ ...minimal, source: '' }).success).toBe(false);
  });

  it('rejects unknown type/criticality/quarter and out-of-limit lengths', () => {
    expect(aiExtractedRequirementSchema.safeParse({ ...minimal, type: 'BUG' }).success).toBe(false);
    expect(
      aiExtractedRequirementSchema.safeParse({ ...minimal, criticality: 'URGENT' }).success,
    ).toBe(false);
    expect(
      aiExtractedRequirementSchema.safeParse({ ...minimal, targetQuarter: 'Q5' }).success,
    ).toBe(false);
    expect(
      aiExtractedRequirementSchema.safeParse({ ...minimal, name: 'x'.repeat(201) }).success,
    ).toBe(false);
    expect(
      aiExtractedRequirementSchema.safeParse({ ...minimal, source: 'x'.repeat(301) }).success,
    ).toBe(false);
    expect(aiExtractedRequirementSchema.safeParse({ ...minimal, description: '' }).success).toBe(
      false,
    );
    expect(aiExtractedRequirementSchema.safeParse({ ...minimal, targetYear: 2026.5 }).success).toBe(
      false,
    );
  });

  it('bounds targetYear exactly like the requirement creation contract (2020–2100)', () => {
    // An extracted record with a year the create contract rejects must be
    // dropped at the parsing stage, not fail later inside populate.
    expect(aiExtractedRequirementSchema.safeParse({ ...minimal, targetYear: 2019 }).success).toBe(
      false,
    );
    expect(aiExtractedRequirementSchema.safeParse({ ...minimal, targetYear: 2101 }).success).toBe(
      false,
    );
    expect(aiExtractedRequirementSchema.safeParse({ ...minimal, targetYear: 2020 }).success).toBe(
      true,
    );
    expect(aiExtractedRequirementSchema.safeParse({ ...minimal, targetYear: 2100 }).success).toBe(
      true,
    );
    // Single source of truth: same field validator as requirementCreateShape.
    expect(aiExtractedRequirementSchema.shape.targetYear).toBe(requirementCreateShape.targetYear);
  });
});
