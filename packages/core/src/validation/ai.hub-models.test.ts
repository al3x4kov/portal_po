import { describe, expect, it } from 'vitest';
import {
  AI_MODEL_ESTIMATE_THRESHOLD_TOKENS_DEFAULT,
  isEmbeddingModelId,
  resolveModelPreset,
} from './ai.js';

/*
 * Пресеты под реальный список моделей AI Hub + защита от embedding-моделей.
 * Калибровка по реальным прогонам: DeepSeek-V4-Flash обрезал ответы на
 * generic-пресете (maxOutputTokens 4000) → выделенный пресет с бюджетом 8000.
 */

describe('AI_MODEL_PRESET_DEFAULTS · реальные модели хаба', () => {
  it('deepseek-ai/DeepSeek-V4-Flash: увеличенный бюджет и parallelism 3', () => {
    const p = resolveModelPreset('deepseek-ai/DeepSeek-V4-Flash');
    expect(p.temperature).toBe(0.2);
    expect(p.maxOutputTokens).toBe(8000);
    expect(p.chunkChars).toBe(16_000);
    expect(p.reasoning).toBe('strip');
    expect(p.parallelism).toBe(3);
    // Остальные run-поля — из общих дефолтов.
    expect(p.perCallTimeoutSec).toBe(120);
    expect(p.runBudgetTokens).toBeNull();
    expect(p.estimateThresholdTokens).toBe(AI_MODEL_ESTIMATE_THRESHOLD_TOKENS_DEFAULT);
  });

  it('GigaChat-2: осторожный лайт-профиль', () => {
    const p = resolveModelPreset('GigaChat-2');
    expect(p).toMatchObject({
      temperature: 0.2,
      maxOutputTokens: 4000,
      chunkChars: 8000,
      reasoning: 'strip',
      parallelism: 2,
    });
  });

  it('GigaChat-2-Pro: средний профиль', () => {
    const p = resolveModelPreset('GigaChat-2-Pro');
    expect(p).toMatchObject({
      temperature: 0.2,
      maxOutputTokens: 6000,
      chunkChars: 12_000,
      reasoning: 'strip',
    });
  });

  it('GigaChat-2-Max: расширенный бюджет и тайм-аут 150 с', () => {
    const p = resolveModelPreset('GigaChat-2-Max');
    expect(p).toMatchObject({
      temperature: 0.2,
      maxOutputTokens: 8000,
      chunkChars: 16_000,
      reasoning: 'strip',
      perCallTimeoutSec: 150,
    });
  });

  it('Qwen/Qwen3.5-397B-A17B: thinking-модели мало 120 с — тайм-аут 240', () => {
    const p = resolveModelPreset('Qwen/Qwen3.5-397B-A17B');
    expect(p.perCallTimeoutSec).toBe(240);
    // Исторические поля пресета не менялись.
    expect(p.maxOutputTokens).toBe(16_000);
    expect(p.chunkChars).toBe(24_000);
    expect(p.reasoning).toBe('strip');
  });

  it('Qwen/Qwen3.6-27B: тайм-аут 180 с', () => {
    const p = resolveModelPreset('Qwen/Qwen3.6-27B');
    expect(p.perCallTimeoutSec).toBe(180);
    expect(p.maxOutputTokens).toBe(12_000);
  });

  it('Qwen/Qwen3-Coder-Next и generic не изменились', () => {
    expect(resolveModelPreset('Qwen/Qwen3-Coder-Next')).toMatchObject({
      temperature: 0.2,
      maxOutputTokens: 4000,
      chunkChars: 12_000,
      reasoning: 'none',
      parallelism: 2,
      perCallTimeoutSec: 120,
    });
    expect(resolveModelPreset('some-unknown-model')).toMatchObject({
      temperature: 0.2,
      maxOutputTokens: 4000,
      chunkChars: 12_000,
      reasoning: 'strip',
      parallelism: 2,
      perCallTimeoutSec: 120,
    });
  });

  it('пользовательский override по-прежнему сильнее дефолта модели', () => {
    const p = resolveModelPreset('deepseek-ai/DeepSeek-V4-Flash', { parallelism: 1 });
    expect(p.parallelism).toBe(1);
    expect(p.maxOutputTokens).toBe(8000);
  });
});

describe('isEmbeddingModelId', () => {
  const embeddings = [
    'BAAI/bge-m3',
    'Embeddings',
    'Embeddings-2',
    'EmbeddingsGigaR',
    'GigaEmbeddings-3B-2025-09',
    'Qodo/Qodo-Embed-1-1.5B',
    'Qwen/Qwen3-VL-Embedding-8B',
  ];
  it.each(embeddings)('embedding-модель хаба «%s» → true', (id) => {
    expect(isEmbeddingModelId(id)).toBe(true);
  });

  const chatModels = [
    'deepseek-ai/DeepSeek-V4-Flash',
    'GigaChat-2',
    'GigaChat-2-Max',
    'GigaChat-2-Pro',
    'Qwen/Qwen3-Coder-Next',
    'Qwen/Qwen3.5-397B-A17B',
    'Qwen/Qwen3.6-27B',
  ];
  it.each(chatModels)('чат-модель «%s» → false (нет ложных срабатываний)', (id) => {
    expect(isEmbeddingModelId(id)).toBe(false);
  });

  it('регистронезависимость и пробелы по краям', () => {
    expect(isEmbeddingModelId('EMBEDDINGS')).toBe(true);
    expect(isEmbeddingModelId('  baai/BGE-m3  ')).toBe(true);
    expect(isEmbeddingModelId('vendor/text-embedding-3-large')).toBe(true);
  });
});
