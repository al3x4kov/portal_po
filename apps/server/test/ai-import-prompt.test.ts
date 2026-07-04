import { describe, expect, it } from 'vitest';
import {
  buildExtractionMessages,
  chunkText,
  parseExtractionResponse,
} from '../src/services/aiImportPrompt.js';

const record = {
  type: 'FUNCTION',
  name: 'Вход по паролю',
  description: 'Пользователь входит по email и паролю.',
  source: 'auth.md § Вход',
};

describe('T11 buildExtractionMessages', () => {
  it('starts with a RU system prompt encoding the skill rules', () => {
    const messages = buildExtractionMessages('текст', 'auth.md', { index: 1, total: 3 });
    expect(messages[0]?.role).toBe('system');
    const sys = messages[0]?.content ?? '';
    // Golden rule: extraction only from the given text, no invention.
    expect(sys).toMatch(/ТОЛЬКО/i);
    expect(sys).toMatch(/не домысливай/i);
    // Provenance is mandatory: file + section.
    expect(sys).toContain('source');
    expect(sys).toMatch(/раздел/i);
    // Optional fields only when explicit in the text.
    expect(sys).toContain('criticality');
    expect(sys).toContain('implemented');
    expect(sys).toContain('parentName');
    // Strict output contract.
    expect(sys).toMatch(/JSON-массив/);
    expect(sys).toMatch(/пустой массив|\[\]/i);
    expect(sys).toContain('FUNCTION');
    expect(sys).toContain('NFR');
  });

  it('puts the file name, chunk info and the chunk into the user message', () => {
    const messages = buildExtractionMessages('## Раздел\nТекст', 'docs/auth.md', {
      index: 2,
      total: 5,
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toContain('docs/auth.md');
    expect(messages[1]?.content).toContain('2');
    expect(messages[1]?.content).toContain('5');
    expect(messages[1]?.content).toContain('## Раздел\nТекст');
  });
});

describe('T11 parseExtractionResponse', () => {
  it('parses a bare JSON array', () => {
    const parsed = parseExtractionResponse(JSON.stringify([record]));
    expect(parsed).not.toBeNull();
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.items[0]?.name).toBe('Вход по паролю');
  });

  it('parses an array inside a ```json fence', () => {
    const content = 'Вот результат:\n```json\n' + JSON.stringify([record]) + '\n```\nГотово.';
    const parsed = parseExtractionResponse(content);
    expect(parsed?.items).toHaveLength(1);
  });

  it('parses an array inside an unlabelled ``` fence', () => {
    const content = '```\n' + JSON.stringify([record]) + '\n```';
    expect(parseExtractionResponse(content)?.items).toHaveLength(1);
  });

  it('extracts the array from surrounding prose (first [ … last ])', () => {
    const content = 'Найдено требование: ' + JSON.stringify([record]) + ' — конец.';
    expect(parseExtractionResponse(content)?.items).toHaveLength(1);
  });

  it('returns null for prose without any JSON array', () => {
    expect(parseExtractionResponse('Не могу извлечь требования.')).toBeNull();
    expect(parseExtractionResponse('{"type":"FUNCTION"}')).toBeNull();
    expect(parseExtractionResponse('')).toBeNull();
  });

  it('accepts an empty array (no requirements in the chunk)', () => {
    const parsed = parseExtractionResponse('[]');
    expect(parsed).not.toBeNull();
    expect(parsed?.items).toHaveLength(0);
    expect(parsed?.droppedNoSource).toBe(0);
    expect(parsed?.droppedInvalid).toBe(0);
  });

  it('drops a record without source and counts it separately', () => {
    const { source: _s, ...noSource } = record;
    const parsed = parseExtractionResponse(JSON.stringify([record, noSource]));
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.droppedNoSource).toBe(1);
    expect(parsed?.droppedInvalid).toBe(0);
  });

  it('drops schema-invalid records with a separate counter', () => {
    const bad = { ...record, type: 'BUG' };
    const parsed = parseExtractionResponse(JSON.stringify([record, bad, 42]));
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.droppedInvalid).toBe(2);
  });
});

describe('T11 chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('короткий текст', 100)).toEqual(['короткий текст']);
  });

  it('splits at line boundaries and preserves all content', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `строка ${i} ${'x'.repeat(20)}`);
    const text = lines.join('\n');
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join('\n')).toBe(text);
  });

  it('hard-splits a single overlong line', () => {
    const text = 'y'.repeat(250);
    const chunks = chunkText(text, 100);
    expect(chunks).toEqual(['y'.repeat(100), 'y'.repeat(100), 'y'.repeat(50)]);
  });

  it('returns no chunks for empty/whitespace text', () => {
    expect(chunkText('', 100)).toEqual([]);
    expect(chunkText('   \n \n ', 100)).toEqual([]);
  });
});
