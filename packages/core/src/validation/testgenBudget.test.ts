import { describe, it, expect } from 'vitest';
import {
  AI_TESTGEN_BATCH,
  AI_TESTGEN_MIN_TOKENS,
  AI_TESTGEN_TOKENS_OVERHEAD,
  AI_TESTGEN_TOKENS_PER_CASE,
  AI_TESTGEN_TOKENS_PER_CASE_NEGATIVE,
  testGenFittingBatch,
  testGenMaxTokens,
} from './ai.js';

/**
 * Бюджет ответа тест-генерации. Прежний фиксированный лимит (3000 токенов на
 * батч любой величины) обрывал ответ на середине JSON — падал первый же батч,
 * особенно у крит- и полного регресса, где негатив обязателен.
 */
describe('testGenMaxTokens', () => {
  it('растёт с размером батча, а не остаётся постоянным', () => {
    expect(testGenMaxTokens(6, false)).toBeGreaterThan(testGenMaxTokens(3, false));
    expect(testGenMaxTokens(10, false)).toBeGreaterThan(testGenMaxTokens(6, false));
  });

  it('на негативные сценарии закладывает больше — они удваивают кейс', () => {
    expect(testGenMaxTokens(6, true)).toBeGreaterThan(testGenMaxTokens(6, false));
  });

  it('дефолтный батч больше не помещается в прежние 3000 токенов', () => {
    // Ровно та ситуация из отчёта: батч по умолчанию с негативом обрывался.
    expect(testGenMaxTokens(AI_TESTGEN_BATCH, true)).toBeGreaterThan(3000);
    expect(testGenMaxTokens(10, true)).toBeGreaterThan(6000);
  });

  it('держит нижнюю границу даже для одного кейса', () => {
    expect(testGenMaxTokens(1, false)).toBeGreaterThanOrEqual(AI_TESTGEN_MIN_TOKENS);
    expect(testGenMaxTokens(0, false)).toBeGreaterThanOrEqual(AI_TESTGEN_MIN_TOKENS);
  });

  it('считается по формуле overhead + за-кейс × количество', () => {
    expect(testGenMaxTokens(4, false)).toBe(
      AI_TESTGEN_TOKENS_OVERHEAD + AI_TESTGEN_TOKENS_PER_CASE * 4,
    );
    expect(testGenMaxTokens(4, true)).toBe(
      AI_TESTGEN_TOKENS_OVERHEAD + AI_TESTGEN_TOKENS_PER_CASE_NEGATIVE * 4,
    );
  });
});

describe('testGenFittingBatch', () => {
  it('подсказывает, сколько кейсов реально влезает в бюджет модели', () => {
    // Скромный пресет (4000) с негативом: батч по умолчанию туда не влезает.
    const fits = testGenFittingBatch(4000, true);
    expect(fits).toBeLessThan(AI_TESTGEN_BATCH);
    expect(testGenMaxTokens(fits, true)).toBeLessThanOrEqual(4000);
  });

  it('щедрый пресет вмещает батч целиком', () => {
    expect(testGenFittingBatch(16_000, true)).toBeGreaterThanOrEqual(AI_TESTGEN_BATCH);
  });

  it('никогда не опускается ниже одного требования', () => {
    expect(testGenFittingBatch(100, true)).toBe(1);
    expect(testGenFittingBatch(0, false)).toBe(1);
  });
});
