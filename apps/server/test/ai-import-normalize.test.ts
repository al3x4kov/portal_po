import { describe, expect, it } from 'vitest';
import { normalizeForExtraction, sniffFormat } from '../src/services/aiImport/normalize.js';

/*
 * todo_20 · T-203: format-aware нормализация до LLM (A2, B5).
 * Sniffing строго по содержимому; никакая структура не роняет стадию;
 * `expectedRecords` — плотность записей для контроля полноты (B5, wave 1.2).
 */

describe('T-203 · sniffFormat (по содержимому, не по расширению)', () => {
  it('распознаёт JSON-массив и JSON-объект', () => {
    expect(sniffFormat('[{"a":1}]')).toBe('json');
    expect(sniffFormat('  {"changes": []}')).toBe('json');
  });

  it('распознаёт markdown-таблицу', () => {
    const md = ['| Функция | Описание |', '| --- | --- |', '| Поиск | Ищет |'].join('\n');
    expect(sniffFormat(md)).toBe('md-table');
  });

  it('распознаёт YAML (front-matter и key: value)', () => {
    expect(sniffFormat('---\nname: search\ndescription: text\n')).toBe('yaml');
    expect(sniffFormat('server:\n  host: localhost\n  port: 8080\ntimeout: 30\n')).toBe('yaml');
  });

  it('обычная проза → plain', () => {
    expect(sniffFormat('Просто текст документации.\nВторая строка.')).toBe('plain');
  });

  it('битый JSON → не json (никогда не бросает)', () => {
    expect(sniffFormat('[{"a": 1,,,')).not.toBe('json');
  });
});

describe('T-203 · normalizeForExtraction: JSON-записи → плоские строки', () => {
  it('массив записей release-notes разворачивается в «имя — описание» с ожидаемым числом записей', () => {
    const raw = JSON.stringify([
      { name: 'Поиск по проекту', description: 'Ищет требования по имени.' },
      { name: 'Экспорт в Excel', description: 'Выгружает дерево в xlsx.' },
    ]);
    const out = normalizeForExtraction(raw);
    expect(out.format).toBe('json');
    expect(out.expectedRecords).toBe(2);
    expect(out.text).toContain('Поиск по проекту');
    expect(out.text).toContain('Ищет требования по имени.');
    expect(out.text).toContain('Экспорт в Excel');
  });

  it('F2b: другой диалект ключей (title/details, вложенный массив) тоже разворачивается', () => {
    const raw = JSON.stringify({
      product: 'demo',
      releases: [
        {
          version: '1.2',
          changes: [
            { title: 'Новый фильтр', details: 'Фильтр по критичности.' },
            { title: 'Тёмная тема', details: 'Переключатель темы.' },
            { title: 'Горячие клавиши', details: 'Навигация с клавиатуры.' },
          ],
        },
      ],
    });
    const out = normalizeForExtraction(raw);
    expect(out.format).toBe('json');
    expect(out.expectedRecords).toBe(3);
    expect(out.text).toContain('Новый фильтр');
    expect(out.text).toContain('Фильтр по критичности.');
  });

  it('markdown-таблица → список «имя — описание», expectedRecords = число строк', () => {
    const md = [
      '# Функции',
      '',
      '| Функция | Описание |',
      '|---|---|',
      '| Поиск | Ищет требования |',
      '| Экспорт | Выгружает в Excel |',
      '',
      'Прочий текст.',
    ].join('\n');
    const out = normalizeForExtraction(md);
    expect(out.format).toBe('md-table');
    expect(out.expectedRecords).toBe(2);
    expect(out.text).toContain('Поиск');
    expect(out.text).toContain('Выгружает в Excel');
    // Окружающий текст не теряется.
    expect(out.text).toContain('Прочий текст.');
  });

  it('YAML → пары ключ/значение, структура не теряется', () => {
    const yaml = ['auth:', '  provider: ldap', '  timeout: 30', 'backup: daily'].join('\n');
    const out = normalizeForExtraction(yaml);
    expect(out.format).toBe('yaml');
    expect(out.text).toContain('provider: ldap');
    expect(out.text).toContain('backup: daily');
    expect(out.expectedRecords).toBeGreaterThan(0);
  });

  it('неизвестная структура → текст как есть, expectedRecords = null', () => {
    const raw = 'Обычная документация.\nБез таблиц и JSON.';
    const out = normalizeForExtraction(raw);
    expect(out.format).toBe('plain');
    expect(out.text).toBe(raw);
    expect(out.expectedRecords).toBeNull();
  });

  it('fuzz: битые JSON/YAML/обрывки никогда не бросают исключений', () => {
    const broken = [
      '[{"a": 1,,,',
      '{"unclosed": ',
      '---\n:\n:::\n\t- ] [',
      '| a | b |\n|--|',
      '\u0000\u0001\u0002',
      '[]',
      '{}',
      '   ',
      '[1, 2, 3]',
      'key: [unclosed',
      '- - - -\n:::',
    ];
    for (const raw of broken) {
      expect(() => normalizeForExtraction(raw)).not.toThrow();
      const out = normalizeForExtraction(raw);
      expect(typeof out.text).toBe('string');
    }
  });

  it('JSON-массив примитивов не считается записями (падать нельзя, идёт как текст)', () => {
    const out = normalizeForExtraction('[1, 2, 3]');
    expect(() => normalizeForExtraction('[1, 2, 3]')).not.toThrow();
    expect(out.text.length).toBeGreaterThan(0);
  });
});
