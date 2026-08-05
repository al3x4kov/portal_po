import { useEffect, useRef, useState } from 'react';
import { FoldVertical, GripVertical, Search, Sparkles, UnfoldVertical, X } from 'lucide-react';
import { CRITICALITIES, type Criticality } from '@po/core';
import { useUiStore, type ImplStatus } from '../store/ui';
import { CRITICALITY_COLOR_VAR, CRITICALITY_LABEL } from '../lib/criticality';

interface TreeToolbarProps {
  shown: number;
  total: number;
  /** FR-19: unique source values present in the current project requirements. */
  availableSources?: string[];
  /**
   * task26: project-wide number of AI-created requirements nobody confirmed yet
   * (counted with `countAiPendingReview`, over BOTH ФТ and НФТ, independent of
   * the active filters). Drives the «Не проверено: N» counter.
   */
  aiPendingCount?: number;
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
export function TreeToolbar({
  shown,
  total,
  availableSources = [],
  aiPendingCount = 0,
}: TreeToolbarProps): React.ReactElement {
  const treeMode = useUiStore((s) => s.treeMode);
  const setTreeMode = useUiStore((s) => s.setTreeMode);
  const search = useUiStore((s) => s.search);
  const setSearch = useUiStore((s) => s.setSearch);
  const applied = useUiStore((s) => s.criticalityFilter);
  const setCriticalityFilter = useUiStore((s) => s.setCriticalityFilter);
  const implApplied = useUiStore((s) => s.implementationFilter);
  const setImplementationFilter = useUiStore((s) => s.setImplementationFilter);
  const srcApplied = useUiStore((s) => s.sourceFilter);
  const setSourceFilter = useUiStore((s) => s.setSourceFilter);
  const aiPendingApplied = useUiStore((s) => s.aiPendingFilter);
  const setAiPendingFilter = useUiStore((s) => s.setAiPendingFilter);
  const toggleAiPendingFilter = useUiStore((s) => s.toggleAiPendingFilter);
  const graphView = useUiStore((s) => s.graphView);
  const setGraphView = useUiStore((s) => s.setGraphView);
  const resetFilters = useUiStore((s) => s.resetFilters);
  const structureMode = useUiStore((s) => s.structureMode);
  const setStructureMode = useUiStore((s) => s.setStructureMode);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<Criticality>>(new Set(applied));
  const wrapRef = useRef<HTMLDivElement>(null);

  const [implOpen, setImplOpen] = useState(false);
  const [implDraft, setImplDraft] = useState<Set<ImplStatus>>(new Set(implApplied));
  const implWrapRef = useRef<HTMLDivElement>(null);

  const [srcOpen, setSrcOpen] = useState(false);
  const [srcDraft, setSrcDraft] = useState<Set<string>>(new Set(srcApplied));
  const srcWrapRef = useRef<HTMLDivElement>(null);
  // UX-7: substring filter inside the «Источник» dropdown (shown for long lists).
  const [srcQuery, setSrcQuery] = useState('');

  // Source dropdown options: '' = "Не задан" + sorted unique sources from project
  const sourceOptions = ['', ...availableSources];
  // UX-7: only bother with an in-dropdown search once the list gets long.
  const srcSearchable = availableSources.length > 10;
  const srcFilteredOptions = srcSearchable
    ? sourceOptions.filter((src) => {
        const label = src === '' ? 'Не задан' : src;
        return label.toLowerCase().includes(srcQuery.trim().toLowerCase());
      })
    : sourceOptions;

  // §2.6: единая строка «Показано X из Y · Сбросить фильтры» активна при любом фильтре.
  const filtersActive =
    applied.size > 0 || implApplied.size > 0 || srcApplied.size > 0 || aiPendingApplied;
  // UX-6: общий счётчик активных фильтров для сгруппированного блока.
  const activeFilterCount =
    applied.size + implApplied.size + srcApplied.size + (aiPendingApplied ? 1 : 0);
  // task26: счётчик «Не проверено» видим, когда есть что проверять, либо пока
  // включён фильтр (чтобы было видно, как N обнуляется, и можно было выключить).
  const showAiPendingCount = aiPendingCount > 0 || aiPendingApplied;
  // Дерево на экране неполное: часть строк скрыта поиском или фильтрами.
  // «Выше/ниже» тогда означало бы не то, что видит пользователь, поэтому режим
  // структуры целиком недоступен (макет П8) — единственное такое состояние.
  const treeIncomplete = filtersActive || search.trim().length > 0;

  // Фильтр или поиск, включённые поверх режима структуры, гасят его сами:
  // иначе на экране остались бы ручки у неполного дерева.
  useEffect(() => {
    if (treeIncomplete && structureMode) setStructureMode(false);
  }, [treeIncomplete, structureMode, setStructureMode]);

  // Sync the draft with the applied set whenever the dropdown opens.
  useEffect(() => {
    if (open) setDraft(new Set(applied));
  }, [open, applied]);

  useEffect(() => {
    if (implOpen) setImplDraft(new Set(implApplied));
  }, [implOpen, implApplied]);

  useEffect(() => {
    if (srcOpen) {
      setSrcDraft(new Set(srcApplied));
      setSrcQuery('');
    }
  }, [srcOpen, srcApplied]);

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

  useEffect(() => {
    if (!srcOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (srcWrapRef.current && !srcWrapRef.current.contains(e.target as Node)) setSrcOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSrcOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [srcOpen]);

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

  const toggleSrcDraft = (src: string): void =>
    setSrcDraft((prev) => {
      const next = new Set(prev);
      if (next.has(src)) next.delete(src);
      else next.add(src);
      return next;
    });

  const segBtn = (active: boolean): string =>
    `seg-btn text-[13px] font-semibold rounded-[5px] px-3 py-1.5 inline-flex items-center gap-1.5 ${
      active ? 'shadow-sm' : ''
    }`;

  return (
    <div
      className="sticky z-10 flex flex-wrap items-center gap-3 border-b px-4 py-2.5"
      style={{
        top: 'var(--header-height)',
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
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

      {/* B3 · name search */}
      <div className="relative min-w-[180px] flex-1">
        <Search
          className="icon-sm t3 pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
          aria-hidden="true"
        />
        <input
          className="input !pl-9"
          style={{ paddingRight: '30px' }}
          type="search"
          placeholder="Поиск по имени…"
          aria-label="Поиск по имени требования"
          data-testid="search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search.length > 0 ? (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-[var(--color-surface-2)]"
            style={{ color: 'var(--color-text-3)' }}
            aria-label="Очистить поиск"
            data-testid="search-clear"
            onClick={() => setSearch('')}
          >
            <X className="icon-sm" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* UX-6 · единый блок фильтров (Критичность | Реализация | Источник) */}
      <div
        // DEF-26-1: группа обязана ужиматься/переноситься — при `flex-none` её
        // max-content ширина вылезала за 768px и давала горизонтальный скролл.
        className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-2 rounded-lg border px-2 py-1"
        role="group"
        aria-label="Фильтры"
        style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)' }}
        data-testid="filter-group"
      >
        <span
          className="pl-1 text-xs font-semibold"
          style={{ color: 'var(--color-text-3)' }}
          aria-hidden="true"
        >
          Фильтры
        </span>

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

        {/* FR-19 · source multi-select */}
        <div className="relative" ref={srcWrapRef}>
          <button
            type="button"
            className="btn btn-secondary text-sm"
            style={srcApplied.size > 0 ? { borderColor: 'var(--color-primary)' } : undefined}
            aria-haspopup="true"
            aria-expanded={srcOpen}
            data-testid="source-filter"
            onClick={() => setSrcOpen((v) => !v)}
          >
            Источник
            {srcApplied.size > 0 ? (
              <span
                className="inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold text-white"
                style={{ background: 'var(--color-primary)' }}
                data-testid="source-count"
              >
                {srcApplied.size}
              </span>
            ) : null}
          </button>

          {srcOpen ? (
            <div
              className="absolute left-0 z-20 mt-1.5 w-64 overflow-hidden rounded-lg border shadow-lg"
              style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
              data-testid="source-dropdown"
            >
              <div
                className="border-b px-3 py-2 text-xs"
                style={{ color: 'var(--color-text-3)', borderColor: 'var(--color-border)' }}
              >
                Показывать по источнику
              </div>
              {/* UX-7 · substring search for long source lists */}
              {srcSearchable ? (
                <div className="border-b p-2" style={{ borderColor: 'var(--color-border)' }}>
                  <input
                    type="search"
                    className="input !py-1.5 text-sm"
                    placeholder="Поиск источника…"
                    aria-label="Поиск по источнику"
                    data-testid="source-search"
                    value={srcQuery}
                    onChange={(e) => setSrcQuery(e.target.value)}
                  />
                </div>
              ) : null}
              <div className="max-h-60 overflow-y-auto">
                {srcFilteredOptions.map((src) => {
                  const checked = srcDraft.has(src);
                  const label = src === '' ? 'Не задан' : src;
                  return (
                    <label
                      key={src === '' ? '__empty__' : src}
                      className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm"
                      data-testid={`source-opt-${src === '' ? 'empty' : src}`}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={checked}
                        onChange={() => toggleSrcDraft(src)}
                      />
                      <span className="text-sm">{label}</span>
                    </label>
                  );
                })}
                {srcSearchable && srcFilteredOptions.length === 0 ? (
                  <p
                    className="px-3 py-3 text-sm"
                    style={{ color: 'var(--color-text-3)' }}
                    data-testid="source-search-empty"
                  >
                    Ничего не найдено
                  </p>
                ) : null}
              </div>
              {sourceOptions.length === 0 ? (
                <p className="px-3 py-3 text-sm" style={{ color: 'var(--color-text-3)' }}>
                  Нет источников
                </p>
              ) : null}
              <div
                className="flex items-center justify-between border-t px-3 py-2"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <button
                  type="button"
                  className="btn btn-ghost py-1 text-xs"
                  data-testid="source-reset"
                  onClick={() => {
                    setSrcDraft(new Set());
                    setSourceFilter([]);
                    setSrcOpen(false);
                  }}
                >
                  Сбросить
                </button>
                <button
                  type="button"
                  className="btn btn-primary py-1 text-xs"
                  data-testid="source-apply"
                  onClick={() => {
                    setSourceFilter(srcDraft);
                    setSrcOpen(false);
                  }}
                >
                  Применить
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* task26 · «Только непроверенные (ИИ)» + счётчик «Не проверено: N» */}
        {/* DEF-26-1: подпись компактная («Непроверенные»), полная формулировка —
            в title/aria-label, чтобы панель фильтров помещалась в 768px. */}
        <button
          type="button"
          className="btn btn-secondary inline-flex min-w-0 items-center gap-1.5 text-sm"
          style={
            aiPendingApplied
              ? { borderColor: 'var(--color-warning-fg)', color: 'var(--color-warning-fg)' }
              : undefined
          }
          aria-pressed={aiPendingApplied}
          aria-label="Только непроверенные (ИИ)"
          data-testid="filter-ai-pending"
          data-active={aiPendingApplied ? 'true' : 'false'}
          title="Только непроверенные (ИИ): требования, созданные ИИ и ещё не проверенные"
          onClick={toggleAiPendingFilter}
        >
          <Sparkles className="icon-sm flex-none" aria-hidden="true" />
          <span className="truncate">Непроверенные</span>
        </button>

        {showAiPendingCount ? (
          <button
            type="button"
            className="badge"
            style={{ background: 'var(--color-warning-bg)', color: 'var(--color-warning-fg)' }}
            data-testid="ai-pending-count"
            data-count={aiPendingCount}
            aria-label={`Не проверено требований, созданных ИИ: ${aiPendingCount}. Показать только их`}
            title="Показать только непроверенные требования, созданные ИИ"
            onClick={() => setAiPendingFilter(true)}
          >
            Не проверено: {aiPendingCount}
          </button>
        ) : null}

        {/* UX-6 · общий счётчик активных фильтров + «Сбросить» внутри блока */}
        {filtersActive ? (
          <div className="flex items-center gap-2 pl-1">
            <span
              className="inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold text-white"
              style={{ background: 'var(--color-primary)' }}
              data-testid="filter-active-count"
            >
              {activeFilterCount}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm text-xs"
              data-testid="filter-group-reset"
              onClick={resetFilters}
            >
              Сбросить
            </button>
          </div>
        ) : null}
      </div>

      {/* B1 · раскрыть/свернуть все уровни: две иконки-кнопки с tooltip (§2.6) */}
      {!graphView ? (
        <div className="inline-flex flex-none gap-1" role="group" aria-label="Отображение дерева">
          <button
            type="button"
            className="tip-host btn btn-secondary btn-sm !px-2"
            aria-pressed={treeMode === 'expand-all'}
            aria-label="Раскрыть все уровни"
            data-testid="toggle-expand-all"
            onClick={() => setTreeMode('expand-all')}
          >
            <UnfoldVertical className="icon-sm" aria-hidden="true" />
            <span className="tip tip-below">Раскрыть все</span>
          </button>
          <button
            type="button"
            className="tip-host btn btn-secondary btn-sm !px-2"
            aria-pressed={treeMode === 'collapse'}
            aria-label="Свернуть все уровни"
            data-testid="toggle-collapse"
            onClick={() => setTreeMode(treeMode === 'collapse' ? 'expand-all' : 'collapse')}
          >
            <FoldVertical className="icon-sm" aria-hidden="true" />
            <span className="tip tip-below">Свернуть все</span>
          </button>
        </div>
      ) : null}

      {/* Режим структуры: перемещение строк по дереву. Недоступен, когда дерево
          показано не целиком — двигать строку вслепую нельзя (макет П8). */}
      {!graphView ? (
        <button
          type="button"
          className="tip-host btn btn-secondary btn-sm inline-flex flex-none items-center gap-1.5"
          style={
            structureMode
              ? {
                  background: 'var(--color-primary)',
                  color: '#fff',
                  borderColor: 'var(--color-primary)',
                }
              : treeIncomplete
                ? { opacity: 0.5 }
                : undefined
          }
          aria-pressed={structureMode}
          aria-disabled={treeIncomplete}
          data-testid="toggle-structure-mode"
          data-disabled={treeIncomplete ? 'true' : undefined}
          onClick={() => {
            if (treeIncomplete) return;
            setStructureMode(!structureMode);
          }}
        >
          <GripVertical className="icon-sm" aria-hidden="true" />
          Режим структуры
          <span className="tip tip-below">
            {treeIncomplete
              ? 'Недоступно: дерево показано не целиком — сначала сбросьте поиск и фильтры'
              : 'Перемещение строк по дереву: перетаскиванием, стрелками или с клавиатуры'}
          </span>
        </button>
      ) : null}

      {/* §2.6 · единая строка результата фильтрации (средний род: «Показано») */}
      <span
        className="ml-auto text-xs"
        style={{ color: 'var(--color-text-3)' }}
        role="status"
        data-testid="shown-count"
      >
        Показано {shown} из {total}
        {filtersActive ? (
          <>
            {' · '}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-[var(--color-primary)]"
              data-testid="toolbar-reset-filters"
              onClick={resetFilters}
            >
              Сбросить фильтры
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}
