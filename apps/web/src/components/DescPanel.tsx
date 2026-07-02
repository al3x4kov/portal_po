import { useEffect, useRef } from 'react';
import type { Requirement } from '@po/core';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { CriticalityBadge, ImplementationBadge } from './badges';

interface DescPanelProps {
  requirement: Requirement;
  /** Ancestor names (root → parent) for the breadcrumb. */
  path: string[];
  onClose: () => void;
  onEdit: (req: Requirement) => void;
  onDelete: (req: Requirement) => void;
}

/**
 * Right-hand drawer showing a requirement's full description without truncation
 * (B4, closes FR-7.4 / S30). Keyboard accessible: Esc closes, focus moves in.
 */
export function DescPanel({
  requirement,
  path,
  onClose,
  onEdit,
  onDelete,
}: DescPanelProps): React.ReactElement {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // UX-5: trap focus in the drawer, defaulting to the close button.
  useFocusTrap(panelRef, { initialFocus: closeRef });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const typeLabel = requirement.type === 'FUNCTION' ? 'ФТ' : 'НФТ';

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
        <div
          className="flex items-start justify-between border-b px-5 py-4"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span
                className="badge"
                style={{ background: 'var(--color-info-bg)', color: 'var(--color-info)' }}
              >
                {typeLabel}
              </span>
              <CriticalityBadge criticality={requirement.criticality} />
              <ImplementationBadge req={requirement} />
            </div>
            <h3 className="truncate text-base font-bold" data-testid="desc-panel-title">
              {requirement.name}
            </h3>
            {path.length > 0 ? (
              <p
                className="truncate font-mono text-xs"
                style={{ color: 'var(--color-text-3)' }}
                data-testid="desc-panel-path"
              >
                {path.join(' / ')}
              </p>
            ) : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="btn btn-ghost shrink-0"
            aria-label="Закрыть"
            data-testid="desc-panel-close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div
          className="flex-1 overflow-y-auto whitespace-pre-wrap px-5 py-4 text-sm"
          style={{ color: 'var(--color-text-2)' }}
          data-testid="desc-panel-body"
        >
          {requirement.description && requirement.description.length > 0 ? (
            requirement.description
          ) : (
            <span style={{ color: 'var(--color-text-3)' }}>Описание не заполнено.</span>
          )}
        </div>

        <div
          className="flex justify-between gap-2 border-t px-5 py-3"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <button
            type="button"
            className="btn btn-ghost text-sm"
            style={{ color: 'var(--color-danger)' }}
            data-testid="desc-panel-delete"
            onClick={() => onDelete(requirement)}
          >
            Удалить
          </button>
          <button
            type="button"
            className="btn btn-primary text-sm"
            data-testid="desc-panel-edit"
            onClick={() => onEdit(requirement)}
          >
            Редактировать
          </button>
        </div>
      </aside>
    </>
  );
}
