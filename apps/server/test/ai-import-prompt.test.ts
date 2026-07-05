import { describe, expect, it } from 'vitest';
import {
  AI_IMPORT_TREE_CHARS,
  buildArchiveMap,
  buildExtractionMessages,
  buildStructureMessages,
  chunkText,
  parseExtractionResponse,
  parseStructureResponse,
} from '../src/services/aiImportPrompt.js';

const record = {
  type: 'FUNCTION',
  name: 'Вход по паролю',
  description: 'Пользователь входит по email и паролю.',
  source: 'auth.md § Вход',
};

describe('T11 buildExtractionMessages', () => {
  it('starts with a RU system prompt encoding the skill rules', () => {
    const messages = buildExtractionMessages('текст', 'auth.md', { index: 1, total: 3 }, 'auth.md');
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

  it('mentions the archive structure usage (source/parentName) without weakening the golden rule', () => {
    const messages = buildExtractionMessages('текст', 'auth.md', { index: 1, total: 1 }, 'auth.md');
    const sys = messages[0]?.content ?? '';
    expect(sys).toMatch(/структур/i);
    expect(sys).toContain('parentName');
    // The golden rule stays: requirements come ONLY from the chunk text.
    expect(sys).toMatch(/ТОЛЬКО/);
  });

  it('puts the file name, chunk info and the chunk into the user message', () => {
    const messages = buildExtractionMessages(
      '## Раздел\nТекст',
      'docs/auth.md',
      { index: 2, total: 5 },
      'docs/auth.md',
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toContain('docs/auth.md');
    expect(messages[1]?.content).toContain('2');
    expect(messages[1]?.content).toContain('5');
    expect(messages[1]?.content).toContain('## Раздел\nТекст');
  });

  it('adds the current directory and the archive map BEFORE the chunk text', () => {
    const map = buildArchiveMap(['docs/api/auth.md', 'docs/nfr/perf.md', 'readme.md']);
    const messages = buildExtractionMessages(
      '## Вход\nТекст фрагмента.',
      'docs/api/auth.md',
      { index: 1, total: 2 },
      map,
    );
    const user = messages[1]?.content ?? '';
    expect(user).toContain('Файл: docs/api/auth.md (фрагмент 1 из 2)');
    expect(user).toContain('Директория текущего файла: docs/api');
    expect(user).toContain('Структура архива (файлы документации):\n' + map);
    // The map (and headers) come before the chunk text.
    const mapIdx = user.indexOf('Структура архива');
    const chunkIdx = user.indexOf('## Вход\nТекст фрагмента.');
    expect(mapIdx).toBeGreaterThanOrEqual(0);
    expect(chunkIdx).toBeGreaterThan(mapIdx);
  });

  it('labels a root-level file as «корень архива»', () => {
    const messages = buildExtractionMessages(
      'Текст.',
      'readme.md',
      { index: 1, total: 1 },
      buildArchiveMap(['readme.md']),
    );
    expect(messages[1]?.content).toContain('Директория текущего файла: корень архива');
  });
});

describe('T13 buildArchiveMap', () => {
  it('lists relative paths sorted, one per line', () => {
    const map = buildArchiveMap(['readme.md', 'docs/nfr/perf.md', 'docs/api/auth.md']);
    expect(map).toBe('docs/api/auth.md\ndocs/nfr/perf.md\nreadme.md');
  });

  it('returns an empty string for an empty list', () => {
    expect(buildArchiveMap([])).toBe('');
  });

  it('fits within the default limit constant', () => {
    const files = Array.from({ length: 200 }, (_, i) => `docs/module-${i}/file-${i}.md`);
    expect(buildArchiveMap(files).length).toBeLessThanOrEqual(AI_IMPORT_TREE_CHARS);
  });

  it('truncates at a line boundary and reports the exact number of omitted files', () => {
    const files = Array.from({ length: 50 }, (_, i) => `dir/file-${String(i).padStart(2, '0')}.md`);
    // Each line is 14 chars; limit fits a few lines plus the «…и ещё N файлов» tail.
    const map = buildArchiveMap(files, 60);
    expect(map.length).toBeLessThanOrEqual(60);
    const lines = map.split('\n');
    const tail = lines[lines.length - 1] ?? '';
    const match = /^…и ещё (\d+) файлов$/.exec(tail);
    expect(match).not.toBeNull();
    const omitted = Number(match?.[1]);
    const listed = lines.length - 1;
    expect(listed).toBeGreaterThan(0);
    expect(listed + omitted).toBe(files.length);
    // Every listed line is a complete path (line-boundary truncation).
    for (const line of lines.slice(0, -1)) expect(files).toContain(line);
    // The listed prefix is exactly the first `listed` sorted files.
    expect(lines.slice(0, -1)).toEqual(files.slice(0, listed));
  });

  it('does not truncate when the list exactly fits the limit', () => {
    const files = ['a.md', 'b.md'];
    const joined = 'a.md\nb.md';
    expect(buildArchiveMap(files, joined.length)).toBe(joined);
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

  it('drops a record whose targetYear violates the creation contract (never reaches populate)', () => {
    // The core create contract requires 2020 ≤ targetYear ≤ 2100; a record with
    // 2019 must be dropped here (droppedInvalid → warn), not fail on create.
    const tooOld = { ...record, targetYear: 2019 };
    const tooFar = { ...record, name: 'Другое имя', targetYear: 2101 };
    const parsed = parseExtractionResponse(JSON.stringify([record, tooOld, tooFar]));
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.droppedInvalid).toBe(2);
    expect(parsed?.droppedNoSource).toBe(0);
  });
});

describe('T13 buildStructureMessages', () => {
  const items = [
    { type: 'FUNCTION', name: 'Аутентификация' },
    { type: 'FUNCTION', name: 'Вход по паролю' },
    { type: 'NFR', name: 'Время отклика' },
  ] as const;

  it('starts with a RU system prompt demanding a strict JSON tree answer', () => {
    const messages = buildStructureMessages([...items], 'auth.md');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    const sys = messages[0]?.content ?? '';
    // The tree must mirror the documentation structure: root groups + children.
    expect(sys).toMatch(/дерев/i);
    expect(sys).toMatch(/структур/i);
    expect(sys).toMatch(/корнев/i);
    // Hierarchy only within one type (CHILD_OF rule).
    expect(sys).toContain('FUNCTION');
    expect(sys).toContain('NFR');
    expect(sys).toMatch(/одного типа/i);
    // Strict output contract: one node per requirement, explicit null for roots.
    expect(sys).toMatch(/JSON-массив/);
    expect(sys).toContain('parentName');
    expect(sys).toContain('null');
    expect(sys).toMatch(/КАЖДОЕ/);
    // Golden rule: only the given names, no invention.
    expect(sys).toMatch(/ТОЛЬКО/);
    expect(sys).toMatch(/не выдумывай|ничего не выдумывай|не домысливай/i);
  });

  it('puts the archive map and every requirement (type + name) into the user message', () => {
    const map = buildArchiveMap(['docs/api/auth.md', 'docs/nfr/perf.md']);
    const messages = buildStructureMessages([...items], map);
    const user = messages[1]?.content ?? '';
    expect(messages[1]?.role).toBe('user');
    expect(user).toContain('Структура архива (файлы документации):\n' + map);
    for (const item of items) {
      expect(user).toContain(item.name);
      expect(user).toContain(item.type);
    }
  });
});

describe('T13 parseStructureResponse', () => {
  const nodes = [
    { type: 'FUNCTION', name: 'Аутентификация', parentName: null },
    { type: 'FUNCTION', name: 'Вход по паролю', parentName: 'Аутентификация' },
  ];

  it('parses a bare JSON array of structure nodes', () => {
    const parsed = parseStructureResponse(JSON.stringify(nodes));
    expect(parsed).toEqual(nodes);
  });

  it('parses an array inside a ```json fence', () => {
    const content = 'Дерево:\n```json\n' + JSON.stringify(nodes) + '\n```';
    expect(parseStructureResponse(content)).toEqual(nodes);
  });

  it('returns null for prose without a JSON array', () => {
    expect(parseStructureResponse('Не могу построить дерево.')).toBeNull();
    expect(parseStructureResponse('')).toBeNull();
  });

  it('returns null when ANY node is schema-invalid (whole answer is retried)', () => {
    const withInvalid = [...nodes, { type: 'FUNCTION', name: 'Без parentName' }];
    expect(parseStructureResponse(JSON.stringify(withInvalid))).toBeNull();
    const badType = [{ type: 'EPIC', name: 'X', parentName: null }];
    expect(parseStructureResponse(JSON.stringify(badType))).toBeNull();
  });

  it('accepts an empty array', () => {
    expect(parseStructureResponse('[]')).toEqual([]);
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
