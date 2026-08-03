import { describe, expect, it } from 'vitest';
import {
  AI_IMPORT_MIN_CHUNK_CHARS,
  AI_IMPORT_RECOVERY_SUCCESSES,
  AdaptiveChunker,
} from '../src/services/aiImport/adaptiveChunker.js';

/*
 * todo_20 · T-205: адаптивный чанкер (B1, приёмка №4).
 * Половинение при finish_reason=length / 2× невалидном JSON / context_length;
 * минимум 2000 символов; восстановление после серии успехов; состояние
 * сериализуемо для чекпоинта (волна 1.2).
 */

describe('T-205 · AdaptiveChunker', () => {
  it('стартует с preset.chunkChars и режет текст по нему', () => {
    const chunker = new AdaptiveChunker({ initialChars: 100 });
    expect(chunker.chunkSize()).toBe(100);
    const chunks = chunker.split('a'.repeat(250));
    expect(chunks.length).toBe(3);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(100);
  });

  it('context_length → половинение, не ниже минимума', () => {
    const chunker = new AdaptiveChunker({ initialChars: 6000, minChars: 2000 });
    expect(chunker.noteContextLength()).toEqual({ halved: true, atMinimum: false });
    expect(chunker.chunkSize()).toBe(3000);
    expect(chunker.noteContextLength()).toEqual({ halved: true, atMinimum: true });
    expect(chunker.chunkSize()).toBe(2000); // клип к минимуму, не 1500
  });

  it('context_length на минимальном фрагменте → сигнал MODEL-02 (без бесконечного цикла)', () => {
    const chunker = new AdaptiveChunker({ initialChars: 2000, minChars: 2000 });
    expect(chunker.atMinimum()).toBe(true);
    const outcome = chunker.noteContextLength();
    expect(outcome).toEqual({ halved: false, atMinimum: true });
  });

  it('обрезание ответа (finish_reason=length) тоже половинит', () => {
    const chunker = new AdaptiveChunker({ initialChars: 8000 });
    const outcome = chunker.noteTruncated();
    expect(outcome.halved).toBe(true);
    expect(chunker.chunkSize()).toBe(4000);
  });

  it('невалидный JSON половинит только после 2 подряд', () => {
    const chunker = new AdaptiveChunker({ initialChars: 8000 });
    expect(chunker.noteInvalidJson().halved).toBe(false);
    expect(chunker.chunkSize()).toBe(8000);
    expect(chunker.noteInvalidJson().halved).toBe(true);
    expect(chunker.chunkSize()).toBe(4000);
    // Счётчик сбрасывается после деления.
    expect(chunker.noteInvalidJson().halved).toBe(false);
  });

  it('успех сбрасывает счётчик невалидного JSON', () => {
    const chunker = new AdaptiveChunker({ initialChars: 8000 });
    chunker.noteInvalidJson();
    chunker.noteSuccess();
    expect(chunker.noteInvalidJson().halved).toBe(false);
    expect(chunker.chunkSize()).toBe(8000);
  });

  it('серия успехов постепенно возвращает размер к пресету (и не выше)', () => {
    const chunker = new AdaptiveChunker({ initialChars: 8000, minChars: 1000 });
    chunker.noteContextLength(); // 4000
    chunker.noteContextLength(); // 2000
    expect(chunker.chunkSize()).toBe(2000);
    for (let i = 0; i < AI_IMPORT_RECOVERY_SUCCESSES; i++) chunker.noteSuccess();
    expect(chunker.chunkSize()).toBe(4000);
    for (let i = 0; i < AI_IMPORT_RECOVERY_SUCCESSES; i++) chunker.noteSuccess();
    expect(chunker.chunkSize()).toBe(8000);
    // Дальше пресета не растёт.
    for (let i = 0; i < AI_IMPORT_RECOVERY_SUCCESSES; i++) chunker.noteSuccess();
    expect(chunker.chunkSize()).toBe(8000);
  });

  it('состояние сериализуемо: fromJSON(toJSON()) продолжает с того же места', () => {
    const chunker = new AdaptiveChunker({ initialChars: 8000 });
    chunker.noteContextLength();
    chunker.noteInvalidJson();
    chunker.noteSuccess();
    chunker.noteSuccess();
    const state = chunker.toJSON();
    // Состояние — plain JSON (переживает JSON.stringify/parse на диске).
    const restored = AdaptiveChunker.fromJSON(JSON.parse(JSON.stringify(state)));
    expect(restored.chunkSize()).toBe(chunker.chunkSize());
    expect(restored.toJSON()).toEqual(chunker.toJSON());
    // И ведёт себя идентично дальше.
    expect(restored.noteInvalidJson()).toEqual(chunker.noteInvalidJson());
  });

  it('дефолтный минимум — контрактные 2000 символов', () => {
    expect(AI_IMPORT_MIN_CHUNK_CHARS).toBe(2000);
    const chunker = new AdaptiveChunker({ initialChars: 2500 });
    chunker.noteContextLength();
    expect(chunker.chunkSize()).toBe(2000);
  });

  it('split пустого текста → пустой список', () => {
    const chunker = new AdaptiveChunker({ initialChars: 4000 });
    expect(chunker.split('   ')).toEqual([]);
  });
});
