import { describe, expect, it } from 'vitest';
import type { Link, Requirement } from '@po/core';
import { dropReason, moveOption, moveOptionsFor } from './structureMoves';

const link = (type: Link['type'], targetSlug: string): Link => ({ type, targetSlug });

function req(
  slug: string,
  name: string,
  links: Link[] = [],
  type: 'FUNCTION' | 'NFR' = 'FUNCTION',
) {
  return {
    slug,
    type,
    name,
    criticality: 'MEDIUM',
    implemented: true,
    links,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as Requirement;
}

/**
 * Дерево демо-проекта, соседи по алфавиту:
 *   Лента            → Алгоритмическая, Бесконечная прокрутка
 *   Личные сообщения → Диалоги 1-на-1
 *   Модерация
 */
function tree(): Requirement[] {
  return [
    req('feed', 'Лента', [link('PARENT_OF', 'algo'), link('PARENT_OF', 'infinite')]),
    req('algo', 'Алгоритмическая лента', [link('CHILD_OF', 'feed')]),
    req('infinite', 'Бесконечная прокрутка', [link('CHILD_OF', 'feed')]),
    req('dm', 'Личные сообщения', [link('PARENT_OF', 'dialog')]),
    req('dialog', 'Диалоги 1-на-1', [link('CHILD_OF', 'dm')]),
    req('moder', 'Модерация', []),
  ];
}

const opFor = (slug: string, op: 'up' | 'down' | 'indent' | 'outdent') =>
  moveOption(tree(), slug, op);

describe('moveOptionsFor · корневая строка', () => {
  it('«вниз» переносит в следующий корневой раздел — уровень увеличивается', () => {
    // Корни по алфавиту: Лента, Личные сообщения, Модерация.
    expect(opFor('feed', 'down')).toMatchObject({
      parentSlug: 'dm',
      parentName: 'Личные сообщения',
    });
  });

  it('«вверх» у первого раздела недоступно и называет причину', () => {
    expect(opFor('feed', 'up')?.disabledReason).toMatch(/перв/i);
  });

  it('«вниз» у последнего раздела недоступно', () => {
    expect(opFor('moder', 'down')?.disabledReason).toMatch(/последн/i);
  });

  it('«поднять на уровень выше» в корне недоступно', () => {
    expect(opFor('feed', 'outdent')?.disabledReason).toMatch(/корне/i);
  });
});

describe('moveOptionsFor · вложенная строка', () => {
  it('«вложить в строку выше» делает ребёнком предыдущего соседа', () => {
    // Дети «Ленты»: Алгоритмическая, Бесконечная прокрутка.
    expect(opFor('infinite', 'indent')).toMatchObject({ parentSlug: 'algo' });
  });

  it('у первого ребёнка «вложить» недоступно', () => {
    expect(opFor('algo', 'indent')?.disabledReason).toMatch(/выше нет/i);
  });

  it('«поднять на уровень выше» выносит в корень', () => {
    expect(opFor('infinite', 'outdent')).toMatchObject({
      parentSlug: null,
      parentName: 'корень раздела',
    });
  });

  it('«в следующий раздел» переносит в соседнюю ветку, сохраняя уровень', () => {
    // «Лента» → «Личные сообщения»: строка остаётся на втором уровне.
    expect(opFor('infinite', 'down')).toMatchObject({ parentSlug: 'dm' });
  });

  it('«в предыдущий раздел» недоступно, когда родитель — первый раздел', () => {
    expect(opFor('infinite', 'up')?.disabledReason).toMatch(/перв/i);
  });

  it('поднятие со второго уровня отдаёт родителя родителя', () => {
    const deep = [...tree(), req('rank', 'Ранжирование', [link('CHILD_OF', 'algo')])];
    deep.find((r) => r.slug === 'algo')?.links.push(link('PARENT_OF', 'rank'));
    expect(moveOption(deep, 'rank', 'outdent')).toMatchObject({ parentSlug: 'feed' });
  });
});

describe('moveOptionsFor · пограничные случаи', () => {
  it('неизвестный слаг: все операции недоступны с понятной причиной', () => {
    const options = moveOptionsFor(tree(), 'ghost');
    expect(options).toHaveLength(4);
    expect(options.every((o) => o.disabledReason?.includes('не найдена'))).toBe(true);
  });

  it('единственная строка в проекте никуда не двигается', () => {
    const only = [req('solo', 'Единственная')];
    expect(moveOptionsFor(only, 'solo').every((o) => o.disabledReason)).toBe(true);
  });
});

describe('dropReason', () => {
  it('разрешает бросок в другую ветку', () => {
    expect(dropReason(tree(), 'infinite', 'dm')).toBeUndefined();
  });

  it('называет цикл словами, а не кодом', () => {
    expect(dropReason(tree(), 'feed', 'algo')).toMatch(/потомка/i);
  });

  it('называет запрет по типу', () => {
    const mixed = [...tree(), req('uptime', 'Доступность', [], 'NFR')];
    expect(dropReason(mixed, 'uptime', 'feed')).toMatch(/ФТ и НФТ/i);
  });

  it('бросок на самого себя запрещён', () => {
    expect(dropReason(tree(), 'feed', 'feed')).toMatch(/самой себя/i);
  });

  it('бросок к текущему родителю — «строка уже здесь»', () => {
    expect(dropReason(tree(), 'infinite', 'feed')).toMatch(/уже здесь/i);
  });
});
