import type { LinkType } from '@po/core';

/** Short readable labels for the web UI. Средний род «требование» — «оно»
 *  (дочернее, связано); the core labels stay untouched for the Excel export. */
export const LINK_TYPE_LABEL: Record<LinkType, string> = {
  CHILD_OF: 'является дочерним',
  PARENT_OF: 'является родителем',
  RELATES_TO: 'связано с',
  DEPENDS_ON: 'зависит от',
  BLOCKED_BY: 'блокируется',
};

/** Phrase (with connector) used to build the readable relationship sentence.
 *  Средний род: «требование» — оно (дочернее, связано). */
export const LINK_TYPE_PHRASE: Record<LinkType, string> = {
  CHILD_OF: 'является дочерним для',
  PARENT_OF: 'является родителем для',
  RELATES_TO: 'связано с',
  DEPENDS_ON: 'зависит от',
  BLOCKED_BY: 'блокируется',
};

/**
 * Link types in the LinkModal, ordered per the link-modal mockup (§2.11):
 * the safe symmetric «Двусторонняя связь» goes first, CHILD_OF is NOT first.
 * Each option carries a one-line description shown in the radio card.
 */
export const LINK_TYPE_OPTIONS: { value: LinkType; label: string; description: string }[] = [
  {
    value: 'RELATES_TO',
    label: 'Двусторонняя связь',
    description:
      'Требования связаны по смыслу, без иерархии и направления. Самый частый и безопасный тип.',
  },
  {
    value: 'CHILD_OF',
    label: 'Дочернее для цели',
    description:
      'Текущее требование станет ребёнком цели. У требования может быть только один родитель.',
  },
  {
    value: 'PARENT_OF',
    label: 'Родитель для цели',
    description: 'Обратное направление: цель станет ребёнком текущего требования.',
  },
  {
    value: 'DEPENDS_ON',
    label: 'Зависит от цели',
    description: 'Реализация текущего требования невозможна без реализации цели.',
  },
  {
    value: 'BLOCKED_BY',
    label: 'Блокируется целью',
    description: 'Работа по текущему требованию не начнётся, пока цель не будет выполнена.',
  },
];

/** Build the human-readable "что / тип / с чем" sentence (FR-8). */
export function describeLink(sourceName: string, type: LinkType, targetName: string): string {
  return `«${sourceName}» ${LINK_TYPE_PHRASE[type]} «${targetName}».`;
}
