import { ChevronDown, ChevronRight, GitBranchPlus, Link2, ShieldPlus, Trash2 } from 'lucide-react';
import type { LinkType, Requirement } from '@po/core';
import type { VisibleRow } from '../lib/visibility';
import { buildLineGuides, type LineGuide } from '../lib/treeLines';
import { nestedLabel } from '../lib/plural';
import { LINK_TYPE_LABEL, describeLink } from '../lib/linkTypes';
import { CriticalityBadge, ImplementationBadge } from './badges';

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
  /** T-509: add a child functional requirement (FUNCTION rows only); opens the create modal. */
  onAddChild?: (req: Requirement) => void;
  onDelete: (req: Requirement) => void;
  onDescExpand: (req: Requirement) => void;
  /** T3 (§2.5.4): empty description renders «+ Описание» that jumps straight to editing. */
  onAddDesc?: (req: Requirement) => void;
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
  onAddDesc,
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
  onAddDesc?: (r: Requirement) => void;
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
  // UX-2: deletion of a node with children is allowed as a reinforced cascade
  // (Main opens the confirm dialog); the row button only signals the intent.
  const cascadeDelete = row.hasChildren;

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
          {/* T-507: CSS tree line guides — wrapped in a zero-gap div so vertical lines connect */}
          {lineGuides.length > 0 && (
            <div
              aria-hidden="true"
              style={{ display: 'flex', alignSelf: 'stretch', flexShrink: 0 }}
            >
              {lineGuides.map((guide, k) => (
                <span
                  key={k}
                  className={`tree-guide tree-guide--${guide}`}
                  style={{
                    flexShrink: 0,
                    width: '20px',
                    position: 'relative',
                    alignSelf: 'stretch',
                  }}
                />
              ))}
            </div>
          )}
          {/* Chevron indicator — only for nodes with children */}
          {row.hasChildren ? (
            interactiveChevron ? (
              <button
                type="button"
                className="shrink-0 rounded p-0.5 hover:text-[var(--color-primary)]"
                style={{ color: 'var(--color-text-3)' }}
                data-testid="toggle-node"
                data-slug={req.slug}
                aria-expanded={!collapsedBranch}
                aria-label={collapsedBranch ? `Раскрыть «${req.name}»` : `Свернуть «${req.name}»`}
                onClick={() => onToggleNode?.(req.slug)}
              >
                {collapsedBranch ? (
                  <ChevronRight className="icon-sm" aria-hidden="true" />
                ) : (
                  <ChevronDown className="icon-sm" aria-hidden="true" />
                )}
              </button>
            ) : (
              <span
                className="shrink-0"
                style={{ color: 'var(--color-text-3)' }}
                aria-hidden="true"
              >
                {collapsedBranch ? (
                  <ChevronRight className="icon-sm" aria-hidden="true" />
                ) : (
                  <ChevronDown className="icon-sm" aria-hidden="true" />
                )}
              </span>
            )
          ) : null}
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
              className="text-[11px] font-semibold uppercase tracking-wide"
              style={{ color: 'var(--color-text-3)' }}
              data-testid={`ancestor-label-${req.slug}`}
            >
              предок
            </span>
          ) : null}
          {collapsedBranch ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
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
      <td className="w-[130px] py-2.5 pr-3 align-middle" data-testid="req-source-cell">
        {req.source ? (
          <span>{req.source}</span>
        ) : (
          <span style={{ color: 'var(--color-text-3)' }}>—</span>
        )}
      </td>
      <td className="py-2.5 pr-3 align-top" data-testid="req-links-cell">
        {relLinks.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {relLinks.map((l) => {
              const targetName = nameBySlug.get(l.targetSlug) ?? l.targetSlug;
              return (
                <span
                  key={`${l.type}-${l.targetSlug}`}
                  className="inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium"
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
      <td className="py-2.5 pr-3 align-middle text-[13px]">
        {req.description && req.description.length > 0 ? (
          <button
            type="button"
            className="block max-w-full truncate text-left underline decoration-dotted underline-offset-4 hover:text-[var(--color-primary)]"
            style={{ color: 'var(--color-text-2)' }}
            data-testid="desc-expand"
            data-slug={req.slug}
            onClick={() => onDescExpand(req)}
            title="Открыть описание"
            aria-label="Открыть описание"
          >
            {req.description}
          </button>
        ) : onAddDesc ? (
          // §2.5.4: пустое описание — явная кнопка «+ Описание», а не кликабельный «—»
          <button
            type="button"
            className="chip"
            style={{ color: 'var(--color-primary)' }}
            data-testid="desc-add"
            data-slug={req.slug}
            onClick={() => onAddDesc(req)}
          >
            + Описание
          </button>
        ) : (
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
            <span className="block min-w-0 flex-1 truncate">—</span>
          </button>
        )}
      </td>
      {/* §2.5.1: row-actions видимы всегда (приглушены), ярче по hover/focus-within */}
      <td className="w-[140px] py-2.5 pr-4 align-middle text-right">
        <div
          className="row-actions inline-flex flex-nowrap justify-end gap-0.5 whitespace-nowrap"
          data-testid={`row-actions-${req.slug}`}
        >
          {/* ФТ-only: добавить дочернее требование (git-branch-plus) */}
          {canAddChild ? (
            <button
              type="button"
              className="row-icon-btn"
              data-testid="row-add-child"
              data-slug={req.slug}
              title="Добавить дочернее требование"
              aria-label="Добавить дочернее требование"
              onClick={() => onAddChild?.(req)}
            >
              <GitBranchPlus className="icon-sm" aria-hidden="true" />
            </button>
          ) : null}
          {/* ФТ-only: добавить связанное НФТ (shield-plus) */}
          {canAddNfr ? (
            <button
              type="button"
              className="row-icon-btn"
              data-testid="row-add-nfr"
              data-slug={req.slug}
              title="Добавить НФТ"
              aria-label="Добавить НФТ"
              onClick={() => onAddNfr?.(req)}
            >
              <ShieldPlus className="icon-sm" aria-hidden="true" />
            </button>
          ) : null}
          {/* Связать — все строки */}
          <button
            type="button"
            className="row-icon-btn hover:text-[var(--color-primary)]"
            data-testid={`link-btn-${req.slug}`}
            title="Связать"
            aria-label="Связать"
            onClick={() => onLink(req)}
          >
            <Link2 className="icon-sm" aria-hidden="true" />
          </button>
          {/* Удалить — все строки; узел с детьми удаляется каскадом (UX-2) */}
          <button
            type="button"
            className="row-icon-btn hover:text-[var(--color-danger)]"
            data-testid={`delete-btn-${req.slug}`}
            title={cascadeDelete ? 'Удалить требование со вложенными' : 'Удалить'}
            aria-label={cascadeDelete ? 'Удалить требование со вложенными' : 'Удалить требование'}
            onClick={() => onDelete(req)}
          >
            <Trash2 className="icon-sm" aria-hidden="true" />
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
  onDelete,
  onDescExpand,
  onAddDesc,
  onExpandNode,
  onToggleNode,
  interactiveChevron,
}: TreeTableProps): React.ReactElement {
  // T-507: compute tree line guides for all visible rows in one pass.
  const guides = buildLineGuides(rows);

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
          {/* Правка PO: шрифт таблицы дерева чуть мельче макета — 13px в ячейках. */}
          <table className="w-full table-fixed text-[13px]" data-testid={`table-${testidPrefix}`}>
            <thead>
              <tr
                className="text-left text-xs uppercase tracking-wide"
                style={{ color: 'var(--color-text-3)' }}
              >
                {/* A2: «Требование» is the priority (flexible) column — long names
                    truncate with an ellipsis and expose the full text via title. */}
                <th className="w-[34%] px-4 py-2 font-semibold">Требование</th>
                <th className="w-[130px] px-4 py-2 font-semibold">Критичность</th>
                <th className="w-[140px] px-4 py-2 font-semibold">Реализация</th>
                <th className="w-[130px] px-4 py-2 font-semibold">Источник</th>
                <th className="w-[15%] px-4 py-2 font-semibold">Связи</th>
                <th className="px-4 py-2 font-semibold">Описание</th>
                <th className="w-[140px] px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <Row
                  key={row.requirement.slug}
                  row={row}
                  lineGuides={guides[i]}
                  nameBySlug={nameBySlug}
                  onEdit={onEdit}
                  onLink={onLink}
                  onAddNfr={onAddNfr}
                  onAddChild={onAddChild}
                  onDelete={onDelete}
                  onDescExpand={onDescExpand}
                  onAddDesc={onAddDesc}
                  onExpandNode={onExpandNode}
                  onToggleNode={onToggleNode}
                  interactiveChevron={interactiveChevron}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
