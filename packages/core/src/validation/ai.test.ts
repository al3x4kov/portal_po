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
  AI_IMPORT_PO_ASSIGN_BATCH,
  AI_IMPORT_PO_GROUP_NAME_MAX,
  AI_IMPORT_PO_MAX_CHILDREN,
  AI_IMPORT_PO_MAX_ROOTS,
  AI_IMPORT_PO_TAXONOMY_BATCH,
  AI_TESTGEN_BATCH,
  AI_TESTGEN_MAX_SLUGS,
  TEST_MODEL_KINDS,
  aiExtractedRequirementSchema,
  aiGenerateTestsRequestSchema,
  aiGenerateTestsResponseSchema,
  aiTestCaseSchema,
  aiImportBuildTreeFieldSchema,
  aiImportJobViewSchema,
  aiImportLogEntrySchema,
  aiImportResultSchema,
  aiImportStartResponseSchema,
  aiPoAssignmentSchema,
  aiStructureNodeSchema,
} from './ai.js';
import { requirementCreateShape } from './contracts.js';

describe('T11 AI import contract constants', () => {
  it('exposes the PO-decided extraction parameters', () => {
    expect(AI_IMPORT_TEMPERATURE).toBe(0.2);
    expect(AI_IMPORT_MAX_TOKENS).toBe(2000);
    expect(AI_IMPORT_CHUNK_CHARS).toBe(12_000);
    // todo_20 (PO decision №1): 200 МБ / 2000 text files.
    expect(AI_IMPORT_MAX_ARCHIVE_BYTES).toBe(200 * 1024 * 1024);
    expect(AI_IMPORT_MAX_DOC_FILES).toBe(2000);
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
    // todo_20 appends awaiting-confirmation / interrupted, todo_22 appends
    // awaiting-review (backlog review gate); the historical statuses stay.
    expect(AI_IMPORT_STATUSES).toEqual([
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'awaiting-confirmation',
      'interrupted',
      'awaiting-review',
    ]);
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

describe('buildTree: логическое дерево «навык AI PO» — контракт', () => {
  it('aiImportBuildTreeFieldSchema принимает только "true"/"false" и превращает в boolean', () => {
    expect(aiImportBuildTreeFieldSchema.parse('true')).toBe(true);
    expect(aiImportBuildTreeFieldSchema.parse('false')).toBe(false);
    expect(aiImportBuildTreeFieldSchema.safeParse('1').success).toBe(false);
    expect(aiImportBuildTreeFieldSchema.safeParse('').success).toBe(false);
  });

  it('константы PO-этапа: батчи и капы дерева', () => {
    expect(AI_IMPORT_PO_TAXONOMY_BATCH).toBe(150);
    expect(AI_IMPORT_PO_ASSIGN_BATCH).toBe(40);
    expect(AI_IMPORT_PO_MAX_ROOTS).toBe(16);
    expect(AI_IMPORT_PO_MAX_CHILDREN).toBe(20);
    expect(AI_IMPORT_PO_GROUP_NAME_MAX).toBe(120);
  });

  it('тест-генерация: контракт запроса/ответа и константы', () => {
    expect(TEST_MODEL_KINDS).toEqual(['smoke', 'crit-regression', 'full']);
    expect(AI_TESTGEN_BATCH).toBe(10);
    expect(AI_TESTGEN_MAX_SLUGS).toBe(30);
    const req = aiGenerateTestsRequestSchema.parse({
      projectId: 'Demo',
      kind: 'smoke',
      slugs: ['vhod'],
      negatives: true,
    });
    expect(req.kind).toBe('smoke');
    // Пустой батч и превышение лимита отвергаются.
    expect(
      aiGenerateTestsRequestSchema.safeParse({ projectId: 'Demo', kind: 'full', slugs: [] })
        .success,
    ).toBe(false);
    expect(
      aiGenerateTestsRequestSchema.safeParse({
        projectId: 'Demo',
        kind: 'full',
        slugs: Array.from({ length: AI_TESTGEN_MAX_SLUGS + 1 }, (_, i) => `s${i}`),
      }).success,
    ).toBe(false);

    const kase = aiTestCaseSchema.parse({
      slug: 'vhod',
      title: 'Вход по паролю',
      goal: 'Проверить базовый вход',
      precondition: 'Пользователь зарегистрирован',
      steps: ['Открыть форму', 'Ввести пароль'],
      expected: 'Пользователь вошёл',
    });
    expect(kase.negativeSteps).toBeUndefined();
    // Кейс без шагов невалиден.
    expect(aiTestCaseSchema.safeParse({ ...kase, steps: [] }).success).toBe(false);
    const res = aiGenerateTestsResponseSchema.parse({ cases: [kase], dropped: 1, missing: ['x'] });
    expect(res.dropped).toBe(1);
  });

  it('aiPoAssignmentSchema: узел по id либо явный null (корень)', () => {
    expect(aiPoAssignmentSchema.parse({ type: 'FUNCTION', name: 'Вход', node: 'F1.2' })).toEqual({
      type: 'FUNCTION',
      name: 'Вход',
      node: 'F1.2',
    });
    expect(aiPoAssignmentSchema.parse({ type: 'NFR', name: 'SLA', node: null }).node).toBeNull();
    // node обязателен (опущенное поле — невалидный ответ, батч ретраится).
    expect(aiPoAssignmentSchema.safeParse({ type: 'NFR', name: 'SLA' }).success).toBe(false);
    // Длинный «id» — галлюцинация, не узел таксономии.
    expect(
      aiPoAssignmentSchema.safeParse({ type: 'NFR', name: 'SLA', node: 'x'.repeat(21) }).success,
    ).toBe(false);
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
      relatesLinks: 3,
    });
    expect(r.createdFunctions).toBe(2);
    expect(r.relatesLinks).toBe(3);
  });

  it('rejects negative or fractional counters', () => {
    expect(
      aiImportResultSchema.safeParse({
        createdFunctions: -1,
        createdNfrs: 0,
        skippedExisting: 0,
        links: 0,
        relatesLinks: 0,
      }).success,
    ).toBe(false);
    expect(
      aiImportResultSchema.safeParse({
        createdFunctions: 0.5,
        createdNfrs: 0,
        skippedExisting: 0,
        links: 0,
        relatesLinks: 0,
      }).success,
    ).toBe(false);
  });

  it('T15: relatesLinks (НФТ→ФТ RELATES_TO) is a mandatory non-negative integer', () => {
    // Missing → invalid: the frontend counts on the field always being present.
    expect(
      aiImportResultSchema.safeParse({
        createdFunctions: 0,
        createdNfrs: 0,
        skippedExisting: 0,
        links: 0,
      }).success,
    ).toBe(false);
    const base = { createdFunctions: 0, createdNfrs: 0, skippedExisting: 0, links: 0 };
    expect(aiImportResultSchema.safeParse({ ...base, relatesLinks: -1 }).success).toBe(false);
    expect(aiImportResultSchema.safeParse({ ...base, relatesLinks: 1.5 }).success).toBe(false);
    expect(aiImportResultSchema.parse({ ...base, relatesLinks: 0 }).relatesLinks).toBe(0);
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
      result: {
        createdFunctions: 1,
        createdNfrs: 0,
        skippedExisting: 2,
        links: 0,
        relatesLinks: 0,
      },
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

  describe('T15 relatedFunctions (НФТ → ФТ, RELATES_TO)', () => {
    it('accepts an NFR with a list of related function names', () => {
      const r = aiExtractedRequirementSchema.parse({
        ...minimal,
        type: 'NFR',
        relatedFunctions: ['Поиск', 'Вход по паролю'],
      });
      expect(r.relatedFunctions).toEqual(['Поиск', 'Вход по паролю']);
    });

    it('is optional: an absent field stays undefined', () => {
      expect(aiExtractedRequirementSchema.parse(minimal).relatedFunctions).toBeUndefined();
    });

    it('is accepted on a FUNCTION record too (server ignores it, not a validation error)', () => {
      expect(
        aiExtractedRequirementSchema.safeParse({ ...minimal, relatedFunctions: ['Поиск'] }).success,
      ).toBe(true);
    });

    it('rejects empty names, overlong names and more than 20 entries', () => {
      expect(
        aiExtractedRequirementSchema.safeParse({ ...minimal, relatedFunctions: [''] }).success,
      ).toBe(false);
      expect(
        aiExtractedRequirementSchema.safeParse({
          ...minimal,
          relatedFunctions: ['x'.repeat(201)],
        }).success,
      ).toBe(false);
      expect(
        aiExtractedRequirementSchema.safeParse({
          ...minimal,
          relatedFunctions: Array.from({ length: 21 }, (_, i) => `ФТ ${i}`),
        }).success,
      ).toBe(false);
      expect(
        aiExtractedRequirementSchema.safeParse({
          ...minimal,
          relatedFunctions: Array.from({ length: 20 }, (_, i) => `ФТ ${i}`),
        }).success,
      ).toBe(true);
    });

    it('rejects a non-array value', () => {
      expect(
        aiExtractedRequirementSchema.safeParse({ ...minimal, relatedFunctions: 'Поиск' }).success,
      ).toBe(false);
    });
  });
});

// ── todo_18: per-model best-practice presets ─────────────────────────────────
import {
  AI_MODEL_PRESET_DEFAULTS,
  AI_MODEL_PRESET_GENERIC_KEY,
  AI_MODEL_REASONING_MODES,
  aiModelPresetOverrideSchema,
  aiModelPresetSchema,
  resolveModelPreset,
} from './ai.js';

// todo_20 T-201: run-control fields shipped with every full preset.
const RUN_FIELDS = {
  parallelism: 2,
  perCallTimeoutSec: 120,
  runBudgetTokens: null,
  estimateThresholdTokens: 2_000_000,
} as const;

describe('todo_18 aiModelPresetSchema', () => {
  const full = {
    temperature: 0.2,
    maxOutputTokens: 4000,
    chunkChars: 12_000,
    reasoning: 'strip' as const,
    ...RUN_FIELDS,
  };

  it('accepts a full valid preset (topP optional)', () => {
    expect(aiModelPresetSchema.parse(full)).toEqual(full);
    expect(aiModelPresetSchema.parse({ ...full, topP: 0.9 }).topP).toBe(0.9);
  });

  it('bounds temperature to 0..2', () => {
    expect(aiModelPresetSchema.safeParse({ ...full, temperature: -0.1 }).success).toBe(false);
    expect(aiModelPresetSchema.safeParse({ ...full, temperature: 2.1 }).success).toBe(false);
    expect(aiModelPresetSchema.safeParse({ ...full, temperature: 2 }).success).toBe(true);
  });

  it('requires integer maxOutputTokens >= 1 and chunkChars >= 1000', () => {
    expect(aiModelPresetSchema.safeParse({ ...full, maxOutputTokens: 0 }).success).toBe(false);
    expect(aiModelPresetSchema.safeParse({ ...full, maxOutputTokens: 1.5 }).success).toBe(false);
    expect(aiModelPresetSchema.safeParse({ ...full, chunkChars: 999 }).success).toBe(false);
    expect(aiModelPresetSchema.safeParse({ ...full, chunkChars: 1000 }).success).toBe(true);
  });

  it('bounds topP to 0..1 and reasoning to the enum', () => {
    expect(aiModelPresetSchema.safeParse({ ...full, topP: 1.1 }).success).toBe(false);
    expect(aiModelPresetSchema.safeParse({ ...full, reasoning: 'think' }).success).toBe(false);
    expect(AI_MODEL_REASONING_MODES).toEqual(['none', 'strip']);
  });

  it('override schema is a partial (empty object = reset)', () => {
    expect(aiModelPresetOverrideSchema.parse({})).toEqual({});
    expect(aiModelPresetOverrideSchema.parse({ temperature: 0.5 })).toEqual({ temperature: 0.5 });
  });
});

describe('todo_18 AI_MODEL_PRESET_DEFAULTS', () => {
  it('carries the PO-decided defaults for the three real Qwen ids', () => {
    expect(AI_MODEL_PRESET_DEFAULTS['Qwen/Qwen3-Coder-Next']).toEqual({
      temperature: 0.2,
      maxOutputTokens: 4000,
      chunkChars: 12_000,
      reasoning: 'none',
      ...RUN_FIELDS,
    });
    expect(AI_MODEL_PRESET_DEFAULTS['Qwen/Qwen3.5-397B-A17B']).toEqual({
      temperature: 0.2,
      maxOutputTokens: 16_000,
      chunkChars: 24_000,
      reasoning: 'strip',
      ...RUN_FIELDS,
      // Калибровка под реальный хаб: thinking-модели мало дефолтных 120 с.
      perCallTimeoutSec: 240,
    });
    expect(AI_MODEL_PRESET_DEFAULTS['Qwen/Qwen3.6-27B']).toEqual({
      temperature: 0.2,
      maxOutputTokens: 12_000,
      chunkChars: 16_000,
      reasoning: 'strip',
      ...RUN_FIELDS,
      perCallTimeoutSec: 180,
    });
  });

  it('has a generic fallback preset', () => {
    expect(AI_MODEL_PRESET_DEFAULTS[AI_MODEL_PRESET_GENERIC_KEY]).toEqual({
      temperature: 0.2,
      maxOutputTokens: 4000,
      chunkChars: 12_000,
      reasoning: 'strip',
      ...RUN_FIELDS,
    });
  });
});

describe('todo_18 resolveModelPreset (override ← default-by-id ← generic)', () => {
  it('returns the exact default for a known id when there is no override', () => {
    expect(resolveModelPreset('Qwen/Qwen3.5-397B-A17B')).toEqual({
      temperature: 0.2,
      maxOutputTokens: 16_000,
      chunkChars: 24_000,
      reasoning: 'strip',
      ...RUN_FIELDS,
      perCallTimeoutSec: 240,
    });
  });

  it('falls back to the generic preset for an unknown id', () => {
    expect(resolveModelPreset('Some/Unknown-Model')).toEqual(
      AI_MODEL_PRESET_DEFAULTS[AI_MODEL_PRESET_GENERIC_KEY],
    );
  });

  it('applies a partial override on top of the default-by-id', () => {
    const eff = resolveModelPreset('Qwen/Qwen3.6-27B', { temperature: 0.7, topP: 0.8 });
    expect(eff).toEqual({
      temperature: 0.7,
      maxOutputTokens: 12_000,
      chunkChars: 16_000,
      reasoning: 'strip',
      topP: 0.8,
      ...RUN_FIELDS,
      perCallTimeoutSec: 180,
    });
  });

  it('override wins over default which wins over generic (full precedence)', () => {
    const eff = resolveModelPreset('Unknown/Model', { reasoning: 'none', maxOutputTokens: 12_000 });
    expect(eff.reasoning).toBe('none');
    expect(eff.maxOutputTokens).toBe(12_000);
    // untouched fields keep the generic fallback values
    expect(eff.temperature).toBe(0.2);
    expect(eff.chunkChars).toBe(12_000);
  });

  it('ignores undefined-valued override fields (never blanks a resolved field)', () => {
    const eff = resolveModelPreset('Qwen/Qwen3-Coder-Next', {
      temperature: undefined,
      maxOutputTokens: undefined,
    });
    expect(eff).toEqual(AI_MODEL_PRESET_DEFAULTS['Qwen/Qwen3-Coder-Next']);
  });
});

describe('todo_18 aiConfigViewSchema / aiConfigUpdateSchema with modelPresets', () => {
  it('view accepts modelPresets as a map of partial overrides', () => {
    const v = aiConfigViewSchema.parse({
      baseURL: AI_DEFAULT_BASE_URL,
      hasApiKey: true,
      modelPresets: { 'Qwen/Qwen3.6-27B': { temperature: 0.5 } },
    });
    expect(v.modelPresets?.['Qwen/Qwen3.6-27B']).toEqual({ temperature: 0.5 });
  });

  it('view stays valid without modelPresets (present only when stored)', () => {
    const v = aiConfigViewSchema.parse({ baseURL: AI_DEFAULT_BASE_URL, hasApiKey: false });
    expect(v.modelPresets).toBeUndefined();
  });

  it('update accepts modelPresets and rejects an out-of-range override', () => {
    const parsed = aiConfigUpdateSchema.parse({
      modelPresets: { 'Qwen/Qwen3.6-27B': { chunkChars: 20_000 } },
    });
    expect(parsed.modelPresets?.['Qwen/Qwen3.6-27B']).toEqual({ chunkChars: 20_000 });
    expect(
      aiConfigUpdateSchema.safeParse({ modelPresets: { M: { temperature: 9 } } }).success,
    ).toBe(false);
  });
});
