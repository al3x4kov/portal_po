import { LINK_TYPES, LINK_TYPE_LABEL, type LinkType } from '@po/core';

// Short readable labels live in core (BE-3); re-exported for existing web imports.
export { LINK_TYPE_LABEL } from '@po/core';

/** Phrase (with connector) used to build the readable relationship sentence. */
export const LINK_TYPE_PHRASE: Record<LinkType, string> = {
  CHILD_OF: 'является дочерней для',
  PARENT_OF: 'является родителем для',
  RELATES_TO: 'связана с',
  DEPENDS_ON: 'зависит от',
  BLOCKED_BY: 'блокируется',
};

export const LINK_TYPE_OPTIONS: { value: LinkType; label: string }[] = LINK_TYPES.map((t) => ({
  value: t,
  label: `${LINK_TYPE_LABEL[t]} (${t})`,
}));

/** Build the human-readable "что / тип / с чем" sentence (FR-8). */
export function describeLink(sourceName: string, type: LinkType, targetName: string): string {
  return `«${sourceName}» ${LINK_TYPE_PHRASE[type]} «${targetName}».`;
}
