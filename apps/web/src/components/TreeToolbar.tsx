import { useEffect, useRef, useState } from 'react';
import { CRITICALITIES, type Criticality } from '@po/core';
import { useUiStore, type ImplStatus } from '../store/ui';
import { CRITICALITY_COLOR_VAR, CRITICALITY_LABEL } from '../lib/criticality';

interface TreeToolbarProps {
  shown: number;
  total: number;
}

const CRIT_TESTID: Record<Criticality, string> = {
  LOW: 'crit-opt-low',
  MEDIUM: 'crit-opt-medium',
  HIGH: 'crit-opt-high',
  CRITICAL: 'crit-opt-critical',
  BLOCKER: 'crit-opt-blocker',
};

/** Implementation-status filter options (T1, mirrors the "Реализация" badges). */
const IMPL_OPTIONS: {
  value: ImplStatus;
  testid: string;
  label: string;
  bg: string;
  fg: string;
}[] = [
  {
    value: 'DONE',
    testid: 'impl-opt-done',
    label: 'Реализовано',
    bg: 'var(--color-success-bg)',
    fg: 'var(--color-success)',
  },
  {
    value: 'PLANNED',
    testid: 'impl-opt-planned',
    label: 'Не реализовано',
    bg: 'var(--color-warning-bg)',
    fg: 'var(--color-warning-fg)',
  },
];

/**
 * Sticky toolbar driving the single visibility layer (A6#4): tree-mode toggle
 * (B1), name search (B3) and the multi-select criticality filter (B5).
 * Also contains the view-mode switcher (Дерево | Граф) for T-G108.
 */
export function TreeToolbar({ shown, total }: TreeToolbarProps): React.ReactElement {
  const treeMode = useUiStore((s) => s.treeMode);
  const setTreeMode = useUiStore((s) => s.setTreeMode);
  const search = useUiStore((s) => s.search);
  const setSearch = useUiStore((s) => s.setSearch);
  const applied = useUiStore((s) => s.criticalityFilter);
  const setCriticalityFilter = useUiStore((s) => s.setCriticalityFilter);
  const implApplied = useUiStore((s) => s.implementationFilter);
  const setImplementationFilter = useUiStore((s) => s.setImplementationFilter);
  const graphView = useUiStore((s) => s.graphView);
  const setGraphView = useUiStore((s) => s.setGraphView);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<Criticality>>(new Set(applied));
  const wrapRef = useRef<HTMLDivElement>(null);

  const [implOpen, setImplOpen] = useState(false);
  const [implDraft, setImplDraft] = useState<Set<ImplStatus>>(new Set(implApplied));
  const implWrapRef = useRef<HTMLDivElement>(null);

  // Sync the draft with the applied set whenever the dropdown opens.
  useEffect(() => {
    if (open) setDraft(new Set(applied));
  }, [open, applied]);

  useEffect(() => {
    if (implOpen) setImplDraft(new Set(implApplied));
  }, [implOpen, implApplied]);

  // Close the dropdown on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!implOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (implWrapRef.current && !implWrapRef.current.contains(e.target as Node))
        setImplOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setImplOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [implOpen]);

  const toggleDraft = (crit: Criticality): void =>
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(crit)) next.delete(crit);
      else next.add(crit);
      return next;
    });

  const toggleImplDraft = (status: ImplStatus): void =>
    setImplDraft((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });

  const segBtn = (active: boolean): string =>
    `seg-btn text-[13px] font-semibold rounded-[5px] px-3 py-1.5 inline-flex items-center gap-1.5 ${
      active ? 'shadow-sm' : ''
    }`;

  return (
    <div
      className="surface sticky top-[57px] z-10 flex flex-wrap items-center gap-3 border-b px-4 py-2.5"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      data-testid="tree-toolbar"
    >
      {/* T-G108 · view mode switcher: Дерево | Граф */}
      <div
        className="inline-flex rounded-sm border p-0.5"
        role="group"
        aria-label="Вид"
        style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)' }}
      >
        <button
          type="button"
          className={segBtn(!graphView)}
          style={
            !graphView
              ? { background: 'var(--color-surface)', color: 'var(--color-text)' }
              : { color: 'var(--color-text-2)' }
          }
          aria-pressed={!graphView}
          data-testid="toggle-tree"
          onClick={() => setGraphView(false)}
        >
          <svg
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="inline-block"
          >
            <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
          </svg>
          Дерево
        </button>
        <button
          type="button"
          className={segBtn(graphView)}
          style={
            graphView
              ? { background: 'var(--color-surface)', color: 'var(--color-text)' }
              : { color: 'var(--color-text-2)' }
          }
          aria-pressed={graphView}
          data-testid="toggle-graph"
          onClick={() => setGraphView(true)}
        >
          <svg
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="inline-block"
          >
            <circle cx="5" cy="12" r="2" />
            <circle cx="19" cy="5" r="2" />
            <circle cx="19" cy="19" r="2" />
            <line x1="7" y1="11" x2="17" y2="6" />
            <line x1="7" y1="13" x2="17" y2="18" />
          </svg>
          Граф
        </button>
      </div>

      {/* B1 · tree display mode — only shown in tree view */}
      {!graphView ? (
      <div
        className="inline-flex rounded-sm border p-0.5"
        role="group"
        aria-label="Отображение дерева"
        style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)' }}
      >
        <button
          type="button"
          className={segBtn(treeMode === 'expand-all')}
          style={
            treeMode === 'expand-all'
              ? { background: 'var(--color-surface)', color: 'var(--color-text)' }
              : { color: 'var(--color-text-2)' }
          }
          aria-pressed={treeMode === 'expand-all'}
          data-testid="toggle-expand-all"
          onClick={() => setTreeMode('expand-all')}
        >
          Раскрыть все
        </button>
        <button
          type="button"
          className={segBtn(treeMode === 'collapse')}
          style={
            treeMode === 'collapse'
              ? { background: 'var(--color-surface)', color: 'var(--color-text)' }
              : { color: 'var(--color-text-2)' }
          }
          aria-pressed={treeMode === 'collapse'}
          data-testid="toggle-collapse"
          onClick={() => setTreeMode(treeMode === 'collapse' ? 'expand-all' : 'collapse')}
        >
          Свернуть вложенные
        </button>
      </div>
      ) : null}

      {/* B3 · name search */}
      <div className="relative w-full max-w-xs">
        <input
          className="input"
          style={{ paddingRight: '30px' }}
          placeholder="Поиск по названию…"
          aria-label="Поиск по названию"
          data-testid="search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search.length > 0 ? (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--color-text-3)' }}
            aria-label="Очистить поиск"
            data-testid="search-clear"
            onClick={() => setSearch('')}
          >
            ✕
          </button>
        ) : null}
      </div>

      {/* B5 · criticality multi-select */}
      <div className="relative" ref={wrapRef}>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          style={applied.size > 0 ? { borderColor: 'var(--color-primary)' } : undefined}
          aria-haspopup="true"
          aria-expanded={open}
          data-testid="criticality-filter"
          onClick={() => setOpen((v) => !v)}
        >
          Критичность
          {applied.size > 0 ? (
            <span
              className="inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold text-white"
              style={{ background: 'var(--color-primary)' }}
              data-testid="criticality-count"
            >
              {applied.size}
            </span>
          ) : null}
        </button>

        {open ? (
          <div
            className="absolute left-0 z-20 mt-1.5 w-64 overflow-hidden rounded-lg border shadow-lg"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
            data-testid="criticality-dropdown"
          >
            <div
              className="border-b px-3 py-2 text-xs"
              style={{ color: 'var(--color-text-3)', borderColor: 'var(--color-border)' }}
            >
              Показывать критичность
            </div>
            {CRITICALITIES.map((crit) => {
              const checked = draft.has(crit);
              return (
                <label
                  key={crit}
                  className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm"
                  data-testid={CRIT_TESTID[crit]}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={checked}
                    onChange={() => toggleDraft(crit)}
                  />
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: CRITICALITY_COLOR_VAR[crit] }}
                      aria-hidden="true"
                    />
                    {CRITICALITY_LABEL[crit]}
                  </span>
                </label>
              );
            })}
            <div
              className="flex items-center justify-between border-t px-3 py-2"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <button
                type="button"
                className="btn btn-ghost py-1 text-xs"
                data-testid="crit-reset"
                onClick={() => {
                  setDraft(new Set());
                  setCriticalityFilter([]);
                  setOpen(false);
                }}
              >
                Сбросить
              </button>
              <button
                type="button"
                className="btn btn-primary py-1 text-xs"
                data-testid="crit-apply"
                onClick={() => {
                  setCriticalityFilter(draft);
                  setOpen(false);
                }}
              >
                Применить
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* T1 · implementation-status multi-select */}
      <div className="relative" ref={implWrapRef}>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          style={implApplied.size > 0 ? { borderColor: 'var(--color-primary)' } : undefined}
          aria-haspopup="true"
          aria-expanded={implOpen}
          data-testid="impl-filter"
          onClick={() => setImplOpen((v) => !v)}
        >
          Реализация
          {implApplied.size > 0 ? (
            <span
              className="inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold text-white"
              style={{ background: 'var(--color-primary)' }}
              data-testid="impl-count"
            >
              {implApplied.size}
            </span>
          ) : null}
        </button>

        {implOpen ? (
          <div
            className="absolute left-0 z-20 mt-1.5 w-72 overflow-hidden rounded-lg border shadow-lg"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
            data-testid="impl-dropdown"
          >
            <div
              className="border-b px-3 py-2 text-xs"
              style={{ color: 'var(--color-text-3)', borderColor: 'var(--color-border)' }}
            >
              Показывать по статусу реализации
            </div>
            {IMPL_OPTIONS.map((opt) => {
              const checked = implDraft.has(opt.value);
              return (
                <label
                  key={opt.value}
                  className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm"
                  data-testid={opt.testid}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={checked}
                    onChange={() => toggleImplDraft(opt.value)}
                  />
                  <span className="badge" style={{ background: opt.bg, color: opt.fg }}>
                    {opt.label}
                  </span>
                </label>
              );
            })}
            <div
              className="flex items-center justify-between border-t px-3 py-2"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <button
                type="button"
                className="btn btn-ghost py-1 text-xs"
                data-testid="impl-reset"
                onClick={() => {
                  setImplDraft(new Set());
                  setImplementationFilter([]);
                  setImplOpen(false);
                }}
              >
                Сбросить
              </button>
              <button
                type="button"
                className="btn btn-primary py-1 text-xs"
                data-testid="impl-apply"
                onClick={() => {
                  setImplementationFilter(implDraft);
                  setImplOpen(false);
                }}
              >
                Применить
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex-1" />
      <span className="text-xs" style={{ color: 'var(--color-text-3)' }} data-testid="shown-count">
        Показано {shown} из {total}
      </span>
    </div>
  );
}
