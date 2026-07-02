import type { Link, LinkType } from '@po/core';
import { LINK_TYPE_LABEL } from '../lib/linkTypes';

interface PendingDelete {
  type: LinkType;
  targetSlug: string;
}

interface LinkListProps {
  links: Link[];
  nameBySlug?: Map<string, string>;
  /** The link currently awaiting inline delete confirmation, if any. */
  pendingDelete: PendingDelete | null;
  /** A delete request is in flight (disables the confirm button). */
  deleting: boolean;
  onRequestDelete: (link: Link) => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

interface LinkRowProps {
  link: Link;
  targetName: string;
  isPending: boolean;
  deleting: boolean;
  onRequestDelete: (link: Link) => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

/**
 * A single relationship row with an inline (two-step) delete confirmation
 * (BE-5, extracted from RequirementModal — T3). Deleting removes the reciprocal
 * pair server-side, so the copy warns it disappears for both requirements.
 */
function LinkRow({
  link,
  targetName,
  isPending,
  deleting,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: LinkRowProps): React.ReactElement {
  return (
    <div data-testid={`req-link-${link.targetSlug}`} data-link-type={link.type}>
      {isPending ? (
        <div
          className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5"
          style={{ background: 'var(--color-danger-bg)' }}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium" style={{ color: 'var(--color-danger)' }}>
              Удалить связь «{LINK_TYPE_LABEL[link.type]} «{targetName}»»?
            </p>
            <p className="text-xs" style={{ color: 'var(--color-danger)' }}>
              Связь исчезнет у обоих требований.
            </p>
          </div>
          <div className="flex flex-none items-center gap-2">
            <button
              type="button"
              className="btn btn-secondary py-1 text-xs"
              data-testid="req-link-del-cancel"
              onClick={onCancelDelete}
            >
              Отменить
            </button>
            <button
              type="button"
              className="btn btn-danger py-1 text-xs"
              data-testid="req-link-del-confirm"
              disabled={deleting}
              onClick={onConfirmDelete}
            >
              Удалить
            </button>
          </div>
        </div>
      ) : (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">
              <span style={{ color: 'var(--color-text-3)' }}>{LINK_TYPE_LABEL[link.type]}</span>{' '}
              <span className="font-medium">«{targetName}»</span>
            </p>
            <p
              className="text-[11px] uppercase tracking-wide"
              style={{ color: 'var(--color-text-3)' }}
            >
              {link.type}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost flex-none px-2 py-1 text-xs"
            style={{ color: 'var(--color-danger)' }}
            data-testid={`req-link-del-${link.targetSlug}`}
            aria-label={`Удалить связь «${targetName}»`}
            onClick={() => onRequestDelete(link)}
          >
            Удалить
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The requirement's relationship list (BE-5, extracted from RequirementModal —
 * T2/T3). Presentational: the parent owns the links state and the delete
 * mutation; this renders the label, empty state and the rows.
 */
export function LinkList({
  links,
  nameBySlug,
  pendingDelete,
  deleting,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: LinkListProps): React.ReactElement {
  return (
    <div>
      <span className="label">
        Связи{' '}
        <span className="font-normal" style={{ color: 'var(--color-text-3)' }}>
          ({links.length})
        </span>
      </span>
      {links.length === 0 ? (
        <p
          className="rounded-lg px-3 py-4 text-center text-sm"
          style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-3)' }}
          data-testid="req-links-empty"
        >
          Связей нет
        </p>
      ) : (
        <div className="space-y-1.5" data-testid="req-links">
          {links.map((l) => (
            <LinkRow
              key={`${l.type}-${l.targetSlug}`}
              link={l}
              targetName={nameBySlug?.get(l.targetSlug) ?? l.targetSlug}
              isPending={
                pendingDelete?.type === l.type && pendingDelete?.targetSlug === l.targetSlug
              }
              deleting={deleting}
              onRequestDelete={onRequestDelete}
              onCancelDelete={onCancelDelete}
              onConfirmDelete={onConfirmDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
