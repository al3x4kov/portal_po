import { describe, expect, it } from 'vitest';
import { aiImportJobViewSchema, aiImportResultSchema } from './ai.js';

/*
 * todo_23 · M3: честные счётчики извлечённого — контракт.
 * `extractedFunctions`/`extractedNfrs` опциональны: старые result/view (без
 * полей) остаются валидными, новые несут «извлечено, ещё не записано».
 */

const LEGACY_RESULT = {
  createdFunctions: 1,
  createdNfrs: 2,
  skippedExisting: 0,
  links: 3,
  relatesLinks: 0,
};

describe('aiImportResultSchema — extracted-счётчики (todo_23 M3)', () => {
  it('старый result без extracted-полей остаётся валидным', () => {
    const parsed = aiImportResultSchema.parse(LEGACY_RESULT);
    expect(parsed.extractedFunctions).toBeUndefined();
    expect(parsed.extractedNfrs).toBeUndefined();
  });

  it('принимает extractedFunctions/extractedNfrs', () => {
    const parsed = aiImportResultSchema.parse({
      ...LEGACY_RESULT,
      extractedFunctions: 881,
      extractedNfrs: 156,
    });
    expect(parsed.extractedFunctions).toBe(881);
    expect(parsed.extractedNfrs).toBe(156);
  });

  it('отклоняет отрицательные extracted-счётчики', () => {
    expect(
      aiImportResultSchema.safeParse({ ...LEGACY_RESULT, extractedFunctions: -1 }).success,
    ).toBe(false);
    expect(aiImportResultSchema.safeParse({ ...LEGACY_RESULT, extractedNfrs: 1.5 }).success).toBe(
      false,
    );
  });
});

describe('aiImportJobViewSchema — живые extracted-счётчики (todo_23 M3)', () => {
  const baseView = {
    jobId: 'j1',
    projectId: 'Demo',
    status: 'running',
    stage: 'analyze',
    progress: 42,
    log: [],
  };

  it('view без новых полей валиден (обратная совместимость)', () => {
    expect(aiImportJobViewSchema.safeParse(baseView).success).toBe(true);
  });

  it('view с extractedFunctions/extractedNfrs валиден', () => {
    const parsed = aiImportJobViewSchema.parse({
      ...baseView,
      extractedFunctions: 10,
      extractedNfrs: 2,
    });
    expect(parsed.extractedFunctions).toBe(10);
    expect(parsed.extractedNfrs).toBe(2);
  });

  it('result внутри view может нести extracted-счётчики', () => {
    const parsed = aiImportJobViewSchema.parse({
      ...baseView,
      status: 'failed',
      result: { ...LEGACY_RESULT, extractedFunctions: 5, extractedNfrs: 1 },
    });
    expect(parsed.result?.extractedFunctions).toBe(5);
  });
});
