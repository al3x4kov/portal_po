import { describe, expect, it } from 'vitest';
import {
  AI_DOCS_REVIEW_PHASES,
  aiDocsApplyBodySchema,
  aiDocsReviewItemSchema,
  aiDocsReviewSchema,
  aiImportJobViewSchema,
} from './ai.js';

/*
 * Двухзонная выверка дублей docs-импорта: контракты гейта `awaiting-review`
 * (zone 1 `self` — дубли сгенерированных между собой, zone 2 `existing` —
 * дубли с уже созданными в проекте) и тела apply `{phase, ids}`.
 */

const record = {
  type: 'FUNCTION',
  name: 'Вход по паролю',
  description: 'Пользователь входит по паролю.',
  source: 'auth.md § Вход',
};

describe('aiDocsReviewItemSchema', () => {
  it('минимальный валидный item: id + record + parentName (null = корень)', () => {
    const parsed = aiDocsReviewItemSchema.parse({ id: 'd1', record, parentName: null });
    expect(parsed.groupId).toBeUndefined();
    expect(parsed.duplicateOf).toBeUndefined();
  });

  it('полный item: группа зоны 1 и дубль зоны 2 с похожестью', () => {
    const parsed = aiDocsReviewItemSchema.parse({
      id: 'd2',
      record,
      parentName: 'Авторизация',
      groupId: 'g1',
      duplicateOf: 'Вход по паролю',
      duplicateSimilarity: 0.92,
    });
    expect(parsed.parentName).toBe('Авторизация');
    expect(parsed.duplicateSimilarity).toBe(0.92);
  });

  it('similarity вне [0..1] и пустой id отвергаются', () => {
    expect(
      aiDocsReviewItemSchema.safeParse({
        id: 'd1',
        record,
        parentName: null,
        duplicateSimilarity: 1.5,
      }).success,
    ).toBe(false);
    expect(aiDocsReviewItemSchema.safeParse({ id: '', record, parentName: null }).success).toBe(
      false,
    );
  });
});

describe('aiDocsReviewSchema', () => {
  it('обе фазы валидны; чужая фаза отвергается', () => {
    expect(AI_DOCS_REVIEW_PHASES).toEqual(['self', 'existing']);
    for (const phase of AI_DOCS_REVIEW_PHASES) {
      expect(
        aiDocsReviewSchema.safeParse({
          phase,
          items: [{ id: 'd1', record, parentName: null }],
          autoMerged: [],
          groupCount: 0,
          duplicateCount: 0,
        }).success,
      ).toBe(true);
    }
    expect(
      aiDocsReviewSchema.safeParse({
        phase: 'final',
        items: [],
        autoMerged: [],
        groupCount: 0,
        duplicateCount: 0,
      }).success,
    ).toBe(false);
  });
});

describe('aiDocsApplyBodySchema', () => {
  it('пустой ids допустим («всё оказалось дублями»), phase обязательна', () => {
    expect(aiDocsApplyBodySchema.parse({ phase: 'existing', ids: [] }).ids).toEqual([]);
    expect(aiDocsApplyBodySchema.safeParse({ ids: ['d1'] }).success).toBe(false);
    expect(aiDocsApplyBodySchema.safeParse({ phase: 'self', ids: [''] }).success).toBe(false);
  });
});

describe('aiImportJobViewSchema + docsReview', () => {
  it('view с docsReview валиден; старые view без поля — тоже (обратная совместимость)', () => {
    const base = {
      jobId: 'j1',
      projectId: 'Demo',
      status: 'awaiting-review',
      stage: 'aggregate',
      progress: 82,
      log: [],
    };
    expect(aiImportJobViewSchema.safeParse(base).success).toBe(true);
    expect(
      aiImportJobViewSchema.safeParse({
        ...base,
        docsReview: {
          phase: 'self',
          items: [{ id: 'd1', record, parentName: null, groupId: 'g1' }],
          autoMerged: ['повтор'],
          groupCount: 1,
          duplicateCount: 0,
        },
      }).success,
    ).toBe(true);
  });
});
