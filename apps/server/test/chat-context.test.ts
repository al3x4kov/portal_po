import { describe, expect, it } from 'vitest';
import {
  AI_CHAT_CONTEXT_CHAR_BUDGET,
  AI_CHAT_CONTEXT_DESC_CHARS,
  AI_CHAT_CONTEXT_TOP_K,
  type Requirement,
} from '@po/core';
import {
  buildChatProjectContext,
  questionTokens,
  scoreRequirement,
} from '../src/services/chatContext.js';

/*
 * Контекст требований проекта для чат-виджета: маленький проект уезжает в
 * модель целиком (режим full), большой (1000–2000 ФТ/НФТ) — релевантной
 * вопросу выборкой + обзором дерева под символьный бюджет (режим partial).
 * Детерминированно, без AI-вызовов; обрезка всегда названа явно.
 */

function req(over: Partial<Requirement> & { slug: string; name: string }): Requirement {
  return {
    type: 'FUNCTION',
    criticality: 'MEDIUM',
    implemented: true,
    links: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** Большой проект: N реализованных ФТ с шумовыми именами + описаниями. */
function bigProject(n: number): Requirement[] {
  return Array.from({ length: n }, (_, i) =>
    req({
      slug: `f${i}`,
      name: `Функция раздела ${i}`,
      description: `Служебное описание возможности номер ${i} без ключевых слов.`,
    }),
  );
}

describe('questionTokens / scoreRequirement', () => {
  it('токены: нормализация, ≥3 символов, без стоп-слов и дублей', () => {
    expect(questionTokens('Как у нас РАБОТАЕТ «оплата картой»? Оплата!')).toEqual([
      'нас',
      'работает',
      'оплата',
      'картой',
    ]);
  });

  it('вхождение в имя весит дороже вхождения в описание', () => {
    const tokens = questionTokens('оплата картой');
    const byName = req({ slug: 'a', name: 'Оплата картой', description: 'Проведение платежа.' });
    const byDesc = req({ slug: 'b', name: 'Платежи', description: 'Оплата картой и по счёту.' });
    const noMatch = req({ slug: 'c', name: 'Поиск', description: 'Поиск по имени.' });
    expect(scoreRequirement(byName, tokens)).toBeGreaterThan(scoreRequirement(byDesc, tokens));
    expect(scoreRequirement(byDesc, tokens)).toBeGreaterThan(0);
    expect(scoreRequirement(noMatch, tokens)).toBe(0);
  });
});

describe('buildChatProjectContext · режим full (малый проект)', () => {
  it('10 требований: полный список с типом, критичностью, статусом, родителем и описанием', () => {
    const parent = req({ slug: 'pay', name: 'Платежи', criticality: 'HIGH' });
    const child = req({
      slug: 'card',
      name: 'Оплата картой',
      implemented: false,
      targetQuarter: 'Q3',
      targetYear: 2026,
      description: 'Оплата банковской картой через шлюз.',
      links: [{ type: 'CHILD_OF', targetSlug: 'pay' }],
    });
    const nfr = req({ slug: 'perf', name: 'Время отклика', type: 'NFR', criticality: 'CRITICAL' });
    const ctx = buildChatProjectContext([parent, child, nfr], 'любой вопрос');

    expect(ctx.mode).toBe('full');
    expect(ctx.text).toContain('всего 3 (ФТ 2, НФТ 1)');
    expect(ctx.text).toContain('[ФТ · высокая · реализовано] «Платежи»');
    expect(ctx.text).toContain(
      '[ФТ · средняя · план Q3 2026] «Оплата картой» (родитель: «Платежи»)',
    );
    expect(ctx.text).toContain('— Оплата банковской картой через шлюз.');
    expect(ctx.text).toContain('[НФТ · критическая · реализовано] «Время отклика»');
  });

  it('длинное описание обрезается до лимита', () => {
    const long = 'слово '.repeat(300).trim();
    const ctx = buildChatProjectContext(
      [req({ slug: 'a', name: 'Функция', description: long })],
      '',
    );
    expect(ctx.mode).toBe('full');
    const line = ctx.text.split('\n').find((l) => l.includes('«Функция»'))!;
    expect(line.length).toBeLessThan(AI_CHAT_CONTEXT_DESC_CHARS + 120);
    expect(line).toContain('…');
  });

  it('пустой проект — честная строка вместо пустого блока', () => {
    expect(buildChatProjectContext([], 'вопрос').text).toContain(
      'не зафиксировано ни одного требования',
    );
  });
});

describe('buildChatProjectContext · режим partial (1000–2000 требований)', () => {
  it('1500 требований: бюджет соблюдён, релевантные — с деталями, обрезка обзора названа явно', () => {
    const needle = req({
      slug: 'target',
      name: 'Оплата картой',
      description: 'Оплата банковской картой через платёжный шлюз.',
    });
    const reqs = [...bigProject(1500), needle];
    const ctx = buildChatProjectContext(reqs, 'Как устроена оплата картой?');

    expect(ctx.mode).toBe('partial');
    expect(ctx.text.length).toBeLessThanOrEqual(AI_CHAT_CONTEXT_CHAR_BUDGET);
    expect(ctx.text).toContain('ЧАСТИЧНЫЙ контекст');
    // Релевантное требование ушло с полными деталями (описание, не только имя).
    expect(ctx.text).toContain('«Оплата картой» — Оплата банковской картой через платёжный шлюз.');
    // Обзор дерева обрезан не молча.
    expect(ctx.text).toMatch(/…и ещё \d+ требований за пределами бюджета\./);
  });

  it('релевантных не больше TOP_K даже когда совпадений много', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      req({ slug: `pay${i}`, name: `Оплата картой ${i}` }),
    );
    const ctx = buildChatProjectContext([...bigProject(1200), ...many], 'оплата картой', 8000);
    expect(ctx.mode).toBe('partial');
    const detailsHeader = ctx.text.match(/Релевантные вопросу требования \((\d+)\):/);
    expect(detailsHeader).not.toBeNull();
    expect(Number(detailsHeader![1])).toBeLessThanOrEqual(AI_CHAT_CONTEXT_TOP_K);
  });

  it('вопрос без совпадений: выборки нет, но обзор дерева и честная пометка есть', () => {
    const ctx = buildChatProjectContext(bigProject(1200), 'ъыъыъ', 6000);
    expect(ctx.mode).toBe('partial');
    expect(ctx.text).toContain('релевантные требования не найдены');
    expect(ctx.text).toContain('Обзор дерева требований');
    expect(ctx.text.length).toBeLessThanOrEqual(6000);
  });

  it('иерархия в обзоре: дети идут с отступом под родителем', () => {
    const roots = bigProject(800);
    const parent = req({ slug: 'root-x', name: 'Раздел Икс' });
    const child = req({
      slug: 'leaf-x',
      name: 'Лист Икс',
      links: [{ type: 'CHILD_OF', targetSlug: 'root-x' }],
    });
    // Родитель и дитя — в начале списка, чтобы гарантированно попасть в обзор.
    const ctx = buildChatProjectContext([parent, child, ...roots], 'вопрос', 8000);
    expect(ctx.mode).toBe('partial');
    const lines = ctx.text.split('\n');
    const p = lines.findIndex((l) => l === '- [ФТ] Раздел Икс');
    expect(p).toBeGreaterThan(-1);
    expect(lines[p + 1]).toBe('  - [ФТ] Лист Икс');
  });
});
