import { describe, expect, it } from 'vitest';
import { AI_IMPORT_SOURCE_CLASSES } from '@po/core';
import {
  ResponseFormatNegotiator,
  buildAnalyzeResponseFormat,
  fewShotForClass,
  isResponseFormatRejection,
} from '../src/services/aiImport/structuredOutput.js';
import { parseExtractionResponse } from '../src/services/aiImportPrompt.js';

/*
 * todo_20 · T-206: structured output с фолбэком (Н5, приёмка №6) + плоская
 * схема analyze + few-shot примеры по классам источников (B2, B3).
 */

function formatError(message: string, status = 400) {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe('T-206 · ResponseFormatNegotiator', () => {
  it('стартует с json_schema и строит response_format', () => {
    const neg = new ResponseFormatNegotiator();
    expect(neg.mode).toBe('json_schema');
    const format = neg.responseFormat() as { type: string };
    expect(format.type).toBe('json_schema');
  });

  it('отказ на json_schema → деградация в json_object (решение запоминается на прогон)', () => {
    const neg = new ResponseFormatNegotiator();
    expect(neg.noteRejected(formatError("Unknown parameter: 'response_format.json_schema'"))).toBe(
      true,
    );
    expect(neg.mode).toBe('json_object');
    expect((neg.responseFormat() as { type: string }).type).toBe('json_object');
  });

  it('повторный отказ → без параметра (работа по текущей схеме «текст + парсер»)', () => {
    const neg = new ResponseFormatNegotiator();
    neg.noteRejected(formatError('response_format is not supported'));
    neg.noteRejected(formatError('response_format is not supported'));
    expect(neg.mode).toBe('none');
    expect(neg.responseFormat()).toBeUndefined();
    // Дальше деградировать некуда: ошибка больше не «про формат».
    expect(neg.noteRejected(formatError('response_format is not supported'))).toBe(false);
  });

  it('НЕ деградирует на посторонние ошибки (429, контекст, сеть)', () => {
    const neg = new ResponseFormatNegotiator();
    expect(neg.noteRejected(formatError('rate limit', 429))).toBe(false);
    expect(neg.noteRejected(new Error('ECONNREFUSED'))).toBe(false);
    expect(neg.noteRejected(formatError('maximum context length is 8192 tokens'))).toBe(false);
    expect(neg.mode).toBe('json_schema');
  });

  it('isResponseFormatRejection узнаёт варианты формулировок бэкендов', () => {
    expect(isResponseFormatRejection(formatError('response_format not supported'))).toBe(true);
    expect(isResponseFormatRejection(formatError('json_schema is not supported'))).toBe(true);
    expect(isResponseFormatRejection(formatError('invalid temperature'))).toBe(false);
  });
});

describe('T-206 · плоская схема analyze', () => {
  it('json_schema описывает плоскую запись {name,type,description,source}', () => {
    const format = buildAnalyzeResponseFormat() as {
      type: string;
      json_schema: { name: string; schema: Record<string, unknown> };
    };
    expect(format.type).toBe('json_schema');
    const schema = JSON.stringify(format.json_schema.schema);
    for (const key of ['name', 'type', 'description', 'source']) {
      expect(schema).toContain(`"${key}"`);
    }
    // Плоско: без parentName/relatedFunctions — иерархию строит structure-стадия.
    expect(schema).not.toContain('parentName');
    expect(schema).not.toContain('relatedFunctions');
  });
});

describe('T-206 · few-shot по классам источников', () => {
  it('для каждого класса есть 1–2 примера, и ответ примера парсится текущим парсером', () => {
    for (const cls of AI_IMPORT_SOURCE_CLASSES) {
      const shots = fewShotForClass(cls);
      expect(shots.length, cls).toBeGreaterThanOrEqual(2); // user+assistant минимум
      expect(shots.length % 2, cls).toBe(0);
      for (let i = 0; i < shots.length; i += 2) {
        expect(shots[i]!.role).toBe('user');
        expect(shots[i + 1]!.role).toBe('assistant');
        // Обратная совместимость: пример-ответ валиден для parseExtractionResponse.
        const parsed = parseExtractionResponse(shots[i + 1]!.content);
        expect(parsed, `${cls}: пример-ответ должен парситься`).not.toBeNull();
        expect(parsed!.items.length).toBeGreaterThan(0);
        expect(parsed!.droppedInvalid).toBe(0);
        expect(parsed!.droppedNoSource).toBe(0);
      }
    }
  });
});
