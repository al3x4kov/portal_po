import { Fragment, useState } from 'react';
import type { LinkType, Requirement } from '@po/core';
import type { VisibleRow } from '../lib/visibility';
import { buildLineGuides, type LineGuide } from '../lib/treeLines';
import { nestedLabel } from '../lib/plural';
import { LINK_TYPE_LABEL, describeLink } from '../lib/linkTypes';
import { CriticalityBadge, ImplementationBadge } from './badges';
import { InlineAddChildForm } from './InlineAddChildForm';

/** Link types shown as inline relationship chips (hierarchy is shown by the tree itself). */
const REL_TYPES: readonly LinkType[] = ['RELATES_TO', 'DEPENDS_ON', 'BLOCKED_BY'];

function relChipStyle(type: LinkType): React.CSSProperties {
  switch (type) {
    case 'BLOCKED_BY':
      return { background: 'var(--color-danger-bg)', color: 'var(--color-danger-fg)' };
    case 'DEPENDS_ON':
      return { background: 'var(--color-warning-bg)', color: 'var(--color-warning-fg)' };
    default:
      return { background: 'var(--color-primary-soft)', color: 'var(--color-primary)' };
  }
}

/* ── SVG icon components (Lucide-style, 18×18) ─────────────────────────── */

function IconChainLink(): React.ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function IconCirclePlus(): React.ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function IconTrash(): React.ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>
  );
}

/* ── Shared icon-button base style ─────────────────────────────────────── */
const iconBtnBase: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  padding: '4px',
  borderRadius: '4px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--color-text-3)',
  width: 30,
  height: 30,
};

interface TreeTableProps {
  title: string;
  addLabel: string;
  testidPrefix: string;
  /** Total requirements in this section (for the header counter). */
  count: number;
  rows: VisibleRow[];
  /** Project-wide slug → name map, to render link targets by name. */
  nameBySlug: Map<string, string>;
  onAdd: () => void;
  onEdit: (req: Requirement) => void;
  onLink: (req: Requirement) => void;
  /** T4: add an NFR pre-linked to a functional requirement (only wired for the ФТ section). */
  onAddNfr?: (req: Requirement) => void;
  /** T-509: add a child functional requirement (FUNCTION rows only). */
  onAddChild?: (req: Requirement) => void;
  /** T-510: inline add-child form handler (parentSlug, childName) => Promise. */
  onInlineAddChild?: (parentSlug: string, name: string) => Promise<void>;
  onDelete: (req: Requirement) => void;
  onDescExpand: (req: Requirement) => void;
  /** Expand a collapsed branch (collapse mode chip). */
  onExpandNode: (slug: string) => void;
  /**
   * UX-7: toggle (expand/collapse) a single node via the chevron. Only wired in
   * collapse mode, where per-node expansion is meaningful.
   */
  onToggleNode?: (slug: string) => void;
  /**
   * UX-7: when true the chevron is an interactive toggle button; otherwise it is
   * a purely decorative, non-clickable marker (no false affordance).
   */
  interactiveChevron?: boolean;
}

function Row({
  row,
  lineGuides,
  nameBySlug,
  onEdit,
  onLink,
  onAddNfr,
  onAddChild,
  onDelete,
  onDescExpand,
  onExpandNode,
  onToggleNode,
  interactiveChevron,
}: {
  row: VisibleRow;
  lineGuides: LineGuide[];
  nameBySlug: Map<string, string>;
  onEdit: (r: Requirement) => void;
  onLink: (r: Requirement) => void;
  onAddNfr?: (r: Requirement) => void;
  onAddChild?: (r: Requirement) => void;
  onDelete: (r: Requirement) => void;
  onDescExpand: (r: Requirement) => void;
  onExpandNode: (slug: string) => void;
  onToggleNode?: (slug: string) => void;
  interactiveChevron?: boolean;
}): React.ReactElement {
  const req = row.requirement;
  const isContext = row.kind === 'context';
  const collapsedBranch = row.hiddenCount > 0;
  const relLinks = req.links.filter((l) => REL_TYPES.includes(l.type));
  // T4: only functional requirements can spawn a pre-linked NFR (ФТ BLOCKED_BY НФТ).
  const canAddNfr = Boolean(onAddNfr) && req.type === 'FUNCTION';
  // T-509: functional rows get an "add child" button.
  const canAddChild = Boolean(onAddChild) && req.type === 'FUNCTION';
  // T-509: disable delete when node has children.
  const deleteDisabled = row.hasChildren;

  return (
    <tr
      className="group border-b"
      style={{ borderColor: 'var(--color-border)', opacity: isContext ? 0.6 : 1 }}
      data-testid={`tree-row-${req.slug}`}
      data-req-name={req.name}
      data-row-kind={row.kind}
    >
      <td className="py-2.5 pr-3 align-middle">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* T-507: CSS tree line guides — one span per ancestor level */}
          {lineGuides.map((guide, k) => (
            <span
              key={k}
              className={`tree-guide tree-guide--${guide}`}
              aria-hidden="true"
              style={{ flexShrink: 0, width: '20px', position: 'relative', alignSelf: 'stretch' }}
            />
          ))}
          {/* Chevron / bullet indicator */}
          {row.hasChildren ? (
            interactiveChevron ? (
              <button
                type="button"
                className="shrink-0 rounded px-0.5 text-sm hover:text-[var(--color-primary)]"
                style={{ color: 'var(--color-text-3)' }}
                data-testid="toggle-node"
                data-slug={req.slug}
                aria-expanded={!collapsedBranch}
                aria-label={
                  collapsedBranch ? `Раскрыть «${req.name}»` : `Свернуть «${req.name}»`
                }
                onClick={() => onToggleNode?.(req.slug)}
              >
                {collapsedBranch ? '▸' : '▾'}
              </button>
            ) : (
              <span
                className="text-sm"
                style={{ color: 'var(--color-text-3)' }}
                aria-hidden="true"
              >
                {collapsedBranch ? '▸' : '▾'}
              </span>
            )
          ) : (
            <span
              className="px-1 text-sm"
              style={{ color: 'var(--color-text-3)' }}
              aria-hidden="true"
            >
              •
            </span>
          )}
          {/* UX-10: name is an explicit edit affordance (link-style button). */}
          <button
            type="button"
            className="min-w-0 truncate text-left font-medium underline decoration-dotted underline-offset-2 hover:decoration-solid"
            data-testid={`req-name-${req.slug}`}
            title={`Редактировать «${req.name}»`}
            aria-label={`Редактировать «${req.name}»`}
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
          {collapsedBranch ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
              style={{ background: 'var(--color-primary-soft)', color: 'var(--color-primary)' }}
              data-testid="expand-node"
              data-slug={req.slug}
              onClick={() => onExpandNode(req.slug)}
            >
              {nestedLabel(row.hiddenCount)}
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
          aria-label="Открыть описание"
        >
          <span className="block min-w-0 flex-1 truncate">
            {req.description && req.description.length > 0 ? req.description : '—'}
          </span>
        </button>
      </td>
      {/* T-509: icon action buttons hidden at rest, visible on row hover */}
      <td className="w-[140px] py-2.5 pr-4 align-middle text-right">
        <div
          className="inline-flex flex-nowrap justify-end gap-0.5 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100"
          data-testid={`row-actions-${req.slug}`}
        >
          {/* ФТ-only: add child (T-510 will wire the create modal) */}
          {canAddChild ? (
            <button
              type="button"
              style={{ ...iconBtnBase, color: 'var(--color-primary)' }}
              data-testid="row-add-child"
              data-slug={req.slug}
              title="Добавить дочернее требование"
              aria-label="Добавить дочернее требование"
              onClick={() => onAddChild?.(req)}
            >
              <IconCirclePlus />
            </button>
          ) : null}
          {/* Link button — all rows */}
          <button
            type="button"
            style={iconBtnBase}
            className="hover:text-[var(--color-primary)]"
            data-testid={`link-btn-${req.slug}`}
            title="Связать с другим требованием"
            aria-label="Связать с другим требованием"
            onClick={() => onLink(req)}
          >
            <IconChainLink />
          </button>
          {/* ФТ-only: add pre-linked NFR */}
          {canAddNfr ? (
            <button
              type="button"
              style={{ ...iconBtnBase, color: 'var(--color-success)' }}
              data-testid="row-add-nfr"
              data-slug={req.slug}
              title="Добавить связанное НФТ"
              aria-label="Добавить связанное НФТ"
              onClick={() => onAddNfr?.(req)}
            >
              <IconCirclePlus />
            </button>
          ) : null}
          {/* Delete — all rows; disabled when node has children */}
          <button
            type="button"
            style={
              deleteDisabled
                ? { ...iconBtnBase, opacity: 0.4, cursor: 'not-allowed' }
                : iconBtnBase
            }
            className={deleteDisabled ? '' : 'hover:text-[var(--color-danger)]'}
            data-testid={`delete-btn-${req.slug}`}
            title={deleteDisabled ? 'Сначала удалите дочерние' : 'Удалить требование'}
            aria-label={deleteDisabled ? 'Сначала удалите дочерние' : 'Удалить требование'}
            disabled={deleteDisabled}
            onClick={() => !deleteDisabled && onDelete(req)}
          >
            <IconTrash />
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
  onAdd,
  onEdit,
  onLink,
  onAddNfr,
  onAddChild,
  onInlineAddChild,
  onDelete,
  onDescExpand,
  onExpandNode,
  onToggleNode,
  interactiveChevron,
}: TreeTableProps): React.ReactElement {
  // T-507: compute tree line guides for all visible rows in one pass.
  const guides = buildLineGuides(rows);

  // T-510: slug of the parent row that triggered the inline add-child form (null = hidden).
  const [addingChildAfter, setAddingChildAfter] = useState<string | null>(null);

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
                <th className="w-[140px] px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <Fragment key={row.requirement.slug}>
                  <Row
                    row={row}
                    lineGuides={guides[i]}
                    nameBySlug={nameBySlug}
                    onEdit={onEdit}
                    onLink={onLink}
                    onAddNfr={onAddNfr}
                    onAddChild={
                      onInlineAddChild
                        ? (req) => setAddingChildAfter(req.slug)
                        : onAddChild
                    }
                    onDelete={onDelete}
                    onDescExpand={onDescExpand}
                    onExpandNode={onExpandNode}
                    onToggleNode={onToggleNode}
                    interactiveChevron={interactiveChevron}
                  />
                  {addingChildAfter === row.requirement.slug ? (
                    <InlineAddChildForm
                      parentSlug={row.requirement.slug}
                      depth={row.depth + 1}
                      onSave={async (name) => {
                        await onInlineAddChild!(row.requirement.slug, name);
                        setAddingChildAfter(null);
                      }}
                      onCancel={() => setAddingChildAfter(null)}
                    />
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
