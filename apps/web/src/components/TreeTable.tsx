import type { LinkType, Requirement } from '@po/core';
import type { VisibleRow } from '../lib/visibility';
import { dependenciesLabel } from '../lib/plural';
import { LINK_TYPE_LABEL, describeLink } from '../lib/linkTypes';
import { CriticalityBadge, ImplementationBadge } from './badges';

/** Link types shown as inline relationship chips (hierarchy is shown by the tree itself). */
const REL_TYPES: readonly LinkType[] = ['RELATES_TO', 'DEPENDS_ON', 'BLOCKED_BY'];

function relChipStyle(type: LinkType): React.CSSProperties {
  switch (type) {
    case 'BLOCKED_BY':
      return { background: 'var(--color-danger-bg)', color: 'var(--color-danger)' };
    case 'DEPENDS_ON':
      return { background: 'var(--color-warning-bg)', color: 'var(--color-warning)' };
    default:
      return { background: 'var(--color-primary-soft)', color: 'var(--color-primary)' };
  }
}

interface TreeTableProps {
  title: string;
  addLabel: string;
  testidPrefix: string;
  /** Total requirements in this section (for the header counter). */
  count: number;
  rows: VisibleRow[];
  /** Project-wide slug → name map, to render link targets by name. */
  nameBySlug: Map<string, string>;
  /** Slugs whose acceptance criterion is missing/incomplete (SA-4/SA-6). */
  incompleteSet?: ReadonlySet<string>;
  onAdd: () => void;
  onEdit: (req: Requirement) => void;
  onLink: (req: Requirement) => void;
  /** T4: add an NFR pre-linked to a functional requirement (only wired for the ФТ section). */
  onAddNfr?: (req: Requirement) => void;
  onDelete: (req: Requirement) => void;
  onDescExpand: (req: Requirement) => void;
  /** Expand a collapsed branch (collapse mode chip). */
  onExpandNode: (slug: string) => void;
}

function Row({
  row,
  nameBySlug,
  incomplete,
  onEdit,
  onLink,
  onAddNfr,
  onDelete,
  onDescExpand,
  onExpandNode,
}: {
  row: VisibleRow;
  nameBySlug: Map<string, string>;
  incomplete: boolean;
  onEdit: (r: Requirement) => void;
  onLink: (r: Requirement) => void;
  onAddNfr?: (r: Requirement) => void;
  onDelete: (r: Requirement) => void;
  onDescExpand: (r: Requirement) => void;
  onExpandNode: (slug: string) => void;
}): React.ReactElement {
  const req = row.requirement;
  const isContext = row.kind === 'context';
  const collapsedBranch = row.hiddenCount > 0;
  const relLinks = req.links.filter((l) => REL_TYPES.includes(l.type));
  // T4: only functional requirements can spawn a pre-linked NFR (ФТ BLOCKED_BY НФТ).
  const canAddNfr = Boolean(onAddNfr) && req.type === 'FUNCTION';

  return (
    <tr
      className="group border-b"
      style={{ borderColor: 'var(--color-border)', opacity: isContext ? 0.6 : 1 }}
      data-testid={`tree-row-${req.slug}`}
      data-req-name={req.name}
      data-row-kind={row.kind}
    >
      <td className="py-2.5 pr-3 align-middle">
        <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: row.depth * 24 }}>
          {row.hasChildren ? (
            <span className="text-sm" style={{ color: 'var(--color-text-3)' }} aria-hidden="true">
              {collapsedBranch ? '▸' : '▾'}
            </span>
          ) : (
            <span
              className="px-1 text-sm"
              style={{ color: 'var(--color-text-3)' }}
              aria-hidden="true"
            >
              •
            </span>
          )}
          <button
            type="button"
            className="min-w-0 truncate text-left font-medium hover:underline"
            data-testid={`req-name-${req.slug}`}
            title={req.name}
            onClick={() => onEdit(req)}
          >
            {req.name}
          </button>
          {isContext ? (
            <span
              className="text-[10px] font-semibold uppercase tracking-wide"
              style={{ color: 'var(--color-text-3)' }}
              data-testid={`ancestor-label-${req.slug}`}
            >
              предок
            </span>
          ) : null}
          {incomplete ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
              style={{ background: 'var(--color-warning-bg)', color: 'var(--color-warning)' }}
              data-testid="incomplete-badge"
              data-slug={req.slug}
              title="Нет полного критерия приёмки (сценария WHEN/THEN)"
              aria-label="Нет полного критерия приёмки"
            >
              <span aria-hidden="true">⚠</span> без критерия
            </span>
          ) : null}
          {collapsedBranch ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
              style={{ background: 'var(--color-primary-soft)', color: 'var(--color-primary)' }}
              data-testid="expand-node"
              data-slug={req.slug}
              onClick={() => onExpandNode(req.slug)}
            >
              {dependenciesLabel(row.hiddenCount)}
            </button>
          ) : null}
        </div>
      </td>
      <td className="w-[130px] py-2.5 pr-3 align-middle" data-testid="req-criticality-cell">
        <CriticalityBadge criticality={req.criticality} />
      </td>
      <td className="w-[140px] py-2.5 pr-3 align-middle" data-testid="req-implemented-cell">
        <ImplementationBadge req={req} />
      </td>
      <td className="py-2.5 pr-3 align-top" data-testid="req-links-cell">
        {relLinks.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {relLinks.map((l) => {
              const targetName = nameBySlug.get(l.targetSlug) ?? l.targetSlug;
              return (
                <span
                  key={`${l.type}-${l.targetSlug}`}
                  className="inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
                  style={relChipStyle(l.type)}
                  data-testid={`rel-chip-${req.slug}-${l.targetSlug}`}
                  data-rel-type={l.type}
                  title={describeLink(req.name, l.type, targetName)}
                >
                  <span className="opacity-70">{LINK_TYPE_LABEL[l.type]}</span>
                  <span className="truncate">«{targetName}»</span>
                </span>
              );
            })}
          </div>
        ) : (
          <span style={{ color: 'var(--color-text-3)' }}>—</span>
        )}
      </td>
      <td className="py-2.5 pr-3 align-middle text-sm">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 text-left hover:text-[var(--color-primary)]"
          style={{ color: 'var(--color-text-2)' }}
          data-testid="desc-expand"
          data-slug={req.slug}
          onClick={() => onDescExpand(req)}
          title="Открыть описание"
        >
          <span className="block min-w-0 flex-1 truncate">
            {req.description && req.description.length > 0 ? req.description : '—'}
          </span>
        </button>
      </td>
      <td className="w-[210px] py-2.5 pr-4 align-middle text-right">
        {/* UX-1: actions stay visible (subtle by default), and any focused button
            becomes fully visible via group-focus-within — keyboard-reachable and
            identical on desktop/mobile, while remaining inside the row card. */}
        <div
          className="inline-flex flex-nowrap justify-end gap-1 whitespace-nowrap opacity-70 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
          data-testid={`row-actions-${req.slug}`}
        >
          {canAddNfr ? (
            <button
              type="button"
              className="btn btn-ghost px-2 py-1 text-xs"
              data-testid="row-add-nfr"
              data-slug={req.slug}
              onClick={() => onAddNfr?.(req)}
            >
              + НФТ
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost px-2 py-1 text-xs"
            data-testid={`link-btn-${req.slug}`}
            onClick={() => onLink(req)}
          >
            Связать
          </button>
          <button
            type="button"
            className="btn btn-ghost px-2 py-1 text-xs"
            style={{ color: 'var(--color-danger)' }}
            data-testid={`delete-btn-${req.slug}`}
            onClick={() => onDelete(req)}
          >
            Удалить
          </button>
        </div>
      </td>
    </tr>
  );
}

export function TreeTable({
  title,
  addLabel,
  testidPrefix,
  count,
  rows,
  nameBySlug,
  incompleteSet,
  onAdd,
  onEdit,
  onLink,
  onAddNfr,
  onDelete,
  onDescExpand,
  onExpandNode,
}: TreeTableProps): React.ReactElement {
  return (
    <section className="card mb-5 overflow-hidden" data-testid={`section-${testidPrefix}`}>
      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)' }}
      >
        <h2 className="font-bold">
          {title} <span style={{ color: 'var(--color-text-3)' }}>({count})</span>
        </h2>
        <button
          type="button"
          className="btn btn-primary py-1.5 text-sm"
          data-testid={`add-${testidPrefix}`}
          onClick={onAdd}
        >
          {addLabel}
        </button>
      </div>

      {count === 0 ? (
        <p
          className="px-4 py-6 text-sm"
          style={{ color: 'var(--color-text-3)' }}
          data-testid={`empty-${testidPrefix}`}
        >
          Пока нет требований. Нажмите «{addLabel}», чтобы добавить.
        </p>
      ) : rows.length === 0 ? (
        <p
          className="px-4 py-6 text-sm"
          style={{ color: 'var(--color-text-3)' }}
          data-testid={`filtered-empty-${testidPrefix}`}
        >
          Нет требований, подходящих под фильтры.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-sm" data-testid={`table-${testidPrefix}`}>
            <thead>
              <tr
                className="text-left text-xs uppercase tracking-wide"
                style={{ color: 'var(--color-text-3)' }}
              >
                <th className="w-[26%] px-4 py-2 font-semibold">Требование</th>
                <th className="w-[130px] px-4 py-2 font-semibold">Критичность</th>
                <th className="w-[140px] px-4 py-2 font-semibold">Реализация</th>
                <th className="w-[20%] px-4 py-2 font-semibold">Связи</th>
                <th className="px-4 py-2 font-semibold">Описание</th>
                <th className="w-[210px] px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row
                  key={row.requirement.slug}
                  row={row}
                  nameBySlug={nameBySlug}
                  incomplete={incompleteSet?.has(row.requirement.slug) ?? false}
                  onEdit={onEdit}
                  onLink={onLink}
                  onAddNfr={onAddNfr}
                  onDelete={onDelete}
                  onDescExpand={onDescExpand}
                  onExpandNode={onExpandNode}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
