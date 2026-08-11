import { describe, expect, it } from 'vitest';
import { checkMove, planMove } from '../src/index.js';
import { link, makeReq } from './fixtures.js';

/**
 * Перемещение строки по дереву — это ровно одна операция над графом: замена
 * связи CHILD_OF. Здесь фиксируются правила, по которым портал отказывает
 * ЕЩЁ ДО запроса к серверу (подсветка цели) и по которым сервер отказывает
 * повторно, если кто-то обратится к API напрямую.
 */

/** Лента → (Алгоритмическая → Ранжирование), Бесконечная; Личные сообщения. */
function tree() {
  const feed = makeReq({
    slug: 'feed',
    name: 'Лента',
    links: [link('PARENT_OF', 'algo'), link('PARENT_OF', 'infinite')],
  });
  const algo = makeReq({
    slug: 'algo',
    name: 'Алгоритмическая лента',
    links: [link('CHILD_OF', 'feed'), link('PARENT_OF', 'rank')],
  });
  const rank = makeReq({ slug: 'rank', name: 'Ранжирование', links: [link('CHILD_OF', 'algo')] });
  const infinite = makeReq({
    slug: 'infinite',
    name: 'Бесконечная прокрутка',
    links: [link('CHILD_OF', 'feed')],
  });
  const dm = makeReq({ slug: 'dm', name: 'Личные сообщения', links: [] });
  return [feed, algo, rank, infinite, dm];
}

describe('checkMove', () => {
  it('разрешает переезд в другую ветку того же типа', () => {
    expect(checkMove(tree(), 'infinite', 'dm')).toBeNull();
  });

  it('разрешает вынести строку в корень', () => {
    expect(checkMove(tree(), 'infinite', null)).toBeNull();
  });

  it('запрещает бросок строки на саму себя', () => {
    expect(checkMove(tree(), 'feed', 'feed')).toMatchObject({ reason: 'SELF' });
  });

  it('запрещает вложить раздел в собственного потомка — это цикл', () => {
    // Лента → Алгоритмическая → Ранжирование: любой из потомков закрывает цикл.
    expect(checkMove(tree(), 'feed', 'algo')).toMatchObject({ reason: 'DESCENDANT' });
    expect(checkMove(tree(), 'feed', 'rank')).toMatchObject({ reason: 'DESCENDANT' });
  });

  it('иерархия живёт внутри типа: НФТ не становится ребёнком ФТ', () => {
    const reqs = [
      ...tree(),
      makeReq({ slug: 'uptime', type: 'NFR', name: 'Доступность 99.95%', links: [] }),
    ];
    expect(checkMove(reqs, 'uptime', 'feed')).toMatchObject({ reason: 'TYPE_MISMATCH' });
    expect(checkMove(reqs, 'infinite', 'uptime')).toMatchObject({ reason: 'TYPE_MISMATCH' });
  });

  it('не делает пустую работу: строка уже под этим родителем', () => {
    expect(checkMove(tree(), 'infinite', 'feed')).toMatchObject({ reason: 'SAME_PARENT' });
  });

  it('не делает пустую работу: корневую строку не «выносят в корень» повторно', () => {
    expect(checkMove(tree(), 'dm', null)).toMatchObject({ reason: 'SAME_PARENT' });
  });

  it('сообщает про отсутствующие строки, а не падает', () => {
    expect(checkMove(tree(), 'ghost', 'dm')).toMatchObject({ reason: 'NOT_FOUND' });
    expect(checkMove(tree(), 'infinite', 'ghost')).toMatchObject({ reason: 'NOT_FOUND' });
  });

  it('каждый отказ несёт человекочитаемое сообщение со слагами', () => {
    const block = checkMove(tree(), 'feed', 'algo');
    expect(block?.message).toContain('feed');
    expect(block?.message).toContain('algo');
  });
});

describe('planMove', () => {
  it('называет старого и нового родителя', () => {
    expect(planMove(tree(), 'infinite', 'dm')).toMatchObject({
      childSlug: 'infinite',
      oldParentSlug: 'feed',
      newParentSlug: 'dm',
    });
  });

  it('перечисляет потомков, которые переедут вместе со строкой', () => {
    const plan = planMove(tree(), 'feed', null);
    expect(plan.movedDescendants.sort()).toEqual(['algo', 'infinite', 'rank']);
  });

  it('у корневой строки старый родитель — null', () => {
    expect(planMove(tree(), 'dm', 'feed').oldParentSlug).toBeNull();
  });

  it('у листа переезжающих потомков нет', () => {
    expect(planMove(tree(), 'rank', 'dm').movedDescendants).toEqual([]);
  });

  it('не падает на неизвестном слаге', () => {
    expect(planMove(tree(), 'ghost', null)).toMatchObject({
      oldParentSlug: null,
      movedDescendants: [],
    });
  });
});
