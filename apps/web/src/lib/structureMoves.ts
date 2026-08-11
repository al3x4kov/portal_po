import { checkMove, parentSlugOf, type Requirement } from '@po/core';

/**
 * Операции режима структуры над ОДНОЙ строкой.
 *
 * Порядок соседей в дереве алфавитный и в файлах не хранится, поэтому «вверх/
 * вниз» не двигает строку среди соседей — оно переносит её в соседний раздел
 * (меняет родителя). Всё, что здесь считается, сводится к одному: каким станет
 * родитель. Ровно это и уходит на сервер.
 */
export type MoveOp = 'up' | 'down' | 'indent' | 'outdent';

/** Готовая к применению операция или причина, по которой она недоступна. */
export interface MoveOption {
  op: MoveOp;
  /** Новый родитель (null — вынести в корень); undefined, когда операция недоступна. */
  parentSlug?: string | null;
  /** Имя нового родителя для подписи кнопки («Перенести под …»). */
  parentName?: string;
  /** Почему нельзя — показывается вместо немого гашения кнопки. */
  disabledReason?: string;
}

/** Подписи операций — одни и те же в кнопке, подсказке и панели. */
export const MOVE_OP_LABEL: Record<MoveOp, string> = {
  up: 'В предыдущий раздел',
  down: 'В следующий раздел',
  indent: 'Вложить в строку выше',
  outdent: 'Поднять на уровень выше',
};

/** Горячая клавиша операции — та же, что в подсказках нижней панели. */
export const MOVE_OP_HOTKEY: Record<MoveOp, string> = {
  up: 'Alt + ↑',
  down: 'Alt + ↓',
  indent: 'Tab',
  outdent: 'Shift + Tab',
};

const byName = (a: Requirement, b: Requirement): number => a.name.localeCompare(b.name, 'ru');

/** Строки того же типа, висящие под тем же родителем, в порядке дерева. */
function siblingsOf(reqs: readonly Requirement[], req: Requirement): Requirement[] {
  const parent = parentSlugOf(req) ?? null;
  const bySlug = new Set(reqs.map((r) => r.slug));
  return reqs
    .filter((r) => {
      if (r.type !== req.type) return false;
      const p = parentSlugOf(r) ?? null;
      // Ссылка на требование вне набора = такой же корень, как и отсутствие ссылки.
      const normalized = p !== null && bySlug.has(p) ? p : null;
      return normalized === (parent !== null && bySlug.has(parent) ? parent : null);
    })
    .sort(byName);
}

/** Причина отказа ядра, переведённая в текст для пользователя. */
function reasonText(reqs: readonly Requirement[], childSlug: string, parentSlug: string | null) {
  const block = checkMove(reqs, childSlug, parentSlug);
  if (!block) return undefined;
  switch (block.reason) {
    case 'DESCENDANT':
      return 'Нельзя вложить строку в собственного потомка';
    case 'TYPE_MISMATCH':
      return 'Иерархия только внутри типа: ФТ и НФТ не смешиваются';
    case 'SELF':
      return 'Нельзя сделать строку родителем самой себя';
    case 'SAME_PARENT':
      return 'Строка уже здесь';
    default:
      return 'Строка не найдена — обновите дерево';
  }
}

/**
 * Посчитать все четыре операции для строки: куда она поедет и почему нет.
 *
 * @param reqs требования ОДНОГО типа (ФТ или НФТ) — иерархия не смешивается
 */
export function moveOptionsFor(reqs: readonly Requirement[], slug: string): MoveOption[] {
  const req = reqs.find((r) => r.slug === slug);
  if (!req) {
    return (['up', 'down', 'indent', 'outdent'] as MoveOp[]).map((op) => ({
      op,
      disabledReason: 'Строка не найдена — обновите дерево',
    }));
  }

  const bySlug = new Map(reqs.map((r) => [r.slug, r]));
  const parentSlug = parentSlugOf(req) ?? null;
  const parent = parentSlug !== null ? (bySlug.get(parentSlug) ?? null) : null;
  const siblings = siblingsOf(reqs, req);
  const index = siblings.findIndex((r) => r.slug === slug);
  const prev = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined;

  /**
   * «Соседний раздел» для ↑/↓. У вложенной строки это сосед её родителя —
   * строка переезжает в соседнюю ветку, оставаясь на своём уровне. У корневой
   * строки соседних разделов уровнем выше нет, поэтому соседний раздел — это
   * соседний корень, и строка становится его ребёнком.
   */
  const sectionNeighbours = ((): { prev?: Requirement; next?: Requirement } => {
    if (parent === null) return { prev, next };
    const parentSiblings = siblingsOf(reqs, parent);
    const pIndex = parentSiblings.findIndex((r) => r.slug === parent.slug);
    return {
      prev: pIndex > 0 ? parentSiblings[pIndex - 1] : undefined,
      next:
        pIndex >= 0 && pIndex < parentSiblings.length - 1 ? parentSiblings[pIndex + 1] : undefined,
    };
  })();

  const build = (
    op: MoveOp,
    target: Requirement | null | undefined,
    noTarget: string,
  ): MoveOption => {
    if (target === undefined) return { op, disabledReason: noTarget };
    const targetSlug = target === null ? null : target.slug;
    const reason = reasonText(reqs, slug, targetSlug);
    if (reason) return { op, disabledReason: reason };
    return {
      op,
      parentSlug: targetSlug,
      parentName: target === null ? 'корень раздела' : target.name,
    };
  };

  return [
    build('up', sectionNeighbours.prev, 'Это первый раздел — выше переносить некуда'),
    build('down', sectionNeighbours.next, 'Это последний раздел — ниже переносить некуда'),
    // «Вложить» = стать ребёнком соседа выше: единственная строка, которая
    // заведомо того же типа и не является потомком перемещаемой.
    build('indent', prev, 'Выше нет строки того же уровня'),
    // «Поднять» = встать рядом с родителем, то есть под его родителя (или в корень).
    build(
      'outdent',
      parent === null
        ? undefined
        : (parentSlugOf(parent) ?? null) === null
          ? null
          : (bySlug.get(parentSlugOf(parent) as string) ?? null),
      'Строка уже в корне',
    ),
  ];
}

/** Найти конкретную операцию (для кнопки/горячей клавиши). */
export function moveOption(
  reqs: readonly Requirement[],
  slug: string,
  op: MoveOp,
): MoveOption | undefined {
  return moveOptionsFor(reqs, slug).find((o) => o.op === op);
}

/** Можно ли бросить строку `childSlug` на строку `parentSlug` — и почему нет. */
export function dropReason(
  reqs: readonly Requirement[],
  childSlug: string,
  parentSlug: string | null,
): string | undefined {
  return reasonText(reqs, childSlug, parentSlug);
}
