import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ListTree, Pencil, Trash2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { LinkType, Requirement } from '@po/core';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { childCountOf } from '../lib/tree';
import { plural } from '../lib/plural';
import { CriticalityBadge, ImplementationBadge } from './badges';

interface DescPanelProps {
  requirement: Requirement;
  /** Ancestor names (root → parent) for the breadcrumb. */
  path: string[];
  /** slug → name map so link chips can show target names (desc-panel mockup). */
  nameBySlug?: Map<string, string>;
  onClose: () => void;
  onEdit: (req: Requirement) => void;
  onDelete: (req: Requirement) => void;
}

/** Short lowercase link-type words for the chips («зависит · Имя цели»).
 *  Средний род «требование»: «оно связано / блокируется / зависит». */
const CHIP_TYPE_LABEL: Record<Exclude<LinkType, 'PARENT_OF'>, string> = {
  CHILD_OF: 'родитель',
  RELATES_TO: 'связано',
  DEPENDS_ON: 'зависит',
  BLOCKED_BY: 'блокируется',
};

/** Max individual chips shown before the «+N» expander (desc-panel mockup). */
const MAX_CHIPS = 3;

/**
 * Right-hand drawer showing a requirement's full description (FR-7.4 / S30),
 * redesigned per new_design/screens/desc-panel.html (§2.7):
 * — line-clamp-2 title with expand-on-click and the full name in `title`;
 * — type / criticality / implementation badges + ancestor breadcrumb;
 * — link chips (Russian type + target name), «+N» expander;
 * — description rendered as safe Markdown (no raw HTML);
 * — footer: primary «Редактировать», danger «Удалить» disabled with a visible
 *   reason while the requirement still has children.
 * Keyboard accessible: Esc closes, focus is trapped inside.
 */
export function DescPanel({
  requirement,
  path,
  nameBySlug,
  onClose,
  onEdit,
  onDelete,
}: DescPanelProps): React.ReactElement {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [titleExpanded, setTitleExpanded] = useState(false);
  const [allChips, setAllChips] = useState(false);
  // UX-5: trap focus in the drawer, defaulting to the close button.
  useFocusTrap(panelRef, { initialFocus: closeRef });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const childCount = childCountOf(requirement);

  // Link chips: «N вложенных» aggregate + one chip per non-PARENT_OF link.
  const chips = useMemo(() => {
    const list: { key: string; label: string }[] = [];
    if (childCount > 0) {
      list.push({
        key: 'children',
        label: `${childCount} ${plural(childCount, 'вложенное', 'вложенных', 'вложенных')}`,
      });
    }
    for (const link of requirement.links) {
      if (link.type === 'PARENT_OF') continue;
      const targetName = nameBySlug?.get(link.targetSlug) ?? link.targetSlug;
      list.push({
        key: `${link.type}:${link.targetSlug}`,
        label: `${CHIP_TYPE_LABEL[link.type]} · ${targetName}`,
      });
    }
    return list;
  }, [requirement.links, childCount, nameBySlug]);

  const visibleChips = allChips ? chips : chips.slice(0, MAX_CHIPS);
  const hiddenChipCount = chips.length - visibleChips.length;

  // UX-2: a node with children is deletable via a reinforced cascade (the
  // confirm dialog handles it); the panel button only opens that dialog.
  const cascadeDelete = childCount > 0;
  const deleteHint = cascadeDelete
    ? `Удалит требование и всё вложенное (${childCount} ${plural(childCount, 'вложенное', 'вложенных', 'вложенных')}) — потребуется подтверждение.`
    : undefined;

  const description = requirement.description?.trim() ?? '';

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(15,23,42,.35)' }}
        data-testid="desc-panel-scrim"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        className="fixed inset-y-0 right-0 z-50 flex w-[420px] max-w-[92vw] flex-col border-l shadow-lg"
        style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
        role="dialog"
        aria-modal="true"
        aria-label="Описание требования"
        data-testid="desc-panel"
      >
        <header className="border-b px-5 py-4" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-start gap-3">
            {/* Заголовок: line-clamp-2 + полное имя в title, клик разворачивает (§2.7) */}
            <h2 className="min-w-0 flex-1 text-base font-semibold leading-snug">
              <button
                type="button"
                className={`w-full text-left ${titleExpanded ? '' : 'line-clamp-2'}`}
                title={requirement.name}
                aria-expanded={titleExpanded}
                data-testid="desc-panel-title"
                onClick={() => setTitleExpanded((v) => !v)}
              >
                {requirement.name}
              </button>
            </h2>
            <button
              ref={closeRef}
              type="button"
              className="btn btn-ghost shrink-0 px-2 py-1.5"
              aria-label="Закрыть панель (Esc)"
              data-testid="desc-panel-close"
              onClick={onClose}
            >
              <X className="icon" aria-hidden="true" />
            </button>
          </div>

          {/* Breadcrumb предков (§2.7) */}
          {path.length > 0 ? (
            <nav
              className="mt-2 flex min-w-0 items-center gap-1 text-xs"
              style={{ color: 'var(--color-text-3)' }}
              aria-label="Путь в иерархии"
              data-testid="desc-panel-path"
            >
              <ListTree width={13} height={13} className="flex-none" aria-hidden="true" />
              {path.map((name, i) => (
                <Fragment key={`${name}-${i}`}>
                  <span className="truncate">{name}</span>
                  <span aria-hidden="true">/</span>
                </Fragment>
              ))}
              <span className="truncate font-medium" style={{ color: 'var(--color-text-2)' }}>
                {requirement.name}
              </span>
            </nav>
          ) : null}

          {/* Бейджи типа / критичности / статуса (§2.7) */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span
              className="badge"
              style={
                requirement.type === 'FUNCTION'
                  ? { background: 'var(--color-primary-soft)', color: 'var(--color-primary)' }
                  : { background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }
              }
              data-testid="desc-panel-type"
            >
              {requirement.type === 'FUNCTION' ? 'Функциональное' : 'Нефункциональное'}
            </span>
            <CriticalityBadge criticality={requirement.criticality} />
            <ImplementationBadge req={requirement} />
          </div>

          {/* Чипы связей (§2.7): максимум 3 + «+N» */}
          {chips.length > 0 ? (
            <div
              className="mt-2 flex flex-wrap items-center gap-1.5"
              data-testid="desc-panel-links"
            >
              {visibleChips.map((chip) => (
                <span
                  key={chip.key}
                  className="chip max-w-full"
                  title={chip.label}
                  data-testid="desc-panel-link-chip"
                >
                  <span className="truncate">{chip.label}</span>
                </span>
              ))}
              {hiddenChipCount > 0 ? (
                <button
                  type="button"
                  className="chip"
                  style={{ color: 'var(--color-primary)' }}
                  aria-label={`Ещё ${hiddenChipCount} ${plural(hiddenChipCount, 'связь', 'связи', 'связей')}`}
                  data-testid="desc-panel-links-more"
                  onClick={() => setAllChips(true)}
                >
                  +{hiddenChipCount}
                </button>
              ) : null}
            </div>
          ) : null}
        </header>

        {/* Тело: описание, отрендеренное как Markdown без сырого HTML (§2.7, паттерн №7) */}
        <div className="md flex-1 overflow-y-auto px-5 py-4" data-testid="desc-panel-body">
          {description.length > 0 ? (
            <ReactMarkdown>{description}</ReactMarkdown>
          ) : (
            <span className="text-sm" style={{ color: 'var(--color-text-3)' }}>
              Описание не заполнено.
            </span>
          )}
        </div>

        {/* Футер: Редактировать + Удалить с видимой причиной disabled (§2.7) */}
        <footer className="border-t px-5 py-4" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="btn btn-danger text-sm"
              title={deleteHint}
              aria-describedby={cascadeDelete ? 'desc-panel-delete-reason' : undefined}
              data-testid="desc-panel-delete"
              onClick={() => onDelete(requirement)}
            >
              <Trash2 className="icon-sm" aria-hidden="true" />
              Удалить
            </button>
            <button
              type="button"
              className="btn btn-primary text-sm"
              data-testid="desc-panel-edit"
              onClick={() => onEdit(requirement)}
            >
              <Pencil className="icon-sm" aria-hidden="true" />
              Редактировать
            </button>
          </div>
          {deleteHint ? (
            <p
              className="hint mt-2 text-right"
              id="desc-panel-delete-reason"
              data-testid="desc-panel-delete-reason"
            >
              {deleteHint}
            </p>
          ) : null}
        </footer>
      </aside>
    </>
  );
}
